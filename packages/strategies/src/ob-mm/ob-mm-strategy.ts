import { Keypair, PublicKey } from '@solana/web3.js';
import { createLogger, sleep } from '@amm/shared';
import type { RpcManager, Store, TxExecutor } from '@amm/core';
import type { VenueRegistry } from '@amm/venues';
import { PhoenixVenue } from '@amm/venues';
import type { StrategyHandle } from '../strategy.js';
import { asQuote, VolatilityEstimator, type AsParams } from './avellaneda-stoikov.js';

const log = createLogger('strategy:ob-mm');

export interface ObMmConfig {
  /** Phoenix market pubkey. */
  marketId: PublicKey;
  /** LP wallet (must hold base + quote inventory + already-seated trader on phoenix). */
  wallet: Keypair;

  /** Avellaneda-Stoikov params. */
  asParams: AsParams;

  /** Number of order pairs (each side) to layer. */
  layers?: number;
  /** Spacing between layers, in fraction of mid (e.g. 0.001 = 10bps). */
  layerSpacing?: number;
  /** Per-layer order size, in base units. */
  layerSize?: number;
  /** Quote refresh interval, ms. */
  refreshMs?: number;

  /** Hard floor on spread (in fraction of mid). Avoids zero/negative spread artifacts. */
  minSpreadFraction?: number;

  /** Inventory target in base units (used for skew). */
  inventoryTarget?: number;

  dryRun?: boolean;
}

const DEFAULTS = {
  layers: 3,
  layerSpacing: 0.0015,
  layerSize: 0.1,
  refreshMs: 5_000,
  minSpreadFraction: 0.0008,
  inventoryTarget: 0,
  dryRun: false,
};

/**
 * Phoenix order-book market-maker.
 *
 *   loop:
 *     1. fetch top-of-book mid from phoenix
 *     2. push to vol estimator
 *     3. fetch current inventory
 *     4. compute AS reservation + spread
 *     5. cancel all open orders, post new layered bids/asks
 *     6. sleep refreshMs
 *
 * The Phoenix SDK exposes `placeLimitOrderInstruction`,
 * `cancelAllMemoryOrdersInstruction`, etc. We call them through the adapter's
 * `getMarket()` extension.
 */
export class ObMmStrategy implements StrategyHandle {
  readonly id = 'ob-mm' as const;
  private running = false;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;
  private startedAt = 0;
  private readonly volEst: VolatilityEstimator;

  private readonly cfg: Required<Omit<ObMmConfig, 'wallet' | 'marketId' | 'asParams'>> & {
    wallet: Keypair;
    marketId: PublicKey;
    asParams: AsParams;
  };

  constructor(
    public readonly runId: number,
    cfg: ObMmConfig,
    private readonly deps: {
      rpc: RpcManager;
      exec: TxExecutor;
      venues: VenueRegistry;
      store: Store;
    },
  ) {
    this.cfg = { ...DEFAULTS, ...cfg } as never;
    this.volEst = new VolatilityEstimator(48, this.cfg.refreshMs);
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.startedAt = Date.now();
    log.info({ runId: this.runId, market: this.cfg.marketId.toBase58() }, 'ob-mm starting');
    this.loopPromise = this.loop().catch((e) => {
      log.error({ err: (e as Error).message }, 'ob-mm crashed');
      this.deps.store.stopRun(this.runId, 'errored', (e as Error).message);
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.loopPromise) await this.loopPromise;
    this.running = false;
    this.deps.store.stopRun(this.runId, 'stopped');
  }

  private async loop(): Promise<void> {
    const phoenix = this.deps.venues.get('phoenix') as PhoenixVenue;
    const market = await phoenix.getMarket(this.cfg.marketId);
    if (!market) {
      throw new Error(`phoenix market ${this.cfg.marketId.toBase58()} not loaded`);
    }

    while (!this.stopRequested) {
      try {
        // 1. Mid from L2.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ladder = (market as any).getUiLadder?.(1);
        const bid = ladder?.bids?.[0]?.priceInTicks ?? ladder?.bids?.[0]?.price;
        const ask = ladder?.asks?.[0]?.priceInTicks ?? ladder?.asks?.[0]?.price;
        const mid = bid && ask ? (Number(bid) + Number(ask)) / 2 : undefined;
        if (!mid) {
          log.warn('no mid; skipping');
          await sleep(this.cfg.refreshMs);
          continue;
        }
        this.volEst.push(mid);
        const sigma = this.volEst.sigmaPerSecond();

        // 2. Inventory in base units.
        const inventory = await this.getInventory(market);
        const inventoryDeviation = inventory - this.cfg.inventoryTarget;

        // 3. AS quotes.
        const t = (Date.now() - this.startedAt) / 1000 / (this.cfg.asParams.T * 86400);
        const quote = asQuote(this.cfg.asParams, {
          mid,
          inventory: inventoryDeviation,
          sigma,
          t: Math.min(0.99, t),
        });

        const minHalfSpread = (mid * this.cfg.minSpreadFraction) / 2;
        const halfSpread = Math.max(quote.spread / 2, minHalfSpread);
        const baseBid = quote.reservation - halfSpread;
        const baseAsk = quote.reservation + halfSpread;

        if (this.cfg.dryRun) {
          log.info(
            {
              mid,
              sigma: +sigma.toExponential(2),
              inv: inventory,
              bid: +baseBid.toFixed(6),
              ask: +baseAsk.toFixed(6),
            },
            'DRY RUN quote',
          );
        } else {
          await this.refreshOrders(market, baseBid, baseAsk);
        }
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'iteration failed');
      }
      await sleep(this.cfg.refreshMs);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getInventory(market: any): Promise<number> {
    try {
      // Phoenix tracks "trader state" with base/quote free + locked.
      const state = await market.getTraderState?.(this.cfg.wallet.publicKey);
      const base = Number(state?.baseLotsFree ?? 0) + Number(state?.baseLotsLocked ?? 0);
      const baseLotsToUnits =
        Number(market.data?.header?.baseLotSize ?? 1) /
        Math.pow(10, market.data?.header?.baseParams?.decimals ?? 0);
      return base * baseLotsToUnits;
    } catch {
      return 0;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async refreshOrders(market: any, bid: number, ask: number): Promise<void> {
    const ixs: import('@solana/web3.js').TransactionInstruction[] = [];
    // Cancel all existing orders.
    if (typeof market.createCancelAllOrdersInstruction === 'function') {
      ixs.push(market.createCancelAllOrdersInstruction(this.cfg.wallet.publicKey));
    }

    // Layer N orders on each side.
    for (let i = 0; i < this.cfg.layers; i++) {
      const skew = 1 + i * this.cfg.layerSpacing;
      const layerBid = bid / skew;
      const layerAsk = ask * skew;

      const placeBid = market.getLimitOrderInstruction?.({
        side: 'Bid',
        price: layerBid,
        sizeInBaseUnits: this.cfg.layerSize,
        trader: this.cfg.wallet.publicKey,
        clientOrderId: i + 1,
      });
      const placeAsk = market.getLimitOrderInstruction?.({
        side: 'Ask',
        price: layerAsk,
        sizeInBaseUnits: this.cfg.layerSize,
        trader: this.cfg.wallet.publicKey,
        clientOrderId: i + 1 + 1000,
      });
      if (placeBid) ixs.push(placeBid);
      if (placeAsk) ixs.push(placeAsk);
    }

    if (ixs.length === 0) {
      log.warn('no order instructions produced');
      return;
    }

    await this.deps.exec.execute(this.cfg.wallet, ixs, {
      computeUnitLimit: 800_000,
      useJito: false,
      maxRetries: 2,
    });
    log.debug({ orders: ixs.length, bid, ask }, 'orders refreshed');
  }
}
