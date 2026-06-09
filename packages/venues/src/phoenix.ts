import { PublicKey, type Connection } from '@solana/web3.js';
import BN from 'bn.js';
import {
  type AddLiquidityRequest,
  type BuiltSwap,
  type LpPosition,
  type PoolRef,
  type QuoteRequest,
  type QuoteResult,
  type RemoveLiquidityRequest,
  type SwapBuildRequest,
  type TokenInfo,
  applySlippageDown,
  createLogger,
} from '@amm/shared';
import { Venue, VenueUnsupportedError } from './venue.js';

const log = createLogger('venue:phoenix');

/**
 * Phoenix v2 (order-book DEX) adapter. Uses `@ellipsis-labs/phoenix-sdk`.
 *
 * Phoenix is fundamentally an order book, not an AMM. We implement the swap
 * surface for compatibility (it sweeps the book for an immediate fill) and
 * leave LP methods unsupported - the strategy layer's `ob-mm` mode talks to
 * the order-book primitives directly via this adapter's extra methods (TODO,
 * surfaced in Phase 4).
 */
export class PhoenixVenue implements Venue {
  readonly id = 'phoenix' as const;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any | null = null;

  constructor(private readonly connection: Connection) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async loadClient(): Promise<any> {
    if (this.client) return this.client;
    // The phoenix SDK is an optional peer dep - load via runtime resolution so
    // builds don't require the package to be installed up front.
    const specifier = '@ellipsis-labs/phoenix-sdk';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await (Function('s', 'return import(s)') as (s: string) => Promise<unknown>)(
      specifier,
    );
    const Client = mod.Client ?? mod.default?.Client;
    this.client = await Client.create(this.connection);
    return this.client;
  }

  async getPool(
    poolId: PublicKey,
  ): Promise<PoolRef & { baseDecimals: number; quoteDecimals: number }> {
    const c = await this.loadClient();
    const market = c.markets.get(poolId.toBase58());
    if (!market) throw new Error(`phoenix market ${poolId.toBase58()} not found`);
    return {
      venue: this.id,
      poolId,
      baseMint: new PublicKey(market.data.header.baseParams.mintKey),
      quoteMint: new PublicKey(market.data.header.quoteParams.mintKey),
      baseDecimals: market.data.header.baseParams.decimals,
      quoteDecimals: market.data.header.quoteParams.decimals,
    };
  }

  async getTokenInfo(mint: PublicKey): Promise<TokenInfo> {
    const info = await this.connection.getParsedAccountInfo(mint);
    const decimals =
      (info.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info
        ?.decimals ?? 0;
    return { mint, decimals };
  }

  async quote(req: QuoteRequest): Promise<QuoteResult> {
    const c = await this.loadClient();
    const market = c.markets.get(req.poolId.toBase58());
    if (!market) throw new Error('market not found');
    const isSell = req.inputMint.equals(new PublicKey(market.data.header.baseParams.mintKey));
    const side = isSell ? 'Ask' : 'Bid';
    const result = market.getMarketSwapTransactionUsingExactAmountIn?.({
      side,
      inAmount: req.amountIn,
      slippage: req.slippageBps / 10_000,
      trader: PublicKey.default,
    });
    const out = new BN(result?.expectedOutAmount?.toString?.() ?? '0');
    return {
      amountIn: req.amountIn,
      amountOut: out,
      minAmountOut: applySlippageDown(out, req.slippageBps),
      priceImpactBps: 0,
    };
  }

  async buildSwap(req: SwapBuildRequest): Promise<BuiltSwap> {
    const c = await this.loadClient();
    const market = c.markets.get(req.poolId.toBase58());
    if (!market) throw new Error('market not found');
    const isSell = req.inputMint.equals(new PublicKey(market.data.header.baseParams.mintKey));
    const side = isSell ? 'Ask' : 'Bid';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ix = market.getSwapInstruction?.({
      side,
      inAmount: req.amountIn,
      slippage: req.slippageBps / 10_000,
      trader: req.user,
    });
    return { instructions: ix ? [ix] : [] };
  }

  async getPositions(): Promise<LpPosition[]> {
    return [];
  }
  async buildAddLiquidity(_req: AddLiquidityRequest): Promise<BuiltSwap> {
    throw new VenueUnsupportedError(this.id, 'addLiquidity (use ob-mm strategy directly)');
  }
  async buildRemoveLiquidity(_req: RemoveLiquidityRequest): Promise<BuiltSwap> {
    throw new VenueUnsupportedError(this.id, 'removeLiquidity (use ob-mm strategy directly)');
  }

  // Order-book-specific surface, used by the Phase 4 ob-mm strategy.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getMarket(poolId: PublicKey): Promise<any> {
    const c = await this.loadClient();
    return c.markets.get(poolId.toBase58());
  }
}

void log;
