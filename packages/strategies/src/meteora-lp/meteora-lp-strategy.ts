import { Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
  type DlmmStrategyType,
  type LiquidityMode,
  type LpPosition,
  bnToDecimal,
  clamp,
  createLogger,
  decimalToBn,
  sleep,
} from '@amm/shared';
import type { PriceOracle, RpcManager, Store, TxExecutor } from '@amm/core';
import { MeteoraDlmmVenue, type VenueRegistry } from '@amm/venues';
import type { StrategyHandle } from '../strategy.js';

const log = createLogger('strategy:meteora-lp');

export interface MeteoraLpConfig {
  /** Meteora DLMM lbPair pubkey. */
  poolId: PublicKey;
  /** LP wallet (must hold base + quote inventory). */
  wallet: Keypair;

  /** Deployment mode. */
  mode?: LiquidityMode;
  /** DLMM bin distribution. */
  strategyType?: DlmmStrategyType;
  /** Range half-width as a fraction of price (e.g. 0.05 = +/-5%). */
  widthFraction?: number;
  /** Single-sided: bin gap from active before position starts. */
  binOffset?: number;

  /** Hysteresis: only rebalance once price has moved this far past the edge. */
  rebalanceHysteresis?: number;
  /** Cooloff after a rebalance, ms. */
  cooldownMs?: number;
  /** Polling interval, ms. */
  pollIntervalMs?: number;

  /** Slippage for swaps and LP ops. */
  slippageBps?: number;

  /** Periodically claim and (if compoundFees) redeposit fees. */
  feeClaimIntervalMs?: number;
  compoundFees?: boolean;

  /** Single-sided: redeploy on the same side once the position fully fills
   *  (i.e. the deployed token converted to the other token). */
  autoRedeployOnFill?: boolean;
  /** Two-sided: rebalance inventory toward targetBaseFraction via Jupiter. */
  inventorySwapToTarget?: boolean;
  /** Two-sided target base fraction [0..1]. */
  targetBaseFraction?: number;

  dryRun?: boolean;
}

const DEFAULTS = {
  mode: 'two-sided' as LiquidityMode,
  strategyType: 'spot' as DlmmStrategyType,
  widthFraction: 0.05,
  binOffset: 1,
  rebalanceHysteresis: 0.01,
  cooldownMs: 30_000,
  pollIntervalMs: 5_000,
  slippageBps: 80,
  feeClaimIntervalMs: 5 * 60_000,
  compoundFees: true,
  autoRedeployOnFill: true,
  inventorySwapToTarget: true,
  targetBaseFraction: 0.5,
  dryRun: false,
};

type ResolvedConfig = Required<Omit<MeteoraLpConfig, 'wallet' | 'poolId'>> & {
  wallet: Keypair;
  poolId: PublicKey;
};

/** Runtime-editable subset of MeteoraLpConfig keys. */
const EDITABLE_KEYS = new Set<keyof MeteoraLpConfig>([
  'widthFraction',
  'rebalanceHysteresis',
  'cooldownMs',
  'pollIntervalMs',
  'slippageBps',
  'feeClaimIntervalMs',
  'compoundFees',
  'autoRedeployOnFill',
  'inventorySwapToTarget',
  'targetBaseFraction',
  'dryRun',
  'binOffset',
]);

/**
 * Dedicated Meteora DLMM LP strategy. Supports:
 *  - two-sided positions (similar to clmm-mm but Meteora-specific)
 *  - quote-only "buy ladder" single-sided positions
 *  - base-only "sell ladder" single-sided positions
 *
 * Loop:
 *  1. Ensure exactly one position exists; open one based on `mode` if not.
 *  2. Detect out-of-range OR (single-sided) one-side-fully-filled events.
 *  3. Close + (optionally) swap inventory + reopen at fresh active bin.
 *  4. Periodically claim fees; optionally compound them in-place.
 */
export class MeteoraLpStrategy implements StrategyHandle {
  readonly id = 'meteora-lp' as const;
  private running = false;
  private stopRequested = false;
  private paused = false;
  private loopPromise: Promise<void> | null = null;
  private lastRebalanceAt = 0;
  private lastFeeClaimAt = 0;

  private cfg: ResolvedConfig;

  constructor(
    public readonly runId: number,
    cfg: MeteoraLpConfig,
    private readonly deps: {
      rpc: RpcManager;
      exec: TxExecutor;
      venues: VenueRegistry;
      store: Store;
      oracle: PriceOracle;
    },
  ) {
    this.cfg = { ...DEFAULTS, ...cfg } as ResolvedConfig;
  }

  isRunning(): boolean {
    return this.running;
  }

  isPaused(): boolean {
    return this.paused;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    log.info(
      {
        runId: this.runId,
        pool: this.cfg.poolId.toBase58(),
        mode: this.cfg.mode,
        strategyType: this.cfg.strategyType,
      },
      'meteora-lp starting',
    );
    this.loopPromise = this.loop().catch((e) => {
      log.error({ err: (e as Error).message }, 'meteora-lp loop crashed');
      this.deps.store.stopRun(this.runId, 'errored', (e as Error).message);
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.loopPromise) await this.loopPromise;
    this.running = false;
    this.deps.store.stopRun(this.runId, 'stopped');
    log.info({ runId: this.runId }, 'meteora-lp stopped');
  }

  async pause(): Promise<void> {
    this.paused = true;
    log.info({ runId: this.runId }, 'meteora-lp paused');
  }

  async resume(): Promise<void> {
    this.paused = false;
    log.info({ runId: this.runId }, 'meteora-lp resumed');
  }

  async update(patch: Record<string, unknown>): Promise<void> {
    const rejected: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const key = k as keyof MeteoraLpConfig;
      if (!EDITABLE_KEYS.has(key)) {
        rejected.push(k);
        continue;
      }
      // Best-effort coercion; the caller is trusted (CLI/tRPC validates types).
      (this.cfg as unknown as Record<string, unknown>)[key] = v;
    }
    if (rejected.length > 0) {
      throw new Error(
        `cannot update keys at runtime (stop+restart required): ${rejected.join(', ')}`,
      );
    }
    log.info({ runId: this.runId, patch }, 'meteora-lp config updated');
  }

  private get venue(): MeteoraDlmmVenue {
    const v = this.deps.venues.get('meteora-dlmm');
    if (!(v instanceof MeteoraDlmmVenue)) {
      throw new Error('meteora-dlmm venue not registered');
    }
    return v;
  }

  private async loop(): Promise<void> {
    const venue = this.venue;
    const pool = await venue.getPool(this.cfg.poolId);

    while (!this.stopRequested) {
      try {
        if (this.paused) {
          await sleep(this.cfg.pollIntervalMs);
          continue;
        }

        const price = await venue.getActiveBinPrice(this.cfg.poolId).catch(() => undefined);
        const positions = await venue.getPositions(this.cfg.poolId, this.cfg.wallet.publicKey);

        // 1. Open initial position if none.
        if (positions.length === 0) {
          if (price === undefined) {
            log.warn('no active price, deferring initial open');
            await sleep(this.cfg.pollIntervalMs);
            continue;
          }
          await this.openPosition(price, pool);
          this.lastRebalanceAt = Date.now();
          await sleep(this.cfg.pollIntervalMs);
          continue;
        }

        const pos = positions[0]!;
        const cooldownPassed = Date.now() - this.lastRebalanceAt >= this.cfg.cooldownMs;

        const needsRebalance = price !== undefined && this.shouldRebalance(pos, price);

        if (needsRebalance && cooldownPassed) {
          log.info(
            {
              price,
              lower: pos.lowerPrice,
              upper: pos.upperPrice,
              base: pos.baseAmount.toString(),
              quote: pos.quoteAmount.toString(),
            },
            'rebalance triggered',
          );
          await this.rebalance(pos, price!, pool);
          this.lastRebalanceAt = Date.now();
        }

        // 2. Periodic fee claim / compound.
        if (Date.now() - this.lastFeeClaimAt >= this.cfg.feeClaimIntervalMs) {
          await this.claimAndMaybeCompound(pos, pool);
          this.lastFeeClaimAt = Date.now();
        }
      } catch (e) {
        log.warn({ err: (e as Error).message.slice(0, 200) }, 'iteration failed');
      }

      await sleep(this.cfg.pollIntervalMs);
    }
  }

  /** Decide if the position should be torn down + reopened. */
  private shouldRebalance(pos: LpPosition, price: number): boolean {
    const outOfRange =
      pos.lowerPrice !== undefined &&
      pos.upperPrice !== undefined &&
      (price < pos.lowerPrice * (1 - this.cfg.rebalanceHysteresis) ||
        price > pos.upperPrice * (1 + this.cfg.rebalanceHysteresis));

    if (this.cfg.mode === 'two-sided') return outOfRange;

    // Single-sided: also redeploy if the deployed side has fully filled
    // (converted into the other token).
    if (!this.cfg.autoRedeployOnFill) return outOfRange;
    if (this.cfg.mode === 'quote-only') {
      // Started with quote (Y); filled when quote ~ 0 and base > 0.
      const filled = pos.quoteAmount.isZero() && !pos.baseAmount.isZero();
      return outOfRange || filled;
    }
    if (this.cfg.mode === 'base-only') {
      const filled = pos.baseAmount.isZero() && !pos.quoteAmount.isZero();
      return outOfRange || filled;
    }
    return outOfRange;
  }

  private async openPosition(
    price: number,
    pool: { baseMint: PublicKey; quoteMint: PublicKey; baseDecimals: number; quoteDecimals: number },
  ): Promise<void> {
    const baseBal = await this.tokenBalance(pool.baseMint);
    const quoteBal = await this.tokenBalance(pool.quoteMint);

    let baseUse = new BN(0);
    let quoteUse = new BN(0);
    if (this.cfg.mode === 'two-sided') {
      baseUse = baseBal;
      quoteUse = quoteBal;
    } else if (this.cfg.mode === 'quote-only') {
      quoteUse = quoteBal;
    } else {
      baseUse = baseBal;
    }

    if (baseUse.isZero() && quoteUse.isZero()) {
      log.warn({ mode: this.cfg.mode }, 'no inventory available for current mode, skipping open');
      return;
    }

    if (this.cfg.dryRun) {
      log.info(
        { price, baseUse: baseUse.toString(), quoteUse: quoteUse.toString(), mode: this.cfg.mode },
        'DRY RUN open position',
      );
      return;
    }

    const built = await this.venue.buildAddLiquidity({
      poolId: this.cfg.poolId,
      user: this.cfg.wallet.publicKey,
      baseAmountMax: baseUse,
      quoteAmountMax: quoteUse,
      centerPrice: price,
      widthFraction: this.cfg.widthFraction,
      slippageBps: this.cfg.slippageBps,
      mode: this.cfg.mode,
      strategyType: this.cfg.strategyType,
      binOffset: this.cfg.binOffset,
    });
    const r = await this.deps.exec.execute(
      this.cfg.wallet,
      built.instructions,
      { computeUnitLimit: 900_000, useJito: false, maxRetries: 2 },
      built.signers ?? [],
    );
    log.info({ sig: r.signature, mode: this.cfg.mode }, 'opened position');
  }

  private async rebalance(
    pos: LpPosition,
    price: number,
    pool: { baseMint: PublicKey; quoteMint: PublicKey; baseDecimals: number; quoteDecimals: number },
  ): Promise<void> {
    if (this.cfg.dryRun) {
      log.info({ price, positionId: pos.positionId.toBase58() }, 'DRY RUN rebalance');
      return;
    }

    // 1. Claim pending fees first (cheaper than withdrawing them as inventory).
    try {
      const claim = await this.venue.claimFees({
        poolId: this.cfg.poolId,
        positionId: pos.positionId,
        owner: this.cfg.wallet.publicKey,
      });
      if (claim.instructions.length > 0) {
        await this.deps.exec.execute(this.cfg.wallet, claim.instructions, {
          computeUnitLimit: 600_000,
          useJito: false,
          maxRetries: 1,
        });
      }
    } catch (e) {
      log.debug({ err: (e as Error).message }, 'pre-rebalance fee claim skipped');
    }

    // 2. Close existing position.
    const remove = await this.venue.buildRemoveLiquidity({
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

    // 3. Inventory rebalance.
    if (this.cfg.mode === 'two-sided' && this.cfg.inventorySwapToTarget) {
      await this.balanceInventoryTwoSided(price, pool);
    } else if (this.cfg.mode !== 'two-sided' && this.cfg.autoRedeployOnFill) {
      await this.swapBackToDeployingSide(price, pool);
    }

    // 4. Reopen.
    await this.openPosition(price, pool);
  }

  private async claimAndMaybeCompound(
    pos: LpPosition,
    pool: { baseMint: PublicKey; quoteMint: PublicKey; baseDecimals: number; quoteDecimals: number },
  ): Promise<void> {
    if (this.cfg.dryRun) {
      log.info({ positionId: pos.positionId.toBase58() }, 'DRY RUN fee claim');
      return;
    }
    try {
      const claim = await this.venue.claimFees({
        poolId: this.cfg.poolId,
        positionId: pos.positionId,
        owner: this.cfg.wallet.publicKey,
      });
      if (claim.instructions.length === 0) return;
      const res = await this.deps.exec.execute(this.cfg.wallet, claim.instructions, {
        computeUnitLimit: 600_000,
        useJito: false,
        maxRetries: 2,
      });
      log.info({ sig: res.signature }, 'claimed fees');

      if (!this.cfg.compoundFees) return;

      const baseBal = await this.tokenBalance(pool.baseMint);
      const quoteBal = await this.tokenBalance(pool.quoteMint);
      // Compound nothing if both balances negligible.
      const baseDec = bnToDecimal(baseBal, pool.baseDecimals).toNumber();
      const quoteDec = bnToDecimal(quoteBal, pool.quoteDecimals).toNumber();
      if (baseDec <= 0 && quoteDec <= 0) return;

      const built = await this.venue.buildAddLiquidityToPosition({
        poolId: this.cfg.poolId,
        positionId: pos.positionId,
        user: this.cfg.wallet.publicKey,
        baseAmount: this.cfg.mode === 'quote-only' ? new BN(0) : baseBal,
        quoteAmount: this.cfg.mode === 'base-only' ? new BN(0) : quoteBal,
        strategyType: this.cfg.strategyType,
        slippageBps: this.cfg.slippageBps,
      });
      const compRes = await this.deps.exec.execute(this.cfg.wallet, built.instructions, {
        computeUnitLimit: 800_000,
        useJito: false,
        maxRetries: 2,
      });
      log.info({ sig: compRes.signature }, 'compounded fees in-place');
    } catch (e) {
      log.warn({ err: (e as Error).message.slice(0, 200) }, 'fee claim/compound failed');
    }
  }

  private async balanceInventoryTwoSided(
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
    if (Math.abs(drift) <= 0.05) return;

    const targetBaseValue = total * this.cfg.targetBaseFraction;
    const swapValue = clamp(Math.abs(targetBaseValue - baseValue), 0, total / 2);

    const jup = this.deps.venues.get('jupiter');
    if (drift > 0) {
      const baseAmt = decimalToBn(swapValue / price, pool.baseDecimals);
      const built = await jup.buildSwap({
        poolId: this.cfg.poolId,
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

  /**
   * After a fully-filled single-sided ladder, swap accumulated inventory back
   * into the side we are deploying so we can redeploy the same shape.
   */
  private async swapBackToDeployingSide(
    price: number,
    pool: { baseMint: PublicKey; quoteMint: PublicKey; baseDecimals: number; quoteDecimals: number },
  ): Promise<void> {
    const jup = this.deps.venues.get('jupiter');
    if (this.cfg.mode === 'quote-only') {
      // Convert all base back into quote.
      const baseBal = await this.tokenBalance(pool.baseMint);
      if (baseBal.isZero()) return;
      const built = await jup.buildSwap({
        poolId: this.cfg.poolId,
        inputMint: pool.baseMint,
        outputMint: pool.quoteMint,
        amountIn: baseBal,
        user: this.cfg.wallet.publicKey,
        slippageBps: this.cfg.slippageBps,
      });
      await this.execJupSwap(built);
    } else if (this.cfg.mode === 'base-only') {
      const quoteBal = await this.tokenBalance(pool.quoteMint);
      if (quoteBal.isZero()) return;
      const built = await jup.buildSwap({
        poolId: this.cfg.poolId,
        inputMint: pool.quoteMint,
        outputMint: pool.baseMint,
        amountIn: quoteBal,
        user: this.cfg.wallet.publicKey,
        slippageBps: this.cfg.slippageBps,
      });
      await this.execJupSwap(built);
    }
    // Avoid unused-variable lint.
    void price;
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
