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
  type VenueId,
  applySlippageDown,
  createLogger,
} from '@amm/shared';
import { Venue, VenueUnsupportedError } from './venue.js';

const log = createLogger('venue:raydium');

export enum RaydiumPoolKind {
  AmmV4 = 'amm-v4',
  Cpmm = 'cpmm',
  Clmm = 'clmm',
}

/**
 * Raydium adapter (covers AMM v4, CPMM, and CLMM via the unified
 * `@raydium-io/raydium-sdk-v2` package). Implementation is structured around
 * the SDK's `raydium.cpmm.*`, `raydium.amm.*`, `raydium.clmm.*` namespaces.
 *
 * The lazy-init pattern keeps SDK construction out of the venue constructor
 * so we don't pay the wallet/owner setup cost until a method actually runs.
 */
export class RaydiumVenue implements Venue {
  readonly id: VenueId;

  // The Raydium SDK retains owner state internally for ATA derivation and
  // ATA-creation instructions in built swaps. A single cached instance
  // shared across owners would silently embed the first owner into every
  // subsequent owner's tx (the first call is typically `getPool` from a
  // strategy warmup, with `owner=undefined` -> SDK builds anonymous swaps
  // missing the user's ATA). Cache per-owner instead.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly sdkCache = new Map<string, any>();

  constructor(
    private readonly connection: Connection,
    private readonly kind: RaydiumPoolKind,
  ) {
    this.id =
      kind === RaydiumPoolKind.AmmV4
        ? 'raydium-amm-v4'
        : kind === RaydiumPoolKind.Cpmm
          ? 'raydium-cpmm'
          : 'raydium-clmm';
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async loadSdk(owner?: PublicKey): Promise<any> {
    const ownerKey = owner ? owner.toBase58() : '__no_owner__';
    const cached = this.sdkCache.get(ownerKey);
    if (cached) return cached;
    const mod = await import('@raydium-io/raydium-sdk-v2');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Raydium = (mod as any).Raydium;
    const sdk = await Raydium.load({
      connection: this.connection,
      owner,
      disableLoadToken: true,
    });
    this.sdkCache.set(ownerKey, sdk);
    return sdk;
  }

  async getPool(
    poolId: PublicKey,
  ): Promise<PoolRef & { baseDecimals: number; quoteDecimals: number }> {
    const sdk = await this.loadSdk();
    let baseMint: PublicKey;
    let quoteMint: PublicKey;
    let baseDecimals = 9;
    let quoteDecimals = 9;

    if (this.kind === RaydiumPoolKind.Clmm) {
      const info = await sdk.clmm.getPoolInfoFromRpc(poolId.toBase58());
      baseMint = new PublicKey(info.poolInfo.mintA.address);
      quoteMint = new PublicKey(info.poolInfo.mintB.address);
      baseDecimals = info.poolInfo.mintA.decimals;
      quoteDecimals = info.poolInfo.mintB.decimals;
    } else if (this.kind === RaydiumPoolKind.Cpmm) {
      const info = await sdk.cpmm.getPoolInfoFromRpc(poolId.toBase58());
      baseMint = new PublicKey(info.poolInfo.mintA.address);
      quoteMint = new PublicKey(info.poolInfo.mintB.address);
      baseDecimals = info.poolInfo.mintA.decimals;
      quoteDecimals = info.poolInfo.mintB.decimals;
    } else {
      const info = await sdk.liquidity.getPoolInfoFromRpc({ poolId: poolId.toBase58() });
      baseMint = new PublicKey(info.poolInfo.mintA.address);
      quoteMint = new PublicKey(info.poolInfo.mintB.address);
      baseDecimals = info.poolInfo.mintA.decimals;
      quoteDecimals = info.poolInfo.mintB.decimals;
    }

    return {
      venue: this.id,
      poolId,
      baseMint,
      quoteMint,
      baseDecimals,
      quoteDecimals,
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
    const sdk = await this.loadSdk();
    const pool = await this.getPool(req.poolId);
    const inIsBase = req.inputMint.equals(pool.baseMint);

    let amountOut: BN;
    if (this.kind === RaydiumPoolKind.Clmm) {
      const info = await sdk.clmm.getPoolInfoFromRpc(req.poolId.toBase58());
      const r = sdk.clmm.computeAmountOutFormat({
        poolInfo: info.poolInfo,
        tickArrayCache: info.tickData,
        amountIn: req.amountIn,
        tokenOut: inIsBase ? info.poolInfo.mintB : info.poolInfo.mintA,
        slippage: req.slippageBps / 10_000,
        epochInfo: await this.connection.getEpochInfo(),
      });
      amountOut = new BN(r.amountOut.amount.raw.toString());
    } else if (this.kind === RaydiumPoolKind.Cpmm) {
      const info = await sdk.cpmm.getPoolInfoFromRpc(req.poolId.toBase58());
      const r = sdk.cpmm.computeAmountOut({
        poolInfo: info.poolInfo,
        amountIn: req.amountIn,
        baseIn: inIsBase,
        slippage: req.slippageBps / 10_000,
      });
      amountOut = new BN(r.amountOut.toString());
    } else {
      const info = await sdk.liquidity.getPoolInfoFromRpc({ poolId: req.poolId.toBase58() });
      const r = sdk.liquidity.computeAmountOut({
        poolInfo: info.poolInfo,
        amountIn: req.amountIn,
        mintIn: req.inputMint,
        mintOut: req.outputMint,
        slippage: req.slippageBps / 10_000,
      });
      amountOut = new BN(r.amountOut.toString());
    }

    return {
      amountIn: req.amountIn,
      amountOut,
      minAmountOut: applySlippageDown(amountOut, req.slippageBps),
      priceImpactBps: 0,
    };
  }

  async buildSwap(req: SwapBuildRequest): Promise<BuiltSwap> {
    const sdk = await this.loadSdk(req.user);
    const pool = await this.getPool(req.poolId);
    const inIsBase = req.inputMint.equals(pool.baseMint);

    // Resolve the minimum acceptable output. If the caller did not pre-quote,
    // do it here rather than fall back to `applySlippageDown(amountIn, ...)`,
    // which is nonsensical for an output minimum (slippage applies to output,
    // not input) and would either fail or expose the swap to unprotected prices.
    const amountOutMin = (req.quote ?? (await this.quote(req))).minAmountOut;

    // The raydium-sdk-v2 swap builders return `{ transaction, builder, ... }`.
    // We extract the raw instructions to plug into our executor's CU + tip pipeline.
    let result: { builder?: { allInstructions: import('@solana/web3.js').TransactionInstruction[] } };

    if (this.kind === RaydiumPoolKind.Clmm) {
      const info = await sdk.clmm.getPoolInfoFromRpc(req.poolId.toBase58());
      result = await sdk.clmm.swap({
        poolInfo: info.poolInfo,
        poolKeys: info.poolKeys,
        amountIn: req.amountIn,
        amountOutMin,
        otherAmountThreshold: amountOutMin,
        priceLimit: undefined,
        observationId: info.poolInfo.observationId,
        ownerInfo: { useSOLBalance: true },
        remainingAccounts: info.computeBudgetConfig?.remainingAccounts ?? [],
        inputMint: req.inputMint,
        txVersion: 0,
      });
    } else if (this.kind === RaydiumPoolKind.Cpmm) {
      const info = await sdk.cpmm.getPoolInfoFromRpc(req.poolId.toBase58());
      result = await sdk.cpmm.swap({
        poolInfo: info.poolInfo,
        poolKeys: info.poolKeys,
        inputAmount: req.amountIn,
        baseIn: inIsBase,
        slippage: req.slippageBps / 10_000,
        txVersion: 0,
      });
    } else {
      const info = await sdk.liquidity.getPoolInfoFromRpc({ poolId: req.poolId.toBase58() });
      result = await sdk.liquidity.swap({
        poolInfo: info.poolInfo,
        poolKeys: info.poolKeys,
        amountIn: req.amountIn,
        amountOut: amountOutMin,
        fixedSide: 'in',
        inputMint: req.inputMint.toBase58(),
        txVersion: 0,
      });
    }

    return { instructions: result.builder?.allInstructions ?? [] };
  }

  async getPositions(poolId: PublicKey, owner: PublicKey): Promise<LpPosition[]> {
    if (this.kind !== RaydiumPoolKind.Clmm) {
      // AMM v4 + CPMM are full-range LP tokens; skip listing for now.
      return [];
    }
    try {
      const sdk = await this.loadSdk(owner);
      const positions = await sdk.clmm.getOwnerPositionInfo({ programId: undefined });
      const pool = await this.getPool(poolId);
      return positions
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((p: any) => p.poolId === poolId.toBase58())
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((p: any) => ({
          venue: this.id,
          poolId,
          positionId: new PublicKey(p.nftMint),
          owner,
          baseMint: pool.baseMint,
          quoteMint: pool.quoteMint,
          baseAmount: new BN(p.amountA?.toString?.() ?? '0'),
          quoteAmount: new BN(p.amountB?.toString?.() ?? '0'),
          lowerPrice: p.priceLower?.toNumber?.(),
          upperPrice: p.priceUpper?.toNumber?.(),
          inRange: p.tickLower <= p.tickCurrent && p.tickCurrent <= p.tickUpper,
        }));
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'raydium getPositions failed');
      return [];
    }
  }

  async buildAddLiquidity(req: AddLiquidityRequest): Promise<BuiltSwap> {
    if (this.kind !== RaydiumPoolKind.Clmm) {
      throw new VenueUnsupportedError(
        this.id,
        'addLiquidity (only CLMM range positions are wired up; use raydium.cpmm.addLiquidity directly for full-range)',
      );
    }
    const sdk = await this.loadSdk(req.user);
    const info = await sdk.clmm.getPoolInfoFromRpc(req.poolId.toBase58());
    const center = req.centerPrice ?? info.poolInfo.price;
    const width = req.widthFraction ?? 0.05;
    const lowerPrice = center * (1 - width);
    const upperPrice = center * (1 + width);

    const result = await sdk.clmm.openPositionFromBase({
      poolInfo: info.poolInfo,
      poolKeys: info.poolKeys,
      tickLower: sdk.clmm.utils.getTickFromPrice({ price: lowerPrice, ...info.poolInfo }),
      tickUpper: sdk.clmm.utils.getTickFromPrice({ price: upperPrice, ...info.poolInfo }),
      base: 'MintA',
      baseAmount: req.baseAmountMax,
      otherAmountMax: req.quoteAmountMax,
      ownerInfo: { useSOLBalance: true },
      txVersion: 0,
    });
    return { instructions: result.builder?.allInstructions ?? [] };
  }

  async buildRemoveLiquidity(req: RemoveLiquidityRequest): Promise<BuiltSwap> {
    if (this.kind !== RaydiumPoolKind.Clmm) {
      throw new VenueUnsupportedError(this.id, 'removeLiquidity');
    }
    const sdk = await this.loadSdk(req.user);
    const positions = await sdk.clmm.getOwnerPositionInfo({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pos = positions.find((p: any) => p.nftMint === req.positionId.toBase58());
    if (!pos) throw new Error(`position ${req.positionId.toBase58()} not found`);

    const info = await sdk.clmm.getPoolInfoFromRpc(pos.poolId);
    const liquidity = new BN(pos.liquidity.toString())
      .muln(Math.round(req.fraction * 10_000))
      .divn(10_000);

    const result = await sdk.clmm.decreaseLiquidity({
      poolInfo: info.poolInfo,
      poolKeys: info.poolKeys,
      ownerPosition: pos,
      ownerInfo: { useSOLBalance: true, closePosition: req.closePosition ?? false },
      liquidity,
      amountMinA: new BN(0),
      amountMinB: new BN(0),
      txVersion: 0,
    });
    return { instructions: result.builder?.allInstructions ?? [] };
  }
}
