import {
  createLogger,
  lognormal,
  pick,
  poissonInterval,
  secureRandom,
  weightedPick,
} from '@amm/shared';
import {
  DEFAULT_PROFILES,
  type StateProfile,
  type VolumeState,
} from '../volume/state-machine.js';
import { asQuote, type AsParams } from '../ob-mm/avellaneda-stoikov.js';

const log = createLogger('backtest');

/**
 * Lightweight backtester. Not a full event-driven sim - it answers two
 * questions strategy authors actually need:
 *
 *  - "given a price tape, what does my volume strategy generate?" → `simulateVolume`
 *  - "given a price tape, what spread/PnL would Avellaneda-Stoikov produce?" → `simulateObMm`
 *
 * The price tape is a flat array of mid prices sampled at uniform intervals
 * (the "tick"). For the first cut we synthesise a tape from a geometric
 * brownian motion when no tape is supplied.
 */

export interface PriceTape {
  /** mid prices, one per tick. */
  prices: number[];
  /** tick interval in ms. */
  tickMs: number;
}

export function syntheticTape(opts: {
  startPrice: number;
  ticks: number;
  tickMs?: number;
  /** annualised volatility (e.g. 0.6 = 60%). */
  vol: number;
  /** annualised drift. */
  drift?: number;
}): PriceTape {
  const tickMs = opts.tickMs ?? 1000;
  const ticksPerYear = (365 * 24 * 3600 * 1000) / tickMs;
  const dt = 1 / ticksPerYear;
  const drift = opts.drift ?? 0;
  const prices = new Array<number>(opts.ticks);
  let p = opts.startPrice;
  for (let i = 0; i < opts.ticks; i++) {
    const z = gaussianForTape();
    p = p * Math.exp((drift - 0.5 * opts.vol * opts.vol) * dt + opts.vol * Math.sqrt(dt) * z);
    prices[i] = p;
  }
  return { prices, tickMs };
}

function gaussianForTape(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = secureRandom();
  while (v === 0) v = secureRandom();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// ----- volume strategy backtest --------------------------------------------

export interface VolumeBacktestConfig {
  profiles?: Record<VolumeState, StateProfile>;
  sizeLogMean?: number;
  sizeLogStd?: number;
  minQuoteSize?: number;
  maxQuoteSize?: number;
  /** Slippage assumed per trade (bps). Used to estimate cost. */
  slippageBps?: number;
}

export interface VolumeBacktestResult {
  trades: { tickIdx: number; side: 'buy' | 'sell'; quoteSize: number; price: number; state: VolumeState }[];
  buys: number;
  sells: number;
  totalVolumeQuote: number;
  estCostQuote: number;
}

export function simulateVolume(tape: PriceTape, cfg: VolumeBacktestConfig = {}): VolumeBacktestResult {
  const profiles = cfg.profiles ?? DEFAULT_PROFILES;
  const min = cfg.minQuoteSize ?? 0.005;
  const max = cfg.maxQuoteSize ?? 1.0;
  const lm = cfg.sizeLogMean ?? Math.log(0.05);
  const ls = cfg.sizeLogStd ?? 0.6;
  const slipBps = cfg.slippageBps ?? 50;
  let state: VolumeState = 'quiet';
  let dwell = 8;
  const trades: VolumeBacktestResult['trades'] = [];
  let nextEventTick = 0;

  for (let i = 0; i < tape.prices.length; i++) {
    if (i < nextEventTick) continue;
    const p: StateProfile = profiles[state];
    if (secureRandom() >= p.ratePerSec * (tape.tickMs / 1000)) {
      // No event this tick (Poisson approximation).
      continue;
    }
    const isBuy = secureRandom() < p.buyProb;
    let size = lognormal(lm, ls) * p.sizeMultiplier;
    size = Math.max(min, Math.min(max, size));
    const price = tape.prices[i] ?? 0;
    trades.push({ tickIdx: i, side: isBuy ? 'buy' : 'sell', quoteSize: size, price, state });

    nextEventTick = i + Math.max(1, Math.round((poissonInterval(p.ratePerSec) * 1000) / tape.tickMs));

    dwell--;
    if (dwell <= 0) {
      state = weightedPick(
        Object.entries(p.transitions).map(([item, w]) => ({
          item: item as VolumeState,
          weight: w as number,
        })),
      );
      const np: StateProfile = profiles[state];
      dwell = Math.round(np.minDwell + secureRandom() * (np.maxDwell - np.minDwell));
    }
  }

  const buys = trades.filter((t) => t.side === 'buy').length;
  const sells = trades.length - buys;
  const totalVolumeQuote = trades.reduce((s, t) => s + t.quoteSize, 0);
  const estCostQuote = totalVolumeQuote * (slipBps / 10_000);

  log.info(
    {
      ticks: tape.prices.length,
      trades: trades.length,
      buys,
      sells,
      totalVolumeQuote: +totalVolumeQuote.toFixed(4),
      estCostQuote: +estCostQuote.toFixed(4),
    },
    'volume backtest done',
  );

  void pick;
  return { trades, buys, sells, totalVolumeQuote, estCostQuote };
}

// ----- ob-mm backtest ------------------------------------------------------

export interface ObMmBacktestConfig {
  asParams: AsParams;
  /** Probability per tick that a fill sweeps your bid (or ask). */
  fillProbability?: number;
  /** Per-fill base size. */
  fillSize?: number;
  /** Initial inventory in base units. */
  startInventory?: number;
  /** Realized vol estimator half-life in samples. */
  volHalfLife?: number;
}

export interface ObMmBacktestResult {
  pnlQuote: number;
  finalInventory: number;
  fills: number;
  series: { tick: number; mid: number; bid: number; ask: number; inventory: number; pnl: number }[];
}

export function simulateObMm(tape: PriceTape, cfg: ObMmBacktestConfig): ObMmBacktestResult {
  const fillProb = cfg.fillProbability ?? 0.05;
  const size = cfg.fillSize ?? 0.1;
  let inventory = cfg.startInventory ?? 0;
  let pnl = 0;
  let fills = 0;
  const series: ObMmBacktestResult['series'] = [];

  // Inline EWMA vol to avoid pulling the class.
  let lastMid = tape.prices[0] ?? 0;
  let varEwma = 0;
  const halfLife = cfg.volHalfLife ?? 32;
  const alpha = 1 - Math.pow(0.5, 1 / halfLife);

  for (let i = 1; i < tape.prices.length; i++) {
    const mid = tape.prices[i] ?? 0;
    if (mid <= 0 || lastMid <= 0) continue;
    const r = Math.log(mid / lastMid);
    varEwma = (1 - alpha) * varEwma + alpha * r * r;
    lastMid = mid;
    const sigma = Math.sqrt(varEwma) * Math.sqrt(1000 / tape.tickMs);

    const t = i / tape.prices.length;
    const q = asQuote(cfg.asParams, { mid, inventory, sigma, t });

    // Naive fill model: each side has fillProb each tick.
    if (secureRandom() < fillProb) {
      // Buy side hit: we buy at our bid.
      pnl -= q.bid * size;
      inventory += size;
      fills++;
    }
    if (secureRandom() < fillProb) {
      pnl += q.ask * size;
      inventory -= size;
      fills++;
    }

    if (i % 50 === 0) {
      series.push({ tick: i, mid, bid: q.bid, ask: q.ask, inventory, pnl: pnl + inventory * mid });
    }
  }

  const finalMid = tape.prices[tape.prices.length - 1] ?? 0;
  const pnlQuote = pnl + inventory * finalMid;
  log.info({ ticks: tape.prices.length, fills, pnlQuote: +pnlQuote.toFixed(4), finalInventory: inventory }, 'ob-mm backtest done');
  return { pnlQuote, finalInventory: inventory, fills, series };
}
