import { Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
  type VenueId,
  createLogger,
  decimalToBn,
  bnToDecimal,
  sleep,
  clamp,
} from '@amm/shared';
import type { PriceOracle, RpcManager, Store, TxExecutor } from '@amm/core';
import type { VenueRegistry } from '@amm/venues';
import type { StrategyHandle } from '../strategy.js';

const log = createLogger('strategy:clmm-mm');

export interface ClmmMmConfig {
  /** CLMM-capable venue. */
  venue: Extract<VenueId, 'meteora-dlmm' | 'raydium-clmm' | 'orca-whirlpools'>;
  poolId: PublicKey;
  /** LP wallet (must hold base + quote inventory). */
  wallet: Keypair;

  /** Range half-width as a fraction of price (e.g. 0.04 = +/-4%). */
  rangeWidth?: number;
  /** Hysteresis: only rebalance once price has moved this far past the edge. */
  rebalanceHysteresis?: number;
  /** Cooloff after a rebalance, ms. */
  cooldownMs?: number;
  /** Polling interval, ms. */
  pollIntervalMs?: number;

  /** Base inventory target as a fraction of total inventory value [0..1]. */
  targetBaseFraction?: number;
  /** Allowed deviation from targetBaseFraction before forced inventory swap. */
  inventoryTolerance?: number;

  /** Slippage for swaps and LP ops. */
  slippageBps?: number;

  /** Periodically claim and (if `compoundFees`) redeposit fees. */
  fokFeeClaimIntervalMs?: number;
  compoundFees?: boolean;

  dryRun?: boolean;
}

const DEFAULTS = {
  rangeWidth: 0.05,
  rebalanceHysteresis: 0.01,
  cooldownMs: 30_000,
  pollIntervalMs: 5_000,
  targetBaseFraction: 0.5,
  inventoryTolerance: 0.1,
  slippageBps: 80,
  fokFeeClaimIntervalMs: 5 * 60_000,
  compoundFees: true,
  dryRun: false,
};

/**
 * Generic CLMM market-maker. Works on any venue whose adapter implements
 * range positions (Meteora DLMM, Raydium CLMM, Orca Whirlpools).
 *
 * Loop:
 *  1. fetch positions
 *  2. if no position, open one centered on current price
 *  3. if price has drifted out of range + hysteresis: close, swap toward target inventory, reopen
 *  4. periodically claim fees; optionally redeposit
 *  5. inventory drift check: rebalance via swap if base/quote ratio drifts past tolerance
 */
export class ClmmMmStrategy implements StrategyHandle {
  readonly id = 'clmm-mm' as const;
  private running = false;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;
  private lastRebalanceAt = 0;
  private lastFeeClaimAt = 0;

  private readonly cfg: Required<Omit<ClmmMmConfig, 'wallet' | 'venue' | 'poolId'>> & {
    wallet: Keypair;
    venue: ClmmMmConfig['venue'];
    poolId: PublicKey;
  };

  constructor(
    public readonly runId: number,
    cfg: ClmmMmConfig,
    private readonly deps: {
      rpc: RpcManager;
      exec: TxExecutor;
      venues: VenueRegistry;
      store: Store;
      oracle: PriceOracle;
    },
  ) {
    this.cfg = { ...DEFAULTS, ...cfg } as never;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    log.info(
      { runId: this.runId, venue: this.cfg.venue, pool: this.cfg.poolId.toBase58() },
      'clmm-mm starting',
    );
    this.loopPromise = this.loop().catch((e) => {
      log.error({ err: (e as Error).message }, 'clmm-mm loop crashed');
      this.deps.store.stopRun(this.runId, 'errored', (e as Error).message);
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.loopPromise) await this.loopPromise;
    this.running = false;
    this.deps.store.stopRun(this.runId, 'stopped');
    log.info({ runId: this.runId }, 'clmm-mm stopped');
  }

  private async loop(): Promise<void> {
    const venue = this.deps.venues.get(this.cfg.venue);
    const pool = await venue.getPool(this.cfg.poolId);

    while (!this.stopRequested) {
      try {
        const price =
          (await this.deps.oracle.getPrice(pool.baseMint)) ?? (await this.derivePoolPrice(pool));
        if (!price) {
          log.warn('no price; skipping iteration');
          await sleep(this.cfg.pollIntervalMs);
          continue;
        }

        const positions = await venue.getPositions(this.cfg.poolId, this.cfg.wallet.publicKey);

        // 1. Open initial position if none.
        if (positions.length === 0) {
          await this.openCenteredPosition(price, pool);
          this.lastRebalanceAt = Date.now();
          await sleep(this.cfg.pollIntervalMs);
          continue;
        }

        const pos = positions[0]!;

        // 2. Out-of-range check with hysteresis.
        const outOfRange =
          pos.lowerPrice !== undefined &&
          pos.upperPrice !== undefined &&
          (price < pos.lowerPrice * (1 - this.cfg.rebalanceHysteresis) ||
            price > pos.upperPrice * (1 + this.cfg.rebalanceHysteresis));

        const cooldownPassed = Date.now() - this.lastRebalanceAt >= this.cfg.cooldownMs;

        if (outOfRange && cooldownPassed) {
          log.info(
            { price, lower: pos.lowerPrice, upper: pos.upperPrice },
            'price out of range, rebalancing',
          );
          await this.rebalance(pos, price, pool);
          this.lastRebalanceAt = Date.now();
        }

        // 3. Periodic fee claim.
        if (Date.now() - this.lastFeeClaimAt >= this.cfg.fokFeeClaimIntervalMs) {
          // SDK-specific - skipped here; venues expose claimFees in their LP flow.
          this.lastFeeClaimAt = Date.now();
          if (this.cfg.compoundFees) {
            log.debug('fee compounding tick (TODO: per-venue claim+redeposit)');
          }
        }
      } catch (e) {
        log.warn({ err: (e as Error).message.slice(0, 200) }, 'iteration failed');
      }

      await sleep(this.cfg.pollIntervalMs);
    }
  }

  private async derivePoolPrice(pool: {
    baseMint: PublicKey;
    quoteMint: PublicKey;
    baseDecimals: number;
    quoteDecimals: number;
  }): Promise<number | undefined> {
    try {
      const venue = this.deps.venues.get(this.cfg.venue);
      const probeAmt = decimalToBn(0.001, pool.quoteDecimals);
      const q = await venue.quote({
        poolId: this.cfg.poolId,
        inputMint: pool.quoteMint,
        outputMint: pool.baseMint,
        amountIn: probeAmt,
        slippageBps: 100,
      });
      const baseOut = bnToDecimal(q.amountOut, pool.baseDecimals);
      if (baseOut.isZero()) return undefined;
      const { Decimal } = await import('decimal.js');
      return new Decimal(0.001).div(baseOut).toNumber();
    } catch {
      return undefined;
    }
  }

  private async openCenteredPosition(
    price: number,
    pool: { baseMint: PublicKey; quoteMint: PublicKey; baseDecimals: number; quoteDecimals: number },
  ): Promise<void> {
    const venue = this.deps.venues.get(this.cfg.venue);
    const baseBal = await this.tokenBalance(pool.baseMint);
    const quoteBal = await this.tokenBalance(pool.quoteMint);
    if (baseBal.isZero() && quoteBal.isZero()) {
      log.warn('no inventory in lp wallet, skipping open');
      return;
    }
    if (this.cfg.dryRun) {
      log.info(
        { price, baseBal: baseBal.toString(), quoteBal: quoteBal.toString() },
        'DRY RUN open position',
      );
      return;
    }
    const built = await venue.buildAddLiquidity({
      poolId: this.cfg.poolId,
      user: this.cfg.wallet.publicKey,
      baseAmountMax: baseBal,
      quoteAmountMax: quoteBal,
      centerPrice: price,
      widthFraction: this.cfg.rangeWidth,
      slippageBps: this.cfg.slippageBps,
    });
    const r = await this.deps.exec.execute(
      this.cfg.wallet,
      built.instructions,
      { computeUnitLimit: 800_000, useJito: false, maxRetries: 2 },
      built.signers ?? [],
    );
    log.info({ sig: r.signature }, 'opened position');
  }

  private async rebalance(
    pos: { positionId: PublicKey; baseAmount: BN; quoteAmount: BN },
    price: number,
    pool: { baseMint: PublicKey; quoteMint: PublicKey; baseDecimals: number; quoteDecimals: number },
  ): Promise<void> {
    const venue = this.deps.venues.get(this.cfg.venue);

    if (this.cfg.dryRun) {
      log.info({ price, positionId: pos.positionId.toBase58() }, 'DRY RUN rebalance');
      return;
    }

    // 1. Close existing position.
    const remove = await venue.buildRemoveLiquidity({
      positionId: pos.positionId,
      user: this.cfg.wallet.publicKey,
      fraction: 1,
      closePosition: true,
      slippageBps: this.cfg.slippageBps,
    });
    const closeRes = await this.deps.exec.execute(
      this.cfg.wallet,
      remove.instructions,
      { computeUnitLimit: 800_000, useJito: false, maxRetries: 2 },
      remove.signers ?? [],
    );
    log.info({ sig: closeRes.signature }, 'closed position');

    // 2. Inventory check / rebalance via Jupiter (better routing across venues).
    await this.balanceInventory(price, pool);

    // 3. Reopen at new center.
    await this.openCenteredPosition(price, pool);
  }

  private async balanceInventory(
    price: number,
    pool: { baseMint: PublicKey; quoteMint: PublicKey; baseDecimals: number; quoteDecimals: number },
  ): Promise<void> {
    const baseBal = await this.tokenBalance(pool.baseMint);
    const quoteBal = await this.tokenBalance(pool.quoteMint);
    const baseValue = bnToDecimal(baseBal, pool.baseDecimals).toNumber() * price;
    const quoteValue = bnToDecimal(quoteBal, pool.quoteDecimals).toNumber();
    const total = baseValue + quoteValue;
    if (total <= 0) return;

    const baseFrac = baseValue / total;
    const drift = baseFrac - this.cfg.targetBaseFraction;
    if (Math.abs(drift) <= this.cfg.inventoryTolerance) return;

    const jup = this.deps.venues.get('jupiter');
    const targetBaseValue = total * this.cfg.targetBaseFraction;
    const swapValue = clamp(Math.abs(targetBaseValue - baseValue), 0, total / 2);
    if (drift > 0) {
      // Too much base -> sell base for quote.
      const baseAmt = decimalToBn(swapValue / price, pool.baseDecimals);
      const built = await jup.buildSwap({
        poolId: this.cfg.poolId, // ignored by jupiter
        inputMint: pool.baseMint,
        outputMint: pool.quoteMint,
        amountIn: baseAmt,
        user: this.cfg.wallet.publicKey,
        slippageBps: this.cfg.slippageBps,
      });
      await this.execJupSwap(built);
    } else {
      const quoteAmt = decimalToBn(swapValue, pool.quoteDecimals);
      const built = await jup.buildSwap({
        poolId: this.cfg.poolId,
        inputMint: pool.quoteMint,
        outputMint: pool.baseMint,
        amountIn: quoteAmt,
        user: this.cfg.wallet.publicKey,
        slippageBps: this.cfg.slippageBps,
      });
      await this.execJupSwap(built);
    }
  }

  private async execJupSwap(built: import('@amm/shared').BuiltSwap): Promise<void> {
    const luts = built.addressLookupTables
      ? await (this.deps.venues.get('jupiter') as import('@amm/venues').JupiterVenue).loadLuts(
          built.addressLookupTables,
        )
      : [];
    await this.deps.exec.execute(
      this.cfg.wallet,
      built.instructions,
      { computeUnitLimit: 600_000, useJito: false, maxRetries: 2 },
      built.signers ?? [],
      luts,
    );
  }

  private async tokenBalance(mint: PublicKey): Promise<BN> {
    if (mint.toBase58() === 'So11111111111111111111111111111111111111112') {
      const lamports = await this.deps.rpc.getBalance(this.cfg.wallet.publicKey);
      // Leave 0.05 SOL of headroom.
      return new BN(Math.max(0, lamports - 50_000_000));
    }
    const conn = this.deps.rpc.pickConnection();
    const accs = await conn.getParsedTokenAccountsByOwner(this.cfg.wallet.publicKey, { mint });
    let total = new BN(0);
    for (const acc of accs.value) {
      const amt = (acc.account.data as { parsed?: { info?: { tokenAmount?: { amount: string } } } })
        .parsed?.info?.tokenAmount?.amount;
      if (amt) total = total.add(new BN(amt));
    }
    return total;
  }
}
