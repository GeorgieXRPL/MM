import { Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
  type DlmmStrategyType,
  type LiquidityMode,
  type LpPosition,
  type VenueId,
  createLogger,
} from '@amm/shared';
import type { RpcManager, TxExecutor } from '@amm/core';
import type { VenueRegistry } from '@amm/venues';
import { MeteoraDlmmVenue } from '@amm/venues';

const log = createLogger('strategy:lp-manager');

/**
 * Manual LP manager. Not a long-running strategy - it's a thin convenience
 * layer the dashboard / CLI calls into for one-shot deposit / withdraw / list
 * across all CLMM-capable venues.
 */
export class LpManager {
  constructor(
    private readonly deps: {
      rpc: RpcManager;
      exec: TxExecutor;
      venues: VenueRegistry;
    },
  ) {}

  /** List all positions an owner holds across the given venues. */
  async listAllPositions(
    owner: PublicKey,
    venuesToScan: VenueId[],
    pools: { venue: VenueId; poolId: PublicKey }[],
  ): Promise<LpPosition[]> {
    const out: LpPosition[] = [];
    for (const { venue, poolId } of pools) {
      if (!venuesToScan.includes(venue)) continue;
      try {
        const v = this.deps.venues.get(venue);
        const positions = await v.getPositions(poolId, owner);
        out.push(...positions);
      } catch (e) {
        log.warn({ venue, err: (e as Error).message }, 'list positions failed');
      }
    }
    return out;
  }

  /** Simulate a deposit and return projected token amounts + fees. */
  async simulateDeposit(opts: {
    venue: VenueId;
    poolId: PublicKey;
    user: PublicKey;
    baseAmountMax: BN;
    quoteAmountMax: BN;
    centerPrice?: number;
    widthFraction?: number;
    slippageBps: number;
    mode?: LiquidityMode;
    strategyType?: DlmmStrategyType;
    binOffset?: number;
  }): Promise<{ logs: string[] }> {
    const venue = this.deps.venues.get(opts.venue);
    const built = await venue.buildAddLiquidity({
      poolId: opts.poolId,
      user: opts.user,
      baseAmountMax: opts.baseAmountMax,
      quoteAmountMax: opts.quoteAmountMax,
      centerPrice: opts.centerPrice,
      widthFraction: opts.widthFraction,
      slippageBps: opts.slippageBps,
      mode: opts.mode,
      strategyType: opts.strategyType,
      binOffset: opts.binOffset,
    });
    const { tx } = await this.deps.exec.build(opts.user, built.instructions);
    const sim = await this.deps.rpc.simulateVersioned(tx);
    if (sim.value.err) {
      throw new Error(`sim failed: ${JSON.stringify(sim.value.err)}`);
    }
    return { logs: sim.value.logs ?? [] };
  }

  /** Execute a deposit. */
  async deposit(opts: {
    venue: VenueId;
    poolId: PublicKey;
    wallet: Keypair;
    baseAmountMax: BN;
    quoteAmountMax: BN;
    centerPrice?: number;
    widthFraction?: number;
    slippageBps: number;
    mode?: LiquidityMode;
    strategyType?: DlmmStrategyType;
    binOffset?: number;
  }): Promise<string> {
    const venue = this.deps.venues.get(opts.venue);
    const built = await venue.buildAddLiquidity({
      poolId: opts.poolId,
      user: opts.wallet.publicKey,
      baseAmountMax: opts.baseAmountMax,
      quoteAmountMax: opts.quoteAmountMax,
      centerPrice: opts.centerPrice,
      widthFraction: opts.widthFraction,
      slippageBps: opts.slippageBps,
      mode: opts.mode,
      strategyType: opts.strategyType,
      binOffset: opts.binOffset,
    });
    const r = await this.deps.exec.execute(
      opts.wallet,
      built.instructions,
      { computeUnitLimit: 900_000, useJito: false, maxRetries: 2 },
      built.signers ?? [],
    );
    log.info({ venue: opts.venue, sig: r.signature }, 'deposit confirmed');
    return r.signature;
  }

  /** Claim accrued fees on a Meteora DLMM position. */
  async claimFees(opts: {
    poolId: PublicKey;
    positionId: PublicKey;
    wallet: Keypair;
  }): Promise<string> {
    const venue = this.deps.venues.get('meteora-dlmm');
    if (!(venue instanceof MeteoraDlmmVenue)) {
      throw new Error('claimFees is only supported for meteora-dlmm');
    }
    const built = await venue.claimFees({
      poolId: opts.poolId,
      positionId: opts.positionId,
      owner: opts.wallet.publicKey,
    });
    if (built.instructions.length === 0) {
      throw new Error('no fees to claim');
    }
    const r = await this.deps.exec.execute(
      opts.wallet,
      built.instructions,
      { computeUnitLimit: 600_000, useJito: false, maxRetries: 2 },
      built.signers ?? [],
    );
    log.info({ pool: opts.poolId.toBase58(), sig: r.signature }, 'fees claimed');
    return r.signature;
  }

  /** Execute a withdrawal. */
  async withdraw(opts: {
    venue: VenueId;
    positionId: PublicKey;
    wallet: Keypair;
    fraction: number;
    closePosition?: boolean;
    slippageBps: number;
  }): Promise<string> {
    const venue = this.deps.venues.get(opts.venue);
    const built = await venue.buildRemoveLiquidity({
      positionId: opts.positionId,
      user: opts.wallet.publicKey,
      fraction: opts.fraction,
      closePosition: opts.closePosition ?? false,
      slippageBps: opts.slippageBps,
    });
    const r = await this.deps.exec.execute(
      opts.wallet,
      built.instructions,
      { computeUnitLimit: 800_000, useJito: false, maxRetries: 2 },
      built.signers ?? [],
    );
    log.info({ venue: opts.venue, sig: r.signature }, 'withdraw confirmed');
    return r.signature;
  }
}
