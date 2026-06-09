import type { PublicKey, Keypair, TransactionInstruction } from '@solana/web3.js';
import type BN from 'bn.js';

/** Identifier for any supported DEX/protocol. */
export type VenueId =
  | 'pumpswap'
  | 'raydium-amm-v4'
  | 'raydium-cpmm'
  | 'raydium-clmm'
  | 'orca-whirlpools'
  | 'meteora-dlmm'
  | 'phoenix'
  | 'jupiter';

export type StrategyId =
  | 'volume'
  | 'clmm-mm'
  | 'ob-mm'
  | 'lp-manager'
  | 'meteora-lp'
  | 'inventory-rebalance'
  | 'counter-momentum';

/** Liquidity deployment mode. Single-sided modes are only supported by venues
 * that natively allow one-asset deposits (e.g. Meteora DLMM). Two-sided is the
 * default for backward-compat with existing AMM/CLMM venues. */
export type LiquidityMode = 'two-sided' | 'quote-only' | 'base-only';

/** DLMM bin distribution shape. Spot = uniform, Curve = bell-shaped centered
 * on active bin, BidAsk = barbell biased toward range edges. */
export type DlmmStrategyType = 'spot' | 'curve' | 'bid-ask';

export interface TokenInfo {
  mint: PublicKey;
  decimals: number;
  symbol?: string;
  programId?: PublicKey;
}

export interface PoolRef {
  venue: VenueId;
  poolId: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
}

export type SwapSide = 'buy' | 'sell';

export interface QuoteRequest {
  poolId: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  /** raw amount of input token (atomic units). */
  amountIn: BN;
  /** Slippage in basis points (e.g. 50 = 0.50%). */
  slippageBps: number;
}

export interface QuoteResult {
  /** raw amount of input token (atomic units). */
  amountIn: BN;
  /** expected raw amount of output token (atomic units). */
  amountOut: BN;
  /** worst-case raw amount of output token after slippage (atomic units). */
  minAmountOut: BN;
  /** price impact in basis points. */
  priceImpactBps: number;
  /** opaque venue-specific routing data, passed back into swap(). */
  route?: unknown;
}

export interface SwapBuildRequest extends QuoteRequest {
  user: PublicKey;
  /** Optional precomputed quote (saves a roundtrip). */
  quote?: QuoteResult;
}

export interface BuiltSwap {
  instructions: TransactionInstruction[];
  /** Additional signers required (e.g. ephemeral keypairs for swap accounts). */
  signers?: Keypair[];
  /** Address lookup tables to use, if any (legacy tx supported when empty). */
  addressLookupTables?: PublicKey[];
}

// LP types ----------------------------------------------------------

export interface LpPosition {
  venue: VenueId;
  poolId: PublicKey;
  positionId: PublicKey;
  owner: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  /** raw atomic amount of base in the position. */
  baseAmount: BN;
  /** raw atomic amount of quote in the position. */
  quoteAmount: BN;
  /** Lower price (quote per base) of the range. undefined for full-range/AMM. */
  lowerPrice?: number;
  /** Upper price (quote per base) of the range. undefined for full-range/AMM. */
  upperPrice?: number;
  /** Whether the current pool price is inside the range. */
  inRange: boolean;
  /** Pending fees claimable. */
  feesPendingBase?: BN;
  feesPendingQuote?: BN;
}

export interface AddLiquidityRequest {
  poolId: PublicKey;
  user: PublicKey;
  baseAmountMax: BN;
  quoteAmountMax: BN;
  /** Range center, expressed as price (quote per base). undefined for full-range AMM. */
  centerPrice?: number;
  /** Range width as a fraction of centerPrice (e.g. 0.05 = +/-5%). */
  widthFraction?: number;
  slippageBps: number;
  /** Deployment mode. Default 'two-sided'. Single-sided modes only supported by
   *  Meteora DLMM today. quote-only places bins below active (buy ladder),
   *  base-only places bins above active (sell ladder). */
  mode?: LiquidityMode;
  /** DLMM-only: bin distribution shape. Default 'spot'. */
  strategyType?: DlmmStrategyType;
  /** Single-sided only: gap (in bins) from active bin before the position
   *  starts. Default 1. Larger offsets keep the position out-of-range until
   *  price moves further. */
  binOffset?: number;
}

export interface RemoveLiquidityRequest {
  positionId: PublicKey;
  user: PublicKey;
  /** Fraction to remove [0..1]. 1 = remove all. */
  fraction: number;
  /** Whether to also close the position account (CLMM only). */
  closePosition?: boolean;
  slippageBps: number;
}

// Tx execution types ------------------------------------------------

export interface ExecuteOptions {
  /** Priority fee in micro-lamports per CU. If omitted, manager will estimate. */
  priorityMicroLamports?: number;
  /** Compute unit limit. If omitted, manager will simulate. */
  computeUnitLimit?: number;
  /** Skip preflight simulation. */
  skipPreflight?: boolean;
  /** If true, bundle through Jito for atomic execution + tip. */
  useJito?: boolean;
  /** Override tip in lamports. */
  jitoTipLamports?: number;
  /** Max retries on transient errors. */
  maxRetries?: number;
}

export interface ExecuteResult {
  signature: string;
  slot?: number;
  /** True if confirmed. False if best-effort send only. */
  confirmed: boolean;
}
