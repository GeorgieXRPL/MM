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

const log = createLogger('strategy:counter-momentum');

/**
 * Counter-momentum (mean-reversion) strategy.
 *
 * Holds a rolling price history and only fires a swap when price moves
 * outside +/- `triggerPct` of the rolling baseline. Buys on dips (price
 * dropped), sells on rallies (price rose). Net effect: provides liquidity
 * against the prevailing flow, dampens volatility, captures spread - all
 * good for the LP, none of which is volume manufacturing.
 *
 * Parameters worth tuning:
 *   - triggerPct        - threshold to fire (e.g. 0.02 = 2%)
 *   - lookbackSec       - rolling window length (longer = less twitchy)
 *   - sampleIntervalMs  - how often we poll the price
 *   - cooldownMs        - minimum time between fires
 *   - maxSizeQuote      - hard ceiling on a single trade in quote units
 */
export interface CounterMomentumConfig {
  poolId: PublicKey;
  venue: VenueId;
  wallet: Keypair;
  baseMint?: PublicKey;
  quoteMint?: PublicKey;
  /** Trigger when price moves more than this fraction from baseline. 0.02 = 2%. */
  triggerPct?: number;
  /** Rolling baseline window, seconds. Default 300 (5 min). */
  lookbackSec?: number;
  /** Price poll interval, ms. Default 5000. */
  sampleIntervalMs?: number;
  /** Cooldown between fires, ms. Default 60000. */
  cooldownMs?: number;
  /**
   * Trade size as a fraction of the wallet's available inventory on the
   * relevant side. e.g. 0.1 = use 10% of base balance to sell on a rally.
   */
  sizeFraction?: number;
  /** Hard ceiling on a single trade in quote units (SOL). */
  maxSizeQuote?: number;
  /** Slippage bps. */
  slippageBps?: number;
  /** Slippage jitter +/- fraction. Default 0.2 (+/-20%). */
  slippageJitter?: number;
  useJito?: boolean;
  dryRun?: boolean;
  computeUnitLimit?: number;
}

const DEFAULTS = {
  triggerPct: 0.02,
  lookbackSec: 300,
  sampleIntervalMs: 5_000,
  cooldownMs: 60_000,
  sizeFraction: 0.1,
  maxSizeQuote: 0.5,
  slippageBps: 100,
  slippageJitter: 0.2,
  useJito: false,
  dryRun: false,
  computeUnitLimit: 600_000,
};

interface PriceSample {
  ts: number;
  price: number; // quote per base (e.g. SOL per GLOOM)
}

export class CounterMomentumStrategy implements StrategyHandle {
  readonly id = 'counter-momentum' as const;
  private running = false;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;
  private readonly history: PriceSample[] = [];
  private lastTradeAt = 0;
  private readonly cfg: Required<
    Omit<CounterMomentumConfig, 'wallet' | 'poolId' | 'baseMint' | 'quoteMint'>
  > & {
    wallet: Keypair;
    poolId: PublicKey;
    baseMint?: PublicKey;
    quoteMint?: PublicKey;
  };

  constructor(
    public readonly runId: number,
    config: CounterMomentumConfig,
    private readonly deps: {
      rpc: RpcManager;
      exec: TxExecutor;
      venues: VenueRegistry;
      store: Store;
    },
  ) {
    this.cfg = { ...DEFAULTS, ...config } as never;
    if (this.cfg.triggerPct <= 0 || this.cfg.triggerPct > 0.5) {
      throw new Error('triggerPct must be in (0, 0.5]');
    }
    if (this.cfg.sizeFraction <= 0 || this.cfg.sizeFraction > 1) {
      throw new Error('sizeFraction must be in (0, 1]');
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
        triggerPct: this.cfg.triggerPct,
        lookbackSec: this.cfg.lookbackSec,
        dryRun: this.cfg.dryRun,
      },
      'counter-momentum starting',
    );
    this.loopPromise = this.loop().catch((e) => {
      log.error({ err: (e as Error).message }, 'counter-momentum loop crashed');
      this.deps.store.stopRun(this.runId, 'errored', (e as Error).message);
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.loopPromise) await this.loopPromise;
    this.running = false;
    this.deps.store.stopRun(this.runId, 'stopped');
    log.info({ runId: this.runId }, 'counter-momentum stopped');
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
        const price = await this.samplePrice(venue, baseMint, quoteMint, baseInfo.decimals, quoteInfo.decimals);
        if (price === null) {
          await sleepWithCancel(this.cfg.sampleIntervalMs, () => this.stopRequested);
          continue;
        }
        this.history.push({ ts: Date.now(), price });
        const cutoff = Date.now() - this.cfg.lookbackSec * 1000;
        while (this.history.length > 0 && (this.history[0]?.ts ?? 0) < cutoff) {
          this.history.shift();
        }

        if (this.history.length < 5) {
          // Not enough history yet. Keep accumulating.
          await sleepWithCancel(this.cfg.sampleIntervalMs, () => this.stopRequested);
          continue;
        }

        const baseline =
          this.history.reduce((s, p) => s + p.price, 0) / this.history.length;
        const change = price / baseline - 1;
        const absChange = Math.abs(change);

        log.info(
          {
            price: +price.toFixed(8),
            baseline: +baseline.toFixed(8),
            change: +change.toFixed(4),
            history: this.history.length,
          },
          'price snapshot',
        );

        if (absChange < this.cfg.triggerPct) {
          await sleepWithCancel(this.cfg.sampleIntervalMs, () => this.stopRequested);
          continue;
        }

        const sinceLast = Date.now() - this.lastTradeAt;
        if (sinceLast < this.cfg.cooldownMs) {
          await sleepWithCancel(
            Math.min(this.cfg.cooldownMs - sinceLast, this.cfg.sampleIntervalMs),
            () => this.stopRequested,
          );
          continue;
        }

        // change > 0 = price up = sell base (capture rally).
        // change < 0 = price down = buy base (capture dip).
        const isBuy = change < 0;
        const tradeSlip = this.jitteredSlippage();

        let amountIn: BN;
        const inputMint = isBuy ? quoteMint : baseMint;
        const outputMint = isBuy ? baseMint : quoteMint;

        if (isBuy) {
          // Use a fraction of available quote balance, capped by maxSizeQuote.
          const quoteBal = await this.readQuoteBalance(quoteMint, quoteInfo.decimals);
          const quoteSol = bnToDecimal(quoteBal, quoteInfo.decimals).toNumber();
          const tradeQuote = Math.min(quoteSol * this.cfg.sizeFraction, this.cfg.maxSizeQuote);
          if (tradeQuote <= 0) {
            log.warn({ quoteSol }, 'no quote inventory to buy with; skipping');
            await sleepWithCancel(this.cfg.sampleIntervalMs, () => this.stopRequested);
            continue;
          }
          amountIn = decimalToBn(tradeQuote, quoteInfo.decimals);
        } else {
          // Sell a fraction of available base.
          const baseBal = await this.readTokenBalance(baseMint);
          const baseDec = bnToDecimal(baseBal, baseInfo.decimals).toNumber();
          const tradeBase = baseDec * this.cfg.sizeFraction;
          if (tradeBase <= 0) {
            log.warn({ baseDec }, 'no base inventory to sell; skipping');
            await sleepWithCancel(this.cfg.sampleIntervalMs, () => this.stopRequested);
            continue;
          }
          amountIn = decimalToBn(tradeBase, baseInfo.decimals);
        }

        if (this.cfg.dryRun) {
          log.info(
            {
              side: isBuy ? 'buy' : 'sell',
              amountIn: amountIn.toString(),
              tradeSlip,
            },
            'DRY RUN counter-momentum',
          );
          this.lastTradeAt = Date.now();
          await sleepWithCancel(this.cfg.sampleIntervalMs, () => this.stopRequested);
          continue;
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
            change: +change.toFixed(4),
            sig: r.signature.slice(0, 12),
          },
          'counter-momentum trade',
        );
      } catch (e) {
        log.warn({ err: (e as Error).message.slice(0, 200) }, 'counter-momentum iteration failed');
      }
      await sleepWithCancel(this.cfg.sampleIntervalMs, () => this.stopRequested);
    }
  }

  private async samplePrice(
    venue: ReturnType<VenueRegistry['get']>,
    baseMint: PublicKey,
    quoteMint: PublicKey,
    baseDecimals: number,
    quoteDecimals: number,
  ): Promise<number | null> {
    try {
      // 1 unit of base, sized down so it doesn't move the pool.
      const probe = await venue.quote({
        poolId: this.cfg.poolId,
        inputMint: baseMint,
        outputMint: quoteMint,
        amountIn: decimalToBn(1, baseDecimals),
        slippageBps: 50,
      });
      const inDec = bnToDecimal(probe.amountIn, baseDecimals).toNumber();
      const outDec = bnToDecimal(probe.amountOut, quoteDecimals).toNumber();
      return inDec > 0 ? outDec / inDec : null;
    } catch (e) {
      log.warn({ err: (e as Error).message.slice(0, 200) }, 'price sample failed');
      return null;
    }
  }

  private async readQuoteBalance(quoteMint: PublicKey, _decimals: number): Promise<BN> {
    const NATIVE_SOL = 'So11111111111111111111111111111111111111112';
    if (quoteMint.toBase58() === NATIVE_SOL) {
      const lamports = await this.deps.rpc.getBalance(this.cfg.wallet.publicKey);
      return new BN(lamports);
    }
    return this.readTokenBalance(quoteMint);
  }

  private async readTokenBalance(mint: PublicKey): Promise<BN> {
    const conn = this.deps.rpc.pickConnection();
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
        // ignore - try the other program
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
