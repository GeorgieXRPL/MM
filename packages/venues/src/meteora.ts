import { PublicKey, Keypair, type Connection } from '@solana/web3.js';
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

const log = createLogger('venue:meteora');

/**
 * Meteora DLMM adapter. Uses `@meteora-ag/dlmm@^1.9`.
 *
 * The DLMM SDK exposes `DLMM.create(connection, poolPubkey)` returning an
 * instance with `swapQuote`, `swap`, `initializePositionAndAddLiquidityByStrategy`,
 * `removeLiquidity`, `getPositionsByUserAndLbPair` etc.
 */
export type MeteoraCluster = 'mainnet-beta' | 'devnet' | 'localhost';

export class MeteoraDlmmVenue implements Venue {
  readonly id = 'meteora-dlmm' as const;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly cache = new Map<string, any>();

  /**
   * @param cluster Which DLMM program deployment to target. Defaults to
   *   `process.env.SOLANA_CLUSTER` if set, otherwise `'mainnet-beta'`.
   *   Set to `'devnet'` for testing on the devnet DLMM deployment.
   */
  constructor(
    private readonly connection: Connection,
    private readonly cluster: MeteoraCluster = (process.env.SOLANA_CLUSTER as MeteoraCluster) ||
      'mainnet-beta',
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async load(poolId: PublicKey): Promise<any> {
    const key = poolId.toBase58();
    const cached = this.cache.get(key);
    if (cached) return cached;
    const mod = await import('@meteora-ag/dlmm');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const DLMM = (mod as any).default ?? (mod as any).DLMM;
    const inst = await DLMM.create(this.connection, poolId, { cluster: this.cluster });
    this.cache.set(key, inst);
    return inst;
  }

  async getPool(
    poolId: PublicKey,
  ): Promise<PoolRef & { baseDecimals: number; quoteDecimals: number }> {
    const dlmm = await this.load(poolId);
    return {
      venue: this.id,
      poolId,
      baseMint: new PublicKey(dlmm.tokenX.publicKey ?? dlmm.tokenX.mint),
      quoteMint: new PublicKey(dlmm.tokenY.publicKey ?? dlmm.tokenY.mint),
      baseDecimals: dlmm.tokenX.mint?.decimals ?? dlmm.tokenX.decimal ?? 9,
      quoteDecimals: dlmm.tokenY.mint?.decimals ?? dlmm.tokenY.decimal ?? 9,
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
    const dlmm = await this.load(req.poolId);
    const pool = await this.getPool(req.poolId);
    const swapForY = req.inputMint.equals(pool.baseMint);
    const binArrays = await dlmm.getBinArrayForSwap(swapForY);
    const q = await dlmm.swapQuote(req.amountIn, swapForY, new BN(req.slippageBps), binArrays);
    return {
      amountIn: req.amountIn,
      amountOut: new BN(q.outAmount.toString()),
      minAmountOut: new BN(q.minOutAmount?.toString?.() ?? applySlippageDown(new BN(q.outAmount.toString()), req.slippageBps).toString()),
      priceImpactBps: Math.round((q.priceImpact?.toNumber?.() ?? 0) * 10_000),
      route: { binArrays, swapForY, quote: q },
    };
  }

  async buildSwap(req: SwapBuildRequest): Promise<BuiltSwap> {
    const dlmm = await this.load(req.poolId);
    const pool = await this.getPool(req.poolId);
    const swapForY = req.inputMint.equals(pool.baseMint);
    const route = req.quote?.route as
      | { binArrays: unknown; quote: { minOutAmount: BN } }
      | undefined;
    const binArrays =
      route?.binArrays ?? (await dlmm.getBinArrayForSwap(swapForY));

    const minOut =
      route?.quote.minOutAmount ??
      (await dlmm.swapQuote(req.amountIn, swapForY, new BN(req.slippageBps), binArrays))
        .minOutAmount;

    const tx = await dlmm.swap({
      inToken: req.inputMint,
      outToken: req.outputMint,
      inAmount: req.amountIn,
      minOutAmount: minOut,
      lbPair: req.poolId,
      user: req.user,
      binArraysPubkey: binArrays.map((b: { publicKey: PublicKey }) => b.publicKey),
    });
    return { instructions: tx.instructions };
  }

  async getPositions(poolId: PublicKey, owner: PublicKey): Promise<LpPosition[]> {
    try {
      const dlmm = await this.load(poolId);
      const { userPositions } = await dlmm.getPositionsByUserAndLbPair(owner);
      const pool = await this.getPool(poolId);
      const activeBin = await dlmm.getActiveBin();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return userPositions.map((p: any) => ({
        venue: this.id,
        poolId,
        positionId: new PublicKey(p.publicKey),
        owner,
        baseMint: pool.baseMint,
        quoteMint: pool.quoteMint,
        baseAmount: new BN(p.positionData.totalXAmount?.toString?.() ?? '0'),
        quoteAmount: new BN(p.positionData.totalYAmount?.toString?.() ?? '0'),
        lowerPrice: dlmm.fromPricePerLamport(
          dlmm.getPriceFromBinId?.(p.positionData.lowerBinId) ?? 0,
        ),
        upperPrice: dlmm.fromPricePerLamport(
          dlmm.getPriceFromBinId?.(p.positionData.upperBinId) ?? 0,
        ),
        inRange:
          p.positionData.lowerBinId <= activeBin.binId &&
          activeBin.binId <= p.positionData.upperBinId,
        feesPendingBase: new BN(p.positionData.feeX?.toString?.() ?? '0'),
        feesPendingQuote: new BN(p.positionData.feeY?.toString?.() ?? '0'),
      }));
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'meteora getPositions failed');
      return [];
    }
  }

  async buildAddLiquidity(req: AddLiquidityRequest): Promise<BuiltSwap> {
    const dlmm = await this.load(req.poolId);
    const mod = await import('@meteora-ag/dlmm');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const StrategyType = (mod as any).StrategyType;

    const mode = req.mode ?? 'two-sided';
    const stKey = req.strategyType ?? 'spot';
    const stratEnum =
      stKey === 'curve'
        ? StrategyType.Curve ?? StrategyType.BidAskBalanced ?? StrategyType.Spot
        : stKey === 'bid-ask'
          ? StrategyType.BidAsk ?? StrategyType.BidAskImBalanced ?? StrategyType.Spot
          : StrategyType.Spot;

    const activeBin = await dlmm.getActiveBin();
    const center = req.centerPrice ?? Number(activeBin.price);
    const width = req.widthFraction ?? 0.05;
    const offsetBins = Math.max(0, Math.floor(req.binOffset ?? 1));

    let lowerBinId: number;
    let upperBinId: number;
    let totalXAmount: BN;
    let totalYAmount: BN;

    if (mode === 'two-sided') {
      lowerBinId = dlmm.getBinIdFromPrice(center * (1 - width), true);
      upperBinId = dlmm.getBinIdFromPrice(center * (1 + width), false);
      totalXAmount = req.baseAmountMax;
      totalYAmount = req.quoteAmountMax;
    } else if (mode === 'quote-only') {
      // Buy ladder: bins strictly below active bin.
      if (!req.baseAmountMax.isZero()) {
        throw new Error('quote-only mode requires baseAmountMax = 0');
      }
      const lowerPriceTarget = center * (1 - width);
      lowerBinId = dlmm.getBinIdFromPrice(lowerPriceTarget, true);
      upperBinId = activeBin.binId - offsetBins;
      if (upperBinId < lowerBinId) upperBinId = lowerBinId;
      totalXAmount = new BN(0);
      totalYAmount = req.quoteAmountMax;
    } else {
      // base-only: sell ladder, bins strictly above active.
      if (!req.quoteAmountMax.isZero()) {
        throw new Error('base-only mode requires quoteAmountMax = 0');
      }
      const upperPriceTarget = center * (1 + width);
      upperBinId = dlmm.getBinIdFromPrice(upperPriceTarget, false);
      lowerBinId = activeBin.binId + offsetBins;
      if (lowerBinId > upperBinId) lowerBinId = upperBinId;
      totalXAmount = req.baseAmountMax;
      totalYAmount = new BN(0);
    }

    const positionKp = Keypair.generate();
    const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKp.publicKey,
      user: req.user,
      totalXAmount,
      totalYAmount,
      strategy: {
        maxBinId: upperBinId,
        minBinId: lowerBinId,
        strategyType: stratEnum,
      },
      slippage: req.slippageBps / 100, // SDK uses percent
    });

    return { instructions: tx.instructions, signers: [positionKp] };
  }

  /** Add liquidity to an existing position (used by fee compounding). */
  async buildAddLiquidityToPosition(opts: {
    poolId: PublicKey;
    positionId: PublicKey;
    user: PublicKey;
    baseAmount: BN;
    quoteAmount: BN;
    strategyType?: 'spot' | 'curve' | 'bid-ask';
    slippageBps: number;
  }): Promise<BuiltSwap> {
    const dlmm = await this.load(opts.poolId);
    const mod = await import('@meteora-ag/dlmm');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const StrategyType = (mod as any).StrategyType;
    const position = await dlmm.getPosition(opts.positionId);
    const lowerBinId = position.positionData.lowerBinId;
    const upperBinId = position.positionData.upperBinId;

    const stKey = opts.strategyType ?? 'spot';
    const stratEnum =
      stKey === 'curve'
        ? StrategyType.Curve ?? StrategyType.Spot
        : stKey === 'bid-ask'
          ? StrategyType.BidAsk ?? StrategyType.Spot
          : StrategyType.Spot;

    const tx = await dlmm.addLiquidityByStrategy({
      positionPubKey: opts.positionId,
      user: opts.user,
      totalXAmount: opts.baseAmount,
      totalYAmount: opts.quoteAmount,
      strategy: { maxBinId: upperBinId, minBinId: lowerBinId, strategyType: stratEnum },
      slippage: opts.slippageBps / 100,
    });
    return { instructions: tx.instructions };
  }

  /** Claim DLMM swap fees (and LM rewards if available) for a single position. */
  async claimFees(opts: {
    poolId: PublicKey;
    positionId: PublicKey;
    owner: PublicKey;
  }): Promise<BuiltSwap> {
    const dlmm = await this.load(opts.poolId);
    const position = await dlmm.getPosition(opts.positionId);
    const ixs: import('@solana/web3.js').TransactionInstruction[] = [];

    if (typeof dlmm.claimSwapFee === 'function') {
      const tx = await dlmm.claimSwapFee({ owner: opts.owner, position });
      const list = Array.isArray(tx) ? tx : [tx];
      for (const t of list) ixs.push(...(t.instructions ?? []));
    } else if (typeof dlmm.claimAllSwapFee === 'function') {
      const tx = await dlmm.claimAllSwapFee({
        owner: opts.owner,
        positions: [position],
      });
      const list = Array.isArray(tx) ? tx : [tx];
      for (const t of list) ixs.push(...(t.instructions ?? []));
    }

    if (typeof dlmm.claimLMReward === 'function') {
      try {
        const tx = await dlmm.claimLMReward({ owner: opts.owner, position });
        const list = Array.isArray(tx) ? tx : [tx];
        for (const t of list) ixs.push(...(t.instructions ?? []));
      } catch (e) {
        log.debug({ err: (e as Error).message }, 'no LM reward to claim');
      }
    }

    return { instructions: ixs };
  }

  /** Active bin price (quote per base, UI units). */
  async getActiveBinPrice(poolId: PublicKey): Promise<number> {
    const dlmm = await this.load(poolId);
    const active = await dlmm.getActiveBin();
    return Number(active.price);
  }

  /** Active bin ID (integer). */
  async getActiveBinId(poolId: PublicKey): Promise<number> {
    const dlmm = await this.load(poolId);
    const active = await dlmm.getActiveBin();
    return Number(active.binId);
  }

  /** Map a UI price to the nearest bin id (rounded down by default). */
  async getBinIdFromPrice(poolId: PublicKey, price: number, roundDown = true): Promise<number> {
    const dlmm = await this.load(poolId);
    return Number(dlmm.getBinIdFromPrice(price, roundDown));
  }

  async buildRemoveLiquidity(req: RemoveLiquidityRequest): Promise<BuiltSwap> {
    // Meteora needs the pool id, not just the position id; resolve from the position account.
    const positionInfo = await this.connection.getAccountInfo(req.positionId);
    if (!positionInfo) throw new Error('position not found');
    // The lbPair pubkey is the first 32 bytes after Anchor's 8-byte discriminator.
    const lbPair = new PublicKey(positionInfo.data.subarray(8, 40));
    const dlmm = await this.load(lbPair);
    const position = await dlmm.getPosition(req.positionId);
    const binIdsToRemove: number[] = position.positionData.positionBinData
      .map((b: { binId: number }) => b.binId);

    const txs = await dlmm.removeLiquidity({
      position: req.positionId,
      user: req.user,
      binIds: binIdsToRemove,
      bps: new BN(Math.round(req.fraction * 10_000)),
      shouldClaimAndClose: req.closePosition ?? false,
    });
    const txList = Array.isArray(txs) ? txs : [txs];
    const ixs = txList.flatMap((t) => t.instructions);
    return { instructions: ixs };
  }
}

void VenueUnsupportedError;
