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
import { Venue } from './venue.js';

const log = createLogger('venue:orca');

/**
 * Orca Whirlpools (CLMM) adapter.
 *
 * Uses the legacy `@orca-so/whirlpools-sdk` (web3.js v1 compatible). The newer
 * `@orca-so/whirlpools` Rust-bindings package targets web3.js v2 which we're
 * not on yet.
 */
export class OrcaVenue implements Venue {
  readonly id = 'orca-whirlpools' as const;

  // The Orca SDK's WhirlpoolContext binds a wallet at construction time and
  // that wallet's public key is what pool.swap / openPosition / etc. embed
  // into the resulting instructions. Caching one ctx across owners would
  // mean the first owner (typically `PublicKey.default` from a `getPool`
  // warmup) leaks into every subsequent owner's tx, producing instructions
  // the real keypair cannot sign for. Cache per-owner instead.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly ctxCache = new Map<string, { ctx: any; client: any; sdk: any }>();

  constructor(private readonly connection: Connection) {}

  private async loadCtx(
    owner?: PublicKey,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ ctx: any; client: any; sdk: any }> {
    const ownerKey = (owner ?? PublicKey.default).toBase58();
    const cached = this.ctxCache.get(ownerKey);
    if (cached) return cached;

    // `@orca-so/whirlpools-sdk` v0.13.21 ships a malformed IDL: it lists
    // `AdaptiveFeeTier` as an account but does not include the corresponding
    // struct in `idl.types`. Anchor v0.31.x's stricter `BorshAccountsCoder`
    // throws `Account not found: AdaptiveFeeTier` at module-load time, which
    // would crash the whole strategy loop the first time anyone selects
    // Orca on the dashboard. Catch it here and surface a typed error so the
    // orchestrator/UI can degrade gracefully (the rest of the system - all
    // other venues, the volume strategy on Jupiter, sub-wallet funding,
    // etc. - keeps working).
    let sdk: typeof import('@orca-so/whirlpools-sdk');
    try {
      sdk = await import('@orca-so/whirlpools-sdk');
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      log.error(
        { err: msg },
        'failed to load @orca-so/whirlpools-sdk - venue disabled (likely IDL/anchor mismatch upstream)',
      );
      throw new Error(
        `OrcaVenue unavailable: ${msg}. ` +
          `This is an upstream incompatibility between @orca-so/whirlpools-sdk@0.13.21 ` +
          `and @coral-xyz/anchor@0.31.x. Pick a different venue or upgrade the SDK.`,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { WhirlpoolContext, ORCA_WHIRLPOOL_PROGRAM_ID, buildWhirlpoolClient } = sdk as any;
    // The wallet is irrelevant for read paths; pass a dummy for context build.
    const wallet = {
      publicKey: owner ?? PublicKey.default,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      signTransaction: async (t: never) => t,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      signAllTransactions: async (t: never) => t,
    };
    const ctx = WhirlpoolContext.from(this.connection, wallet, ORCA_WHIRLPOOL_PROGRAM_ID);
    const client = buildWhirlpoolClient(ctx);
    const entry = { ctx, client, sdk };
    this.ctxCache.set(ownerKey, entry);
    return entry;
  }

  async getPool(
    poolId: PublicKey,
  ): Promise<PoolRef & { baseDecimals: number; quoteDecimals: number }> {
    const { client } = await this.loadCtx();
    const pool = await client.getPool(poolId);
    const data = pool.getData();
    return {
      venue: this.id,
      poolId,
      baseMint: data.tokenMintA,
      quoteMint: data.tokenMintB,
      baseDecimals: pool.getTokenAInfo().decimals,
      quoteDecimals: pool.getTokenBInfo().decimals,
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
    const { ctx, client, sdk } = await this.loadCtx();
    const pool = await client.getPool(req.poolId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { swapQuoteByInputToken } = sdk as any;
    const quote = await swapQuoteByInputToken(
      pool,
      req.inputMint,
      req.amountIn,
      req.slippageBps,
      ctx.program.programId,
      ctx.fetcher,
      true,
    );
    return {
      amountIn: req.amountIn,
      amountOut: new BN(quote.estimatedAmountOut.toString()),
      minAmountOut: new BN(quote.otherAmountThreshold.toString()),
      priceImpactBps: 0,
      route: { quote, pool },
    };
  }

  async buildSwap(req: SwapBuildRequest): Promise<BuiltSwap> {
    const { client } = await this.loadCtx(req.user);
    const pool = await client.getPool(req.poolId);
    const route = req.quote?.route as { quote?: unknown } | undefined;
    const quote =
      route?.quote ??
      (await this.quote(req).then((q) => (q.route as { quote: unknown }).quote));
    const tx = await pool.swap(quote);
    // The orca SDK's TransactionBuilder exposes an internal instruction list.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ixs = ((tx as any).compressIx?.(true)?.instructions ??
      (tx as { instructions?: unknown[] }).instructions ??
      []) as import('@solana/web3.js').TransactionInstruction[];
    return { instructions: ixs };
  }

  async getPositions(poolId: PublicKey, owner: PublicKey): Promise<LpPosition[]> {
    try {
      const entry = await this.loadCtx(owner);
      const { client, sdk } = entry;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { PoolUtil, PriceMath } = sdk as any;
      const pool = await client.getPool(poolId);
      const data = pool.getData();
      // Find positions by scanning owner's token accounts for whirlpool position NFTs.
      // The SDK exposes a `getPositions(owner)` helper on newer versions; otherwise
      // use the underlying fetcher.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const positions = (await (client as any).getPositions?.(owner)) ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return positions.map((p: any) => {
        const pData = p.getData();
        const tickCurrent = data.tickCurrentIndex;
        const inRange = pData.tickLowerIndex <= tickCurrent && tickCurrent <= pData.tickUpperIndex;
        const lowerPrice = PriceMath.tickIndexToPrice(
          pData.tickLowerIndex,
          pool.getTokenAInfo().decimals,
          pool.getTokenBInfo().decimals,
        ).toNumber();
        const upperPrice = PriceMath.tickIndexToPrice(
          pData.tickUpperIndex,
          pool.getTokenAInfo().decimals,
          pool.getTokenBInfo().decimals,
        ).toNumber();
        const amounts = PoolUtil.getTokenAmountsFromLiquidity(
          pData.liquidity,
          data.sqrtPrice,
          PriceMath.tickIndexToSqrtPriceX64(pData.tickLowerIndex),
          PriceMath.tickIndexToSqrtPriceX64(pData.tickUpperIndex),
          true,
        );
        return {
          venue: this.id,
          poolId,
          positionId: p.getAddress(),
          owner,
          baseMint: data.tokenMintA,
          quoteMint: data.tokenMintB,
          baseAmount: new BN(amounts.tokenA.toString()),
          quoteAmount: new BN(amounts.tokenB.toString()),
          lowerPrice,
          upperPrice,
          inRange,
        };
      });
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'orca getPositions failed');
      return [];
    }
  }

  async buildAddLiquidity(req: AddLiquidityRequest): Promise<BuiltSwap> {
    const { client, sdk } = await this.loadCtx(req.user);
    const pool = await client.getPool(req.poolId);
    const data = pool.getData();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { PriceMath, increaseLiquidityQuoteByInputToken, TickUtil } = sdk as any;
    const center = req.centerPrice ?? PriceMath.sqrtPriceX64ToPrice(
      data.sqrtPrice,
      pool.getTokenAInfo().decimals,
      pool.getTokenBInfo().decimals,
    ).toNumber();
    const width = req.widthFraction ?? 0.05;
    const tickLower = TickUtil.getInitializableTickIndex(
      PriceMath.priceToTickIndex(
        center * (1 - width),
        pool.getTokenAInfo().decimals,
        pool.getTokenBInfo().decimals,
      ),
      data.tickSpacing,
    );
    const tickUpper = TickUtil.getInitializableTickIndex(
      PriceMath.priceToTickIndex(
        center * (1 + width),
        pool.getTokenAInfo().decimals,
        pool.getTokenBInfo().decimals,
      ),
      data.tickSpacing,
    );
    const quote = increaseLiquidityQuoteByInputToken(
      data.tokenMintA,
      req.baseAmountMax,
      tickLower,
      tickUpper,
      req.slippageBps,
      pool,
    );
    const { positionMint, tx } = await pool.openPosition(tickLower, tickUpper, quote);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const built: any = await tx.build();
    return { instructions: built.transaction.instructions, signers: built.signers ?? [] };
  }

  async buildRemoveLiquidity(req: RemoveLiquidityRequest): Promise<BuiltSwap> {
    const { client, sdk } = await this.loadCtx(req.user);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { decreaseLiquidityQuoteByLiquidity } = sdk as any;
    const position = await client.getPosition(req.positionId);
    const data = position.getData();
    const liquidity = new BN(data.liquidity.toString())
      .muln(Math.round(req.fraction * 10_000))
      .divn(10_000);

    const pool = await client.getPool(data.whirlpool);
    const quote = decreaseLiquidityQuoteByLiquidity(liquidity, req.slippageBps, position, pool);

    // Build the decrease tx and extract its instructions + signers up front.
    // We can't compose decrease + close into one TransactionBuilder reliably:
    // `pool.closePosition` returns a TransactionBuilder in newer SDK
    // versions and a TransactionBuilder[] in older ones, and
    // TransactionBuilder.addInstruction expects a `BuilderInstruction`
    // shape, not a flat instruction array. Build each separately and
    // concatenate the resulting instructions/signers.
    const decreaseTx = await position.decreaseLiquidity(quote);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const decreaseBuilt: any = await decreaseTx.build();
    const ixs: import('@solana/web3.js').TransactionInstruction[] = [
      ...(decreaseBuilt.transaction?.instructions ?? []),
    ];
    const signers: import('@solana/web3.js').Signer[] = [...(decreaseBuilt.signers ?? [])];

    if (req.closePosition) {
      const closeRaw = await pool.closePosition(req.positionId, req.slippageBps);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const closeBuilders: any[] = Array.isArray(closeRaw) ? closeRaw : [closeRaw];
      for (const builder of closeBuilders) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const built: any = await builder.build();
        ixs.push(...(built.transaction?.instructions ?? []));
        if (built.signers) signers.push(...built.signers);
      }
    }

    return {
      instructions: ixs,
      signers: signers as import('@solana/web3.js').Keypair[],
    };
  }
}

void applySlippageDown;
