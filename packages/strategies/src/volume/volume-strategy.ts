import { Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
  type VenueId,
  createLogger,
  decimalToBn,
  lognormal,
  pick,
  poissonInterval,
  randomFloat,
  secureRandom,
  sleep,
  LAMPORTS_PER_SOL,
  NATIVE_SOL_MINT,
} from '@amm/shared';
import type { RpcManager, Store, TxExecutor } from '@amm/core';
import type { VenueRegistry } from '@amm/venues';
import { JupiterVenue } from '@amm/venues';
import type { StrategyHandle } from '../strategy.js';
import {
  DEFAULT_PROFILES,
  PASSIVE_PROFILES,
  VolumeStateMachine,
  type StateProfile,
  type VolumeState,
} from './state-machine.js';

/**
 * "Behavior" preset for the volume strategy. Maps to a state-profile dict
 * and a few flags. `mode: 'organic'` is volume-manufacturing flavoured to
 * look like real flow; `'passive'` and `'scheduled'` flatten the FSM and
 * (with strictAlternate) yield net-zero price impact for LP support
 * use-cases where manipulation is undesirable.
 */
export type VolumeMode = 'organic' | 'passive' | 'scheduled';

const log = createLogger('strategy:volume');

/**
 * Extra native SOL (lamports) the fee payer must hold for CPI `CreateAssociatedToken`,
 * priority fees, etc. Pump / WSOL-quote buys pay the swap from SPL but still spend
 * lamports for new ATAs — if we only check reserve when `quoteMint` is native SOL,
 * WSOL pools skip the check and sim returns `InsufficientFundsForRent`.
 *
 * Override via `VOLUME_SWAP_RENT_HEADROOM_LAMPORTS` (lamports, integer).
 */
const SWAP_RENT_HEADROOM_LAMPORTS = (() => {
  const raw =
    typeof process.env.VOLUME_SWAP_RENT_HEADROOM_LAMPORTS === 'string'
      ? Number(process.env.VOLUME_SWAP_RENT_HEADROOM_LAMPORTS.trim())
      : NaN;
  if (Number.isFinite(raw) && raw >= 2_500_000) {
    return Math.floor(raw);
  }
  // ~0.020 SOL: Pump Sell CPI creates/touches multiple token accounts (~2M lamports each)
  // + base fee + priority fee jitter; 15M edge-cases on burst-state ladders.
  return 20_000_000;
})();

/**
 * Pump's `swapSolanaState` picks one of ~8 protocol_fee_recipients at random
 * (`globalConfig.protocolFeeRecipients[Math.floor(Math.random() * N)]`). When
 * the chosen recipient is currently sub-rent-exempt — typically because some
 * other taker just unwrapped its WSOL ATA to zero — simulation fails with
 * `InsufficientFundsForRent` on the recipient's accounts:
 *   - Buy : `account_index = 10` (protocol_fee_recipient_token_account)
 *   - Sell: `account_index = 9`  (protocol_fee_recipient)
 *
 * Rebuilding via `venue.buildSwap(...)` re-rolls the recipient, so we
 * transparently retry the swap a few times. Other simulation errors (genuine
 * wallet-rent / slippage / pool-state issues) propagate unchanged so we never
 * mask real bugs.
 */
const PUMP_FEE_RECIPIENT_BUY_IDX = 10;
const PUMP_FEE_RECIPIENT_SELL_IDX = 9;
const PUMP_FEE_REROLL_MAX_ATTEMPTS = 4;

function isPumpFeeRecipientRentError(e: unknown, side: 'buy' | 'sell'): boolean {
  const msg = (e as { message?: string })?.message ?? String(e);
  if (!/InsufficientFundsForRent/i.test(msg)) return false;
  const m = msg.match(/account_index["']?\s*:\s*(\d+)/i);
  if (!m) return false;
  const idx = Number(m[1]);
  return idx === (side === 'buy' ? PUMP_FEE_RECIPIENT_BUY_IDX : PUMP_FEE_RECIPIENT_SELL_IDX);
}

export interface VolumeStrategyConfig {
  /** The pool to generate volume on. */
  poolId: PublicKey;
  /** The venue to use for execution. 'jupiter' is recommended. */
  venue: VenueId;
  /** Base mint (the token we hold). Inferred from pool if omitted. */
  baseMint?: PublicKey;
  /** Quote mint (usually WSOL). Inferred from pool if omitted. */
  quoteMint?: PublicKey;
  /** Sub-wallet keypairs to trade from (must be funded). */
  wallets: Keypair[];
  /** Slippage in bps. */
  slippageBps?: number;
  /**
   * Log-normal trade-size parameters (in **quote** units, e.g. SOL).
   * `logMean` and `logStd` are the underlying normal distribution's params.
   * For mean ~= 0.05 SOL with reasonable spread: logMean = ln(0.05) ~= -3, logStd = 0.6.
   */
  sizeLogMean?: number;
  sizeLogStd?: number;
  /** Minimum size in quote units (clamps the lognormal lower tail). */
  minQuoteSize?: number;
  /** Maximum size in quote units (clamps the upper tail). */
  maxQuoteSize?: number;
  /** Per-state profile overrides. */
  stateProfiles?: Record<VolumeState, StateProfile>;
  /**
   * Behaviour preset. Sets the state profiles + flips the relevant flags
   * unless those are also provided explicitly (explicit values win).
   *
   * - 'organic'   - default. Markov FSM with quiet/accumulate/distribute/burst
   *                 states. Looks like real flow but is manipulative by design.
   * - 'passive'   - flat FSM, low rate, +strictAlternate, no time window.
   *                 Net-zero price impact ("presence" rather than volume).
   * - 'scheduled' - passive + activeHoursUtc gate. Sleeps outside the
   *                 configured hours. Reasonable starting point: [14, 22].
   */
  mode?: VolumeMode;
  /**
   * Force buy/sell to alternate strictly instead of sampling each from the
   * profile's `buyProb`. Combined with a flat profile this guarantees that
   * over any window of N trades, exactly N/2 are buys and N/2 are sells -
   * net-neutral price impact. Default: derived from `mode`.
   */
  strictAlternate?: boolean;
  /**
   * `[startHour, endHour]` UTC, both 0..23 inclusive. When set, the loop
   * sleeps until the next start-of-window outside this range. Wraps over
   * midnight (e.g. `[22, 6]` = 22:00..06:00 UTC).
   */
  activeHoursUtc?: [number, number];
  /**
   * Retire a wallet after this many successful trades. Once retired it's
   * skipped on subsequent picks. Helps avoid the same N wallets being
   * forever associated with the same token. 0/undefined disables.
   */
  walletTradeCap?: number;
  /**
   * Per-wallet minimum gap between trades, ms. The loop will skip a wallet
   * that just traded inside this window and pick another. Default: 0
   * (no per-wallet cooldown).
   */
  walletCooldownMs?: number;
  /**
   * If set, applies a uniform jitter of +/- this fraction to the configured
   * slippage on every trade. e.g. 0.3 with `slippageBps=200` gives a per-trade
   * range of [140, 260] bps. Defeats slippage-fingerprinting heuristics.
   */
  slippageJitter?: number;
  /**
   * Base priority fee in micro-lamports per CU. If undefined the executor
   * falls back to its own default. Combined with `priorityFeeJitter` to
   * randomise the per-trade tip.
   */
  priorityMicroLamports?: number;
  /**
   * Per-trade jitter +/- fraction applied to `priorityMicroLamports`. e.g.
   * 0.5 with base 50_000 gives a range of [25_000, 75_000]. Defeats
   * priority-fee-as-fingerprint correlators.
   */
  priorityFeeJitter?: number;
  /**
   * Per-trade jitter +/- fraction applied to `computeUnitLimit`. Real
   * wallets request whatever the simulator suggests, which varies; a fixed
   * 600_000 across every tx is a tell.
   */
  cuJitter?: number;
  /** Use Jito bundles for execution (slightly more expensive, much better inclusion). */
  useJito?: boolean;
  /** Dry-run: log the planned trades, don't send. */
  dryRun?: boolean;
  /** Compute unit limit per swap. */
  computeUnitLimit?: number;
  /**
   * Average target seconds between trades GLOBALLY (across all wallets).
   * Overrides the FSM-derived rate when set; useful for slow "support
   * presence" runs where you want minutes between trades regardless of
   * mode. The actual per-iteration sleep is sampled from a Poisson
   * distribution with this mean, capped at 4× to avoid pathological
   * long sleeps. Default: derived from FSM profile (mode-dependent).
   */
  globalIntervalSec?: number;
  /**
   * Hard minimum sleep between trades, seconds. Floor applied AFTER the
   * Poisson sample. Useful for taming the heavy tail of the exponential
   * distribution: with mean=900s ~28% of samples are < 5 min, which can
   * produce visibly bursty gaps. Setting `minIntervalSec=180` enforces
   * "no two trades closer than 3 min" while keeping the natural variance
   * above that floor. 0 = no floor.
   */
  minIntervalSec?: number;
}

const DEFAULTS = {
  slippageBps: 100,
  sizeLogMean: Math.log(0.05),
  sizeLogStd: 0.6,
  minQuoteSize: 0.005,
  maxQuoteSize: 1.0,
  mode: 'organic' as VolumeMode,
  strictAlternate: false,
  walletTradeCap: 0,
  walletCooldownMs: 0,
  slippageJitter: 0,
  priorityMicroLamports: 0,
  priorityFeeJitter: 0,
  cuJitter: 0,
  useJito: false,
  dryRun: false,
  computeUnitLimit: 600_000,
  globalIntervalSec: 0,
  minIntervalSec: 0,
};

/** Profile preset implied by `mode`. Explicit `stateProfiles` overrides this. */
function presetForMode(mode: VolumeMode): Record<VolumeState, StateProfile> {
  return mode === 'organic' ? DEFAULT_PROFILES : PASSIVE_PROFILES;
}

/** Whether the wall-clock UTC hour falls inside `[startHour, endHour]`, with wrap. */
function isWithinUtcWindow(now: Date, startHour: number, endHour: number): boolean {
  const h = now.getUTCHours();
  if (startHour === endHour) return true; // degenerate -> always on
  if (startHour < endHour) return h >= startHour && h < endHour;
  // Wrap (e.g. [22, 6] means 22..23 plus 0..5).
  return h >= startHour || h < endHour;
}

/** Milliseconds until the next wall-clock UTC hour `targetHour`. */
function msUntilNextUtcHour(now: Date, targetHour: number): number {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  if (next.getUTCHours() >= targetHour) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  next.setUTCHours(targetHour, 0, 0, 0);
  return next.getTime() - now.getTime();
}

/**
 * Organic-flow volume strategy.
 *
 * Each iteration:
 *  1. State machine picks (rate, buyProb, sizeMultiplier).
 *  2. Sample inter-arrival time from Poisson(rate).
 *  3. Pick a random sub-wallet.
 *  4. Sample trade size from log-normal * sizeMultiplier (clamped to [min,max]).
 *  5. Build & execute the swap via the chosen venue (default: Jupiter).
 *  6. Record trade, advance state machine, sleep.
 *
 * No round-robin, no fixed cadence, no fixed size. Hard to fingerprint.
 */
export class VolumeStrategy implements StrategyHandle {
  readonly id = 'volume' as const;
  private running = false;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;
  private readonly cfg: Required<Omit<VolumeStrategyConfig, 'baseMint' | 'quoteMint' | 'stateProfiles'>> & {
    baseMint?: PublicKey;
    quoteMint?: PublicKey;
    stateProfiles?: Record<VolumeState, StateProfile>;
  };
  private readonly fsm: VolumeStateMachine;
  /** Per-wallet trade counter. Used by `walletTradeCap` to retire wallets. */
  private readonly walletTradeCount = new Map<string, number>();
  /** Per-wallet last-trade-at (ms epoch). Used by `walletCooldownMs`. */
  private readonly walletLastTradedAt = new Map<string, number>();
  /**
   * Per-wallet last successful side. Used by `strictAlternate` to flip the
   * next side on a per-wallet basis. A previous version used a single global
   * counter, which would happily assign 'sell' to a fresh wallet that had no
   * tokens yet (→ Custom:1 InsufficientFunds). We track per-wallet so:
   *   - the first trade for any wallet is always a buy (no entry in map)
   *   - subsequent trades flip the wallet's own last-side
   *   - failed trades do NOT update the map, so we'll re-attempt the same
   *     intended side rather than drifting state on errors
   */
  private readonly walletLastSide = new Map<string, 'buy' | 'sell'>();

  constructor(
    public readonly runId: number,
    config: VolumeStrategyConfig,
    private readonly deps: {
      rpc: RpcManager;
      exec: TxExecutor;
      venues: VenueRegistry;
      store: Store;
    },
  ) {
    if (config.wallets.length === 0) throw new Error('volume strategy needs at least one wallet');
    const mode: VolumeMode = config.mode ?? DEFAULTS.mode;
    // Mode -> default profiles + flag bias. Anything explicitly set on
    // `config` still wins (so a user can pick `mode: 'organic'` but force
    // `strictAlternate: true`, etc.).
    const profiles = config.stateProfiles ?? presetForMode(mode);
    const strictAlternate =
      config.strictAlternate ?? (mode === 'passive' || mode === 'scheduled');
    this.cfg = {
      ...DEFAULTS,
      ...config,
      mode,
      strictAlternate,
    } as never;
    this.fsm = new VolumeStateMachine(profiles);
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    log.info(
      {
        runId: this.runId,
        venue: this.cfg.venue,
        pool: this.cfg.poolId.toBase58(),
        wallets: this.cfg.wallets.length,
        dryRun: this.cfg.dryRun,
        mode: this.cfg.mode,
        strictAlternate: this.cfg.strictAlternate,
        activeHoursUtc: this.cfg.activeHoursUtc ?? null,
        walletTradeCap: this.cfg.walletTradeCap || null,
        walletCooldownMs: this.cfg.walletCooldownMs || null,
        slippageJitter: this.cfg.slippageJitter || null,
        globalIntervalSec: this.cfg.globalIntervalSec || null,
        minIntervalSec: this.cfg.minIntervalSec || null,
      },
      'volume strategy starting',
    );
    this.loopPromise = this.loop().catch((e) => {
      log.error({ err: (e as Error).message }, 'volume loop crashed');
      this.deps.store.stopRun(this.runId, 'errored', (e as Error).message);
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.loopPromise) await this.loopPromise;
    this.running = false;
    this.deps.store.stopRun(this.runId, 'stopped');
    log.info({ runId: this.runId }, 'volume strategy stopped');
  }

  private async loop(): Promise<void> {
    // Resolve mints once.
    const venue = this.deps.venues.get(this.cfg.venue);
    let baseMint = this.cfg.baseMint;
    let quoteMint = this.cfg.quoteMint;
    if (!baseMint || !quoteMint) {
      // Try to resolve from the venue (Jupiter doesn't have pools, so we need explicit mints).
      if (this.cfg.venue !== 'jupiter') {
        const pool = await venue.getPool(this.cfg.poolId);
        baseMint = pool.baseMint;
        quoteMint = pool.quoteMint;
      } else {
        throw new Error('jupiter venue requires explicit baseMint/quoteMint in config');
      }
    }

    const baseInfo = await venue.getTokenInfo(baseMint);
    const quoteInfo = await venue.getTokenInfo(quoteMint);

    // Seed `walletLastSide` from prior trades on this pool. Without this,
    // every stop/restart wipes the in-memory map and the strict-alternate
    // FSM forces every wallet's first trade to be a buy — which fails for
    // any wallet still holding tokens with low SOL ("trade skipped: native
    // SOL below swap + rent reserve"). Querying the DB once at startup
    // recovers each wallet's last successful side and lets the FSM pick
    // the correct opposite next. Scoped to this pool so switching tokens
    // mid-vault doesn't bleed state.
    try {
      const walletPubkeys = this.cfg.wallets.map((w) => w.publicKey.toBase58());
      const seeded = this.deps.store.lastSidesByPool(
        this.cfg.poolId.toBase58(),
        walletPubkeys,
      );
      for (const [w, side] of seeded) {
        this.walletLastSide.set(w, side);
      }
      if (seeded.size > 0) {
        log.info(
          {
            runId: this.runId,
            seeded: seeded.size,
            total: walletPubkeys.length,
          },
          'walletLastSide seeded from prior trades on this pool (strict-alternate restart recovery)',
        );
      }
    } catch (e) {
      // Non-fatal: failing to seed just means the strategy behaves like a
      // fresh run, which is the previous behaviour. Don't crash the loop
      // over a DB read.
      log.warn(
        { err: (e as Error).message },
        'walletLastSide seed failed; falling back to default (forces buys first)',
      );
    }

    while (!this.stopRequested) {
      // 0. Time window gate (mode: 'scheduled'). Sleep until the next
      //    in-window hour boundary if we're currently outside the window.
      if (this.cfg.activeHoursUtc) {
        const [startHour, endHour] = this.cfg.activeHoursUtc;
        const now = new Date();
        if (!isWithinUtcWindow(now, startHour, endHour)) {
          const wakeMs = msUntilNextUtcHour(now, startHour);
          log.info(
            {
              nowUtcHour: now.getUTCHours(),
              startHour,
              endHour,
              wakeMs,
            },
            'outside active UTC window, sleeping until next start',
          );
          await sleepWithCancel(wakeMs, () => this.stopRequested);
          if (this.stopRequested) break;
          continue;
        }
      }

      const profile = this.fsm.profile();
      // Pacing rule:
      //   - if the user specified `globalIntervalSec` (the form knob), use a
      //     Poisson with mean = that. Cap at 4× the mean so we don't get a
      //     pathological 30-min wait that hangs the loop.
      //   - otherwise fall back to the FSM's profile.ratePerSec.
      // Floor the sleep at 50ms to keep the loop yielding to the event loop.
      const meanSec =
        this.cfg.globalIntervalSec > 0
          ? this.cfg.globalIntervalSec
          : 1 / Math.max(profile.ratePerSec, 1e-6);
      const intervalSec = poissonInterval(1 / meanSec);
      const capSec = meanSec * 4;
      const floorSec = this.cfg.minIntervalSec || 0;
      // Order: clamp upper, then enforce lower floor. This gives bounded
      // variance: trades are spaced [floor, cap] with mean ~= configured.
      const finalSec = Math.max(floorSec, Math.min(capSec, intervalSec));
      const sleepMs = Math.max(50, Math.round(finalSec * 1000));
      await sleepWithCancel(sleepMs, () => this.stopRequested);
      if (this.stopRequested) break;

      // 1. Pick a wallet, honouring trade cap (retired wallets) and per-wallet
      //    cooldown. If everyone's on cooldown we pick the least-recently-used
      //    one anyway (loose lower bound rather than busy-waiting).
      const wallet = this.pickWallet();
      if (!wallet) {
        log.warn('no eligible wallets remain (all retired); stopping');
        break;
      }

      // 2. Side selection: strict alternate guarantees net-zero impact
      //    PER WALLET (each wallet does its own buy→sell→buy→sell pattern,
      //    which sums to ~N/2 buys + N/2 sells globally). First trade for
      //    any wallet is forced to 'buy' so a freshly-funded wallet never
      //    tries to sell tokens it doesn't yet hold. Organic mode keeps
      //    the original FSM-driven probability.
      const walletKey = wallet.publicKey.toBase58();
      let isBuy = this.cfg.strictAlternate
        ? (this.walletLastSide.get(walletKey) ?? 'sell') === 'sell'
        : secureRandom() < profile.buyProb;

      let size = lognormal(this.cfg.sizeLogMean, this.cfg.sizeLogStd) * profile.sizeMultiplier;
      size = Math.min(this.cfg.maxQuoteSize, Math.max(this.cfg.minQuoteSize, size));

      // Auto-flip buy → sell when the wallet can't afford the buy but holds
      // base tokens. Catches the "stuck after restart" case: even with the
      // walletLastSide seed above, a wallet that finished its last run on a
      // BUY (e.g. the next sell never landed before the user stopped) will
      // be re-seeded as 'buy' → next pick is 'sell' (correct). But a wallet
      // that only ever did one BUY and was then stopped will be seeded as
      // 'buy' → next is 'sell' (correct). The genuinely stuck case is a
      // wallet whose seed says 'sell' but actually holds tokens (e.g. a
      // sell tx confirmed at the chain level but the recordTrade row was
      // lost, or someone manually transferred tokens in). Either way, the
      // safety net here is general: if we're about to BUY but can't afford
      // it AND we hold tokens, just sell instead. Cheap (one extra RPC call
      // only on the failure branch) and self-correcting.
      if (!this.cfg.dryRun && isBuy) {
        try {
          const lamports = await this.deps.rpc.getBalance(wallet.publicKey);
          const balBn = new BN(lamports);
          const headroom = new BN(SWAP_RENT_HEADROOM_LAMPORTS);
          const buyAtoms = decimalToBn(size, quoteInfo.decimals);
          const need = quoteMint.equals(NATIVE_SOL_MINT)
            ? buyAtoms.add(headroom)
            : headroom;
          // Wallet is too poor for THIS buy but rich enough to pay sell rent
          // (tx fees + token-account rent — `headroom` is sized for that).
          if (balBn.lt(need) && balBn.gte(headroom)) {
            const live = await this.readBaseTokenBalance(wallet.publicKey, baseMint);
            if (live && !live.isZero()) {
              log.info(
                {
                  wallet: walletKey.slice(0, 6),
                  lamports,
                  needLamports: need.toString(),
                  baseTokens: live.toString(),
                },
                'auto-flip buy → sell: insufficient SOL for buy but wallet holds base tokens (recovering after stop/restart)',
              );
              isBuy = false;
            }
          }
        } catch {
          // Probe failures should fall through to the existing logic which
          // will warn-and-skip on the same condition.
        }
      }

      // Symmetric auto-flip sell → buy. Catches the post-liquidate / fresh-
      // wallet stuck loop: if `walletLastSide` says 'buy' (e.g. seeded from
      // an old run before the user ran the liquidate-tokens flow) but the
      // wallet now actually holds zero base tokens, the existing `live.isZero()`
      // skip-path below will skip every iteration AND not update lastTradedAt,
      // so `pickWallet` keeps picking the same wallet ahead of any cooldown'd
      // peers and the loop spins forever logging "sell skipped". Flipping
      // here makes the wallet do a buy instead — the natural recovery move.
      // We only flip when the wallet actually has enough SOL to do the buy;
      // otherwise we fall through to the existing skip path (which now also
      // marks the wallet as "just traded" so it doesn't get re-picked).
      if (!this.cfg.dryRun && !isBuy) {
        try {
          const live = await this.readBaseTokenBalance(wallet.publicKey, baseMint);
          if (live && live.isZero()) {
            const lamports = await this.deps.rpc.getBalance(wallet.publicKey);
            const balBn = new BN(lamports);
            const headroom = new BN(SWAP_RENT_HEADROOM_LAMPORTS);
            const buyAtoms = decimalToBn(size, quoteInfo.decimals);
            const need = quoteMint.equals(NATIVE_SOL_MINT)
              ? buyAtoms.add(headroom)
              : headroom;
            if (balBn.gte(need)) {
              log.info(
                { wallet: walletKey.slice(0, 6), lamports },
                'auto-flip sell → buy: wallet holds no base tokens (post-liquidate or fresh)',
              );
              isBuy = true;
            }
          }
        } catch {
          // Same fall-through logic as above.
        }
      }

      // 3. Per-trade slippage jitter so consecutive trades from the same
      //    bot don't all carry an identical slippage bps tag (a known
      //    forensic correlator).
      const jitter = this.cfg.slippageJitter;
      const tradeSlippageBps = (() => {
        if (!jitter || jitter <= 0) return this.cfg.slippageBps;
        const lo = 1 - jitter;
        const hi = 1 + jitter;
        return Math.max(1, Math.round(this.cfg.slippageBps * randomFloat(lo, hi)));
      })();

      const inputMint = isBuy ? quoteMint : baseMint;
      const outputMint = isBuy ? baseMint : quoteMint;

      try {
        let amountIn: BN;
        if (isBuy) {
          // size is in quote units (SOL). Convert to atomic.
          amountIn = decimalToBn(size, quoteInfo.decimals);
        } else if (this.cfg.dryRun) {
          // Dry-run sell: skip the probe quote (it would hit the network and
          // crash the whole loop on a single failure). Estimate atomic amount
          // assuming 1:1 atomic units which is fine for logging volume metrics.
          amountIn = decimalToBn(size, baseInfo.decimals);
        } else {
          // Live sell: read the wallet's ACTUAL base-token balance and clamp
          // to it. This is the fix for the previously-seen "Custom:1
          // insufficient funds" failures: in strict-alternate mode the buy
          // and sell sizes are sampled independently, so a sell sample can
          // exceed what the previous buy bought; in organic mode the FSM
          // can pick "sell" on a wallet with zero tokens. Probing the venue
          // for "how many tokens equal N SOL" is the wrong question - we
          // should sell what we actually hold.
          const live = await this.readBaseTokenBalance(wallet.publicKey, baseMint);
          if (live === null) {
            log.warn(
              { wallet: walletKey.slice(0, 6) },
              'sell deferred: base token balance unavailable (RPC); will retry next tick',
            );
            continue;
          }
          if (live.isZero()) {
            log.info(
              { wallet: walletKey.slice(0, 6) },
              'sell skipped: wallet holds no base tokens (will buy on next tick)',
            );
            // Pretend the sell happened so strict-alternate flips this
            // wallet to 'buy' next pick (matches the log-line promise of
            // "will buy on next tick"). Without this, walletLastSide stays
            // at 'buy' and the next pick of this wallet picks 'sell' again
            // → skip again → infinite loop.
            this.walletLastSide.set(walletKey, 'sell');
            // Stamp the trade time too so `pickWallet` honours `cooldown`
            // and doesn't keep re-picking this wallet ahead of peers that
            // actually traded recently. Otherwise we burn N sleep cycles
            // logging the same skip on the same wallet while the cooldown
            // ones tick down — exactly the pattern we just diagnosed.
            this.walletLastTradedAt.set(walletKey, Date.now());
            this.fsm.tick();
            continue;
          }
          // Optionally cap by the sampled size (only useful in organic mode
          // where we want the sell to match the FSM's intended SOL value).
          // In strict-alternate we just dump the wallet's balance for clean
          // net-zero round-trips. 99/100 = small headroom for rounding.
          const headroomCap = live.muln(99).divn(100);
          if (this.cfg.strictAlternate) {
            amountIn = headroomCap;
          } else {
            const probe = await venue.quote({
              poolId: this.cfg.poolId,
              inputMint: quoteMint,
              outputMint: baseMint,
              amountIn: decimalToBn(size, quoteInfo.decimals),
              slippageBps: tradeSlippageBps,
            });
            amountIn = BN.min(probe.amountOut, headroomCap);
          }
        }

        // Native SOL cushion: CPI-created ATAs (see sim `InsufficientFundsForRent`).
        if (!this.cfg.dryRun) {
          try {
            const lamports = await this.deps.rpc.getBalance(wallet.publicKey);
            const balBn = new BN(lamports);
            const headroom = new BN(SWAP_RENT_HEADROOM_LAMPORTS);
            if (isBuy) {
              // Native-SOL quote: principal + rent/fee cushion.
              // SPL quote (e.g. WSOL): swap comes from token ATA; payer still needs lamports for ATAs/fees.
              const need = quoteMint.equals(NATIVE_SOL_MINT)
                ? BN.max(amountIn, new BN(0)).add(headroom)
                : headroom;
              if (balBn.lt(need)) {
                log.warn(
                  {
                    wallet: walletKey.slice(0, 6),
                    side: 'buy',
                    lamports,
                    needLamports: need.toString(),
                    quote: quoteMint.equals(NATIVE_SOL_MINT) ? 'native' : 'spl',
                    reserveSol: SWAP_RENT_HEADROOM_LAMPORTS / LAMPORTS_PER_SOL,
                  },
                  quoteMint.equals(NATIVE_SOL_MINT)
                    ? 'trade skipped: native SOL below swap + rent reserve (fund this wallet)'
                    : 'trade skipped: native SOL below rent/fees reserve for SPL-quote buy (fund SOL on this wallet)',
                );
                continue;
              }
            } else if (!isBuy && balBn.lt(headroom)) {
              log.warn(
                {
                  wallet: walletKey.slice(0, 6),
                  side: 'sell',
                  lamports,
                  minReserveLamports: headroom.toString(),
                  reserveSol: SWAP_RENT_HEADROOM_LAMPORTS / LAMPORTS_PER_SOL,
                },
                'trade skipped: native SOL below rent reserve for sell route (fund this wallet)',
              );
              continue;
            }
          } catch {
            /* don't block trades if balance read fails */
          }
        }

        if (this.cfg.dryRun) {
          log.info(
            {
              state: this.fsm.current(),
              wallet: wallet.publicKey.toBase58(),
              side: isBuy ? 'buy' : 'sell',
              size,
              amountIn: amountIn.toString(),
            },
            'DRY RUN trade',
          );
        } else {
          let result: Awaited<ReturnType<typeof this.deps.exec.execute>> | null = null;
          const isPumpVenue = this.cfg.venue === 'pumpswap';
          for (let attempt = 0; attempt < PUMP_FEE_REROLL_MAX_ATTEMPTS; attempt++) {
            try {
              const built = await venue.buildSwap({
                poolId: this.cfg.poolId,
                inputMint,
                outputMint,
                amountIn,
                user: wallet.publicKey,
                slippageBps: tradeSlippageBps,
              });
              let luts: import('@solana/web3.js').AddressLookupTableAccount[] = [];
              if (
                built.addressLookupTables &&
                built.addressLookupTables.length > 0 &&
                this.cfg.venue === 'jupiter'
              ) {
                const jup = venue as JupiterVenue;
                luts = await jup.loadLuts(built.addressLookupTables);
              }
              // Jitter compute-unit limit and priority fee per trade so two
              // consecutive volume txs aren't byte-identical in their CB
              // instructions (a known forensic correlator).
              const cuLimit = (() => {
                const j = this.cfg.cuJitter;
                if (!j || j <= 0) return this.cfg.computeUnitLimit;
                return Math.max(
                  50_000,
                  Math.round(this.cfg.computeUnitLimit * randomFloat(1 - j, 1 + j)),
                );
              })();
              const priorityFee = (() => {
                const base = this.cfg.priorityMicroLamports;
                const j = this.cfg.priorityFeeJitter;
                if (!base || base <= 0) return undefined; // executor default
                if (!j || j <= 0) return base;
                return Math.max(0, Math.round(base * randomFloat(1 - j, 1 + j)));
              })();
              result = await this.deps.exec.execute(
                wallet,
                built.instructions,
                {
                  useJito: this.cfg.useJito,
                  computeUnitLimit: cuLimit,
                  priorityMicroLamports: priorityFee,
                  skipPreflight: false,
                  maxRetries: 2,
                },
                built.signers ?? [],
                luts,
              );
              break;
            } catch (e) {
              const reroll =
                isPumpVenue &&
                isPumpFeeRecipientRentError(e, isBuy ? 'buy' : 'sell') &&
                attempt + 1 < PUMP_FEE_REROLL_MAX_ATTEMPTS;
              if (!reroll) throw e;
              log.warn(
                {
                  wallet: wallet.publicKey.toBase58().slice(0, 6),
                  side: isBuy ? 'buy' : 'sell',
                  attempt,
                  remaining: PUMP_FEE_REROLL_MAX_ATTEMPTS - attempt - 1,
                },
                'pumpswap protocol_fee_recipient sub-rent — re-rolling',
              );
              // Tiny jitter so we don't hammer RPC with parallel rebuilds.
              await sleep(150 + Math.floor(Math.random() * 200));
            }
          }
          if (!result) {
            throw new Error('pumpswap fee-recipient re-roll exhausted');
          }
          this.deps.store.recordTrade({
            runId: this.runId,
            ts: Date.now(),
            wallet: wallet.publicKey.toBase58(),
            side: isBuy ? 'buy' : 'sell',
            amountIn: amountIn.toString(),
            amountOut: '0', // we don't parse logs here; could be added by tx fetcher
            signature: result.signature,
            pool: this.cfg.poolId.toBase58(),
            venue: this.cfg.venue,
            slippageBps: tradeSlippageBps,
          });
          // Track wallet usage for rotation/retirement and record the last
          // *successful* side so strict alternation flips on real progress
          // (not on failed attempts, which would let state drift).
          this.walletTradeCount.set(walletKey, (this.walletTradeCount.get(walletKey) ?? 0) + 1);
          this.walletLastTradedAt.set(walletKey, Date.now());
          this.walletLastSide.set(walletKey, isBuy ? 'buy' : 'sell');
          log.info(
            {
              state: this.fsm.current(),
              wallet: wallet.publicKey.toBase58().slice(0, 6),
              side: isBuy ? 'buy' : 'sell',
              size: +size.toFixed(4),
              sig: result.signature.slice(0, 12),
            },
            'trade',
          );
        }
      } catch (e) {
        // Keep the slice generous - PumpSwap/Anchor throw with a `logs:` tail
        // that includes the actual program error code, which is essential
        // for diagnosing rent-exempt or fee-recipient issues.
        let solUi: number | undefined;
        if (!this.cfg.dryRun) {
          try {
            const lamports = await this.deps.rpc.getBalance(wallet.publicKey);
            solUi = lamports / LAMPORTS_PER_SOL;
          } catch {
            /* ignore balance probe errors */
          }
        }
        log.warn(
          {
            wallet: wallet.publicKey.toBase58().slice(0, 6),
            side: isBuy ? 'buy' : 'sell',
            size: +size.toFixed(4),
            sol: solUi != null ? +solUi.toFixed(4) : undefined,
            err: (e as Error).message.slice(0, 4000),
          },
          'trade failed',
        );
      }

      this.fsm.tick();
    }
  }

  /**
   * Read the wallet's live base-token balance. Used by the sell branch to
   * clamp the sell amount to what we actually hold (defeats "Custom:1
   * insufficient funds" failures from sampled-size mismatches).
   *
   * Returns `null` when RPC fails — callers must **not** treat that as zero
   * or sells get wrongly skipped during outages (`fetch failed` / Tor).
   *
   * Filters by mint only - that's enough for legacy SPL Token accounts. If
   * we ever support Token-2022 base mints in PumpSwap we'd need a programId
   * filter too, but PumpSwap is legacy-only today.
   */
  private async readBaseTokenBalance(
    walletPubkey: PublicKey,
    baseMint: PublicKey,
  ): Promise<BN | null> {
    try {
      const result = await this.deps.rpc.withRetry(
        (c) => c.getParsedTokenAccountsByOwner(walletPubkey, { mint: baseMint }),
        8,
      );
      if (!result.value.length) return new BN(0);
      // Prefer the largest balance if there's somehow more than one ATA
      // (shouldn't happen with mint+owner, but be defensive).
      let max = new BN(0);
      for (const a of result.value) {
        const data = a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } };
        const amount = data.parsed?.info?.tokenAmount?.amount ?? '0';
        const bn = new BN(String(amount));
        if (bn.gt(max)) max = bn;
      }
      return max;
    } catch (e) {
      log.warn(
        { err: (e as Error).message, wallet: walletPubkey.toBase58().slice(0, 6) },
        'token balance probe failed',
      );
      return null;
    }
  }

  /**
   * Pick a wallet honouring trade-cap retirement and per-wallet cooldown.
   *
   * Selection rules in priority order:
   *   1. drop wallets that have hit `walletTradeCap` (returns undefined if
   *      that exhausts the pool entirely - the loop interprets this as
   *      a clean stop)
   *   2. of the remaining, prefer ones outside their cooldown
   *   3. if all eligible wallets are inside cooldown, fall back to the
   *      least-recently-used one (least-bad option, avoids busy-waiting)
   */
  private pickWallet(): Keypair | undefined {
    const now = Date.now();
    const cap = this.cfg.walletTradeCap;
    const cooldown = this.cfg.walletCooldownMs;

    const live = cap > 0
      ? this.cfg.wallets.filter((w) => (this.walletTradeCount.get(w.publicKey.toBase58()) ?? 0) < cap)
      : this.cfg.wallets;
    if (live.length === 0) return undefined;

    if (cooldown > 0) {
      const fresh = live.filter((w) => {
        const last = this.walletLastTradedAt.get(w.publicKey.toBase58()) ?? 0;
        return now - last >= cooldown;
      });
      if (fresh.length > 0) return pick(fresh);
      // All on cooldown: fall back to LRU so we at least keep moving.
      const sorted = [...live].sort((a, b) => {
        const al = this.walletLastTradedAt.get(a.publicKey.toBase58()) ?? 0;
        const bl = this.walletLastTradedAt.get(b.publicKey.toBase58()) ?? 0;
        return al - bl;
      });
      return sorted[0];
    }

    return pick(live);
  }
}

/** sleep helper that wakes early if `cancelled()` becomes true. */
async function sleepWithCancel(ms: number, cancelled: () => boolean, step = 250): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cancelled()) return;
    await sleep(Math.min(step, end - Date.now()));
  }
}
