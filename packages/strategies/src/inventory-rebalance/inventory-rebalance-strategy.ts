import { Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
  type VenueId,
  bnToDecimal,
  createLogger,
  decimalToBn,
  randomFloat,
  sleep,
} from '@amm/shared';
import type { RpcManager, Store, TxExecutor } from '@amm/core';
import type { VenueRegistry } from '@amm/venues';
import { JupiterVenue } from '@amm/venues';
import type { StrategyHandle } from '../strategy.js';

const log = createLogger('strategy:inventory-rebalance');

/**
 * Inventory-rebalance strategy.
 *
 * Reactive, NOT generative. The strategy holds an LP-style inventory of
 * `(base, quote)` and only trades when the *current* ratio drifts more than
 * `driftThreshold` away from the target. Real swaps elsewhere on the pool
 * push the inventory off-target; this strategy nudges it back. Net effect
 * over time: the strategy provides counter-flow liquidity to the natural
 * market - good for LPs, not manipulative.
 *
 * Loop:
 *   1. Read wallet's base SOL + base-token balances.
 *   2. Convert both to a common quote-unit (SOL) via a venue quote.
 *   3. Compute current `baseFraction = baseValueInQuote / totalValueInQuote`.
 *   4. If |baseFraction - targetBaseFraction| > driftThreshold, swap the
 *      smaller-than-target side onto the over-target side just enough to
 *      bring it back to target (never overshoots).
 *   5. Sleep `pollIntervalMs`, repeat.
 *
 * No state machine, no random buy/sell. Every trade is a direct response
 * to a measurable pool-state change.
 */
export interface InventoryRebalanceConfig {
  poolId: PublicKey;
  /** Venue to trade through. Recommended: 'jupiter' for best execution. */
  venue: VenueId;
  /** Single wallet that holds the inventory. */
  wallet: Keypair;
  /** Base mint. Required when venue is 'jupiter'; auto-resolved otherwise. */
  baseMint?: PublicKey;
  /** Quote mint (typically WSOL). Required when venue is 'jupiter'. */
  quoteMint?: PublicKey;
  /** Target base fraction in [0, 1]. 0.5 = 50/50 split by quote value. */
  targetBaseFraction?: number;
  /**
   * Required drift before rebalancing fires. e.g. 0.05 means "wait until the
   * inventory is +/- 5 percentage points off target". Smaller values trade
   * more often; larger values are more passive.
   */
  driftThreshold?: number;
  /** Slippage on rebalance swaps, bps. */
  slippageBps?: number;
  /** Per-trade slippage jitter +/- fraction (0.3 = +/-30%). */
  slippageJitter?: number;
  /** Polling interval, ms. Default 30s. */
  pollIntervalMs?: number;
  /** Cooldown between rebalance trades, ms. Prevents thrashing. */
  cooldownMs?: number;
  /**
   * Hard ceiling on a single rebalance trade size in **quote** units (SOL).
   * Caps the per-iteration impact even if the inventory has drifted hard.
   */
  maxTradeQuote?: number;
  /** Use Jito bundles for execution. */
  useJito?: boolean;
  /** Dry-run: log decisions, don't send. */
  dryRun?: boolean;
  /** Compute unit limit per swap. */
  computeUnitLimit?: number;
}

const DEFAULTS = {
  targetBaseFraction: 0.5,
  driftThreshold: 0.05,
  slippageBps: 100,
  slippageJitter: 0.2,
  pollIntervalMs: 30_000,
  cooldownMs: 60_000,
  maxTradeQuote: 1.0,
  useJito: false,
  dryRun: false,
  computeUnitLimit: 600_000,
};

export class InventoryRebalanceStrategy implements StrategyHandle {
  readonly id = 'inventory-rebalance' as const;
  private running = false;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;
  private lastTradeAt = 0;
  private readonly cfg: Required<
    Omit<InventoryRebalanceConfig, 'wallet' | 'poolId' | 'baseMint' | 'quoteMint'>
  > & {
    wallet: Keypair;
    poolId: PublicKey;
    baseMint?: PublicKey;
    quoteMint?: PublicKey;
  };

  constructor(
    public readonly runId: number,
    config: InventoryRebalanceConfig,
    private readonly deps: {
      rpc: RpcManager;
      exec: TxExecutor;
      venues: VenueRegistry;
      store: Store;
    },
  ) {
    this.cfg = { ...DEFAULTS, ...config } as never;
    if (this.cfg.targetBaseFraction < 0 || this.cfg.targetBaseFraction > 1) {
      throw new Error('targetBaseFraction must be in [0, 1]');
    }
    if (this.cfg.driftThreshold <= 0 || this.cfg.driftThreshold >= 1) {
      throw new Error('driftThreshold must be in (0, 1)');
    }
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
        wallet: this.cfg.wallet.publicKey.toBase58(),
        targetBaseFraction: this.cfg.targetBaseFraction,
        driftThreshold: this.cfg.driftThreshold,
        dryRun: this.cfg.dryRun,
      },
      'inventory-rebalance starting',
    );
    this.loopPromise = this.loop().catch((e) => {
      log.error({ err: (e as Error).message }, 'inventory-rebalance loop crashed');
      this.deps.store.stopRun(this.runId, 'errored', (e as Error).message);
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.loopPromise) await this.loopPromise;
    this.running = false;
    this.deps.store.stopRun(this.runId, 'stopped');
    log.info({ runId: this.runId }, 'inventory-rebalance stopped');
  }

  private async loop(): Promise<void> {
    const venue = this.deps.venues.get(this.cfg.venue);

    let baseMint = this.cfg.baseMint;
    let quoteMint = this.cfg.quoteMint;
    if (!baseMint || !quoteMint) {
      if (this.cfg.venue === 'jupiter') {
        throw new Error('jupiter venue requires explicit baseMint/quoteMint');
      }
      const pool = await venue.getPool(this.cfg.poolId);
      baseMint = pool.baseMint;
      quoteMint = pool.quoteMint;
    }
    const baseInfo = await venue.getTokenInfo(baseMint);
    const quoteInfo = await venue.getTokenInfo(quoteMint);

    while (!this.stopRequested) {
      try {
        // 1. Read on-chain balances of base and quote held by the wallet.
        const baseBalanceAtoms = await this.readTokenBalance(baseMint, baseInfo.decimals);
        const quoteBalanceAtoms = await this.readQuoteBalance(quoteMint, quoteInfo.decimals);
        const baseBalance = bnToDecimal(baseBalanceAtoms, baseInfo.decimals).toNumber();
        const quoteBalance = bnToDecimal(quoteBalanceAtoms, quoteInfo.decimals).toNumber();

        // 2. Convert base -> quote-units via venue quote (small probe size
        //    so the impact-adjusted price isn't badly skewed).
        let baseValueInQuote = 0;
        if (baseBalance > 0) {
          const probe = await venue.quote({
            poolId: this.cfg.poolId,
            inputMint: baseMint,
            outputMint: quoteMint,
            // Probe with min(0.1% of holding, 0.01 SOL-equivalent worth) so
            // we don't move the pool just to estimate.
            amountIn: decimalToBn(Math.max(baseBalance * 0.001, 0.000001), baseInfo.decimals),
            slippageBps: 50,
          });
          const probeIn = bnToDecimal(probe.amountIn, baseInfo.decimals).toNumber();
          const probeOut = bnToDecimal(probe.amountOut, quoteInfo.decimals).toNumber();
          if (probeIn > 0) {
            const pricePerBase = probeOut / probeIn;
            baseValueInQuote = baseBalance * pricePerBase;
          }
        }

        const totalQuote = baseValueInQuote + quoteBalance;
        if (totalQuote <= 0) {
          log.warn(
            { wallet: this.cfg.wallet.publicKey.toBase58() },
            'wallet has no inventory; sleeping',
          );
          await sleepWithCancel(this.cfg.pollIntervalMs, () => this.stopRequested);
          continue;
        }

        const baseFraction = baseValueInQuote / totalQuote;
        const drift = baseFraction - this.cfg.targetBaseFraction;
        const absDrift = Math.abs(drift);

        log.info(
          {
            base: +baseBalance.toFixed(6),
            quote: +quoteBalance.toFixed(6),
            baseValueInQuote: +baseValueInQuote.toFixed(6),
            baseFraction: +baseFraction.toFixed(4),
            target: this.cfg.targetBaseFraction,
            drift: +drift.toFixed(4),
          },
          'inventory snapshot',
        );

        if (absDrift < this.cfg.driftThreshold) {
          await sleepWithCancel(this.cfg.pollIntervalMs, () => this.stopRequested);
          continue;
        }

        // 3. Cooldown gate to prevent thrashing on noisy quotes.
        const sinceLast = Date.now() - this.lastTradeAt;
        if (sinceLast < this.cfg.cooldownMs) {
          await sleepWithCancel(
            Math.min(this.cfg.cooldownMs - sinceLast, this.cfg.pollIntervalMs),
            () => this.stopRequested,
          );
          continue;
        }

        // 4. Compute the trade. We want post-trade baseFraction === target.
        //    If drift > 0 (too much base): SELL base -> buy quote.
        //    If drift < 0 (too much quote): BUY base with quote.
        //
        //    Required quote-unit movement to bring the ratio back is:
        //       |drift| * totalQuote
        //    Capped by `maxTradeQuote`.
        const tradeQuote = Math.min(absDrift * totalQuote, this.cfg.maxTradeQuote);
        const isBuy = drift < 0; // too little base => buy more
        const tradeSlip = this.jitteredSlippage();

        if (this.cfg.dryRun) {
          log.info(
            {
              side: isBuy ? 'buy' : 'sell',
              quoteUnits: +tradeQuote.toFixed(6),
              tradeSlip,
            },
            'DRY RUN rebalance',
          );
          this.lastTradeAt = Date.now();
          await sleepWithCancel(this.cfg.pollIntervalMs, () => this.stopRequested);
          continue;
        }

        // For a sell we need to know how much base equals N quote.
        let amountIn: BN;
        const inputMint = isBuy ? quoteMint : baseMint;
        const outputMint = isBuy ? baseMint : quoteMint;
        if (isBuy) {
          amountIn = decimalToBn(tradeQuote, quoteInfo.decimals);
        } else {
          // Probe how much base produces tradeQuote in quote.
          const probe = await venue.quote({
            poolId: this.cfg.poolId,
            inputMint: quoteMint,
            outputMint: baseMint,
            amountIn: decimalToBn(tradeQuote, quoteInfo.decimals),
            slippageBps: tradeSlip,
          });
          amountIn = probe.amountOut;
        }

        const built = await venue.buildSwap({
          poolId: this.cfg.poolId,
          inputMint,
          outputMint,
          amountIn,
          user: this.cfg.wallet.publicKey,
          slippageBps: tradeSlip,
        });
        let luts: import('@solana/web3.js').AddressLookupTableAccount[] = [];
        if (built.addressLookupTables && built.addressLookupTables.length > 0 && this.cfg.venue === 'jupiter') {
          luts = await (venue as JupiterVenue).loadLuts(built.addressLookupTables);
        }
        const r = await this.deps.exec.execute(
          this.cfg.wallet,
          built.instructions,
          {
            useJito: this.cfg.useJito,
            computeUnitLimit: this.cfg.computeUnitLimit,
            skipPreflight: false,
            maxRetries: 2,
          },
          built.signers ?? [],
          luts,
        );

        this.deps.store.recordTrade({
          runId: this.runId,
          ts: Date.now(),
          wallet: this.cfg.wallet.publicKey.toBase58(),
          side: isBuy ? 'buy' : 'sell',
          amountIn: amountIn.toString(),
          amountOut: '0',
          signature: r.signature,
          pool: this.cfg.poolId.toBase58(),
          venue: this.cfg.venue,
          slippageBps: tradeSlip,
        });
        this.lastTradeAt = Date.now();
        log.info(
          {
            side: isBuy ? 'buy' : 'sell',
            quoteUnits: +tradeQuote.toFixed(6),
            sig: r.signature.slice(0, 12),
          },
          'rebalance trade',
        );
      } catch (e) {
        log.warn({ err: (e as Error).message.slice(0, 200) }, 'rebalance iteration failed');
      }
      await sleepWithCancel(this.cfg.pollIntervalMs, () => this.stopRequested);
    }
  }

  /** SOL balance in atomic lamports (or wrapped-SOL ATA balance). */
  private async readQuoteBalance(quoteMint: PublicKey, decimals: number): Promise<BN> {
    const NATIVE_SOL = 'So11111111111111111111111111111111111111112';
    if (quoteMint.toBase58() === NATIVE_SOL) {
      const lamports = await this.deps.rpc.getBalance(this.cfg.wallet.publicKey);
      return new BN(lamports);
    }
    return this.readTokenBalance(quoteMint, decimals);
  }

  /** Atomic SPL balance (Token + Token-2022) for the wallet on a given mint. */
  private async readTokenBalance(mint: PublicKey, _decimals: number): Promise<BN> {
    const conn = this.deps.rpc.pickConnection();
    // Try both legacy + Token-2022 token programs.
    const programs = [
      new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
    ];
    let total = new BN(0);
    for (const programId of programs) {
      try {
        const r = await conn.getParsedTokenAccountsByOwner(this.cfg.wallet.publicKey, {
          programId,
        });
        for (const { account } of r.value) {
          const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } })
            .parsed?.info;
          if (!info || info.mint !== mint.toBase58()) continue;
          const amt = info.tokenAmount?.amount;
          if (amt) total = total.add(new BN(amt));
        }
      } catch {
        // Some RPCs reject one program but accept the other; ignore.
      }
    }
    return total;
  }

  private jitteredSlippage(): number {
    const j = this.cfg.slippageJitter;
    if (!j || j <= 0) return this.cfg.slippageBps;
    return Math.max(1, Math.round(this.cfg.slippageBps * randomFloat(1 - j, 1 + j)));
  }
}

async function sleepWithCancel(ms: number, cancelled: () => boolean, step = 250): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cancelled()) return;
    await sleep(Math.min(step, end - Date.now()));
  }
}
