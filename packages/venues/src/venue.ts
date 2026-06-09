import type { PublicKey } from '@solana/web3.js';
import type {
  AddLiquidityRequest,
  BuiltSwap,
  LpPosition,
  PoolRef,
  QuoteRequest,
  QuoteResult,
  RemoveLiquidityRequest,
  SwapBuildRequest,
  TokenInfo,
  VenueId,
} from '@amm/shared';

/**
 * Common interface every DEX adapter implements.
 *
 * Methods that aren't applicable to a venue (e.g. addLiquidity on Jupiter, or
 * order-book quoting on an AMM) throw `VenueUnsupportedError`.
 */
export interface Venue {
  readonly id: VenueId;

  /** Resolve pool metadata. */
  getPool(poolId: PublicKey): Promise<PoolRef & { baseDecimals: number; quoteDecimals: number }>;

  /** Token metadata for a mint. */
  getTokenInfo(mint: PublicKey): Promise<TokenInfo>;

  /** Get a quote (no on-chain side effects). */
  quote(req: QuoteRequest): Promise<QuoteResult>;

  /** Build a signed-or-unsigned set of instructions to execute the swap. */
  buildSwap(req: SwapBuildRequest): Promise<BuiltSwap>;

  /** List the user's positions in the pool. AMMs return [] or a single full-range entry. */
  getPositions(poolId: PublicKey, owner: PublicKey): Promise<LpPosition[]>;

  /** Add liquidity. Throws VenueUnsupportedError on order-book / aggregator venues. */
  buildAddLiquidity(req: AddLiquidityRequest): Promise<BuiltSwap>;

  /** Remove liquidity. Throws on unsupported venues. */
  buildRemoveLiquidity(req: RemoveLiquidityRequest): Promise<BuiltSwap>;
}

export class VenueUnsupportedError extends Error {
  constructor(venue: VenueId, op: string) {
    super(`venue ${venue} does not support ${op}`);
    this.name = 'VenueUnsupportedError';
  }
}
