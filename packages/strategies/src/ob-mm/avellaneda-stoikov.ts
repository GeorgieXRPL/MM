/**
 * Avellaneda-Stoikov optimal market-making model.
 *
 * Given:
 *   s     - mid price
 *   q     - inventory (signed; positive = long base)
 *   gamma - risk aversion
 *   sigma - instantaneous volatility (per-unit-time stddev of returns)
 *   T     - time horizon (e.g. 1.0 = 1 trading day)
 *   t     - elapsed time within horizon
 *   k     - order book intensity parameter
 *
 * Output:
 *   r       = s - q * gamma * sigma^2 * (T - t)         (reservation price)
 *   spread  = gamma * sigma^2 * (T - t) + (2 / gamma) * ln(1 + gamma / k)
 *   bid     = r - spread / 2
 *   ask     = r + spread / 2
 */
export interface AsParams {
  /** risk aversion. Higher = pulls inventory back faster. typical: 0.05 - 1.0 */
  gamma: number;
  /** time horizon. typical: 1.0 (one period). */
  T: number;
  /** order intensity (fills per unit time near touch). typical: 1.5 */
  k: number;
}

export interface AsInputs {
  /** mid price (quote per base). */
  mid: number;
  /** inventory in base units (signed). */
  inventory: number;
  /** instantaneous volatility (standard deviation of log returns per unit time). */
  sigma: number;
  /** elapsed time in [0, T]. Reset to 0 at the start of each period. */
  t: number;
}

export interface AsQuote {
  reservation: number;
  spread: number;
  bid: number;
  ask: number;
}

export function asQuote(p: AsParams, x: AsInputs): AsQuote {
  const remaining = Math.max(0, p.T - x.t);
  const reservation = x.mid - x.inventory * p.gamma * x.sigma * x.sigma * remaining;
  const spread =
    p.gamma * x.sigma * x.sigma * remaining + (2 / p.gamma) * Math.log(1 + p.gamma / p.k);
  return {
    reservation,
    spread,
    bid: reservation - spread / 2,
    ask: reservation + spread / 2,
  };
}

/**
 * Rolling realized volatility estimator. Maintains an EWMA over log-returns
 * of mid samples. Robust to the short-window noise that a naive variance has.
 */
export class VolatilityEstimator {
  private lastMid: number | null = null;
  private varEwma = 0;
  private initialized = false;

  /**
   * @param halfLifeSamples The number of samples after which an old observation
   *   contributes 50% of its initial weight. Larger = slower adapt.
   * @param sampleIntervalMs The expected interval between push() calls. Used to
   *   normalize variance to per-unit-time (per second by default).
   */
  constructor(
    private readonly halfLifeSamples = 32,
    private readonly sampleIntervalMs = 1000,
  ) {}

  push(mid: number): void {
    if (mid <= 0) return;
    if (this.lastMid === null) {
      this.lastMid = mid;
      return;
    }
    const r = Math.log(mid / this.lastMid);
    this.lastMid = mid;
    const alpha = 1 - Math.pow(0.5, 1 / this.halfLifeSamples);
    this.varEwma = (1 - alpha) * this.varEwma + alpha * r * r;
    this.initialized = true;
  }

  /** Returns sigma (stddev of returns) per second. */
  sigmaPerSecond(): number {
    if (!this.initialized) return 0;
    const perSample = Math.sqrt(this.varEwma);
    // Convert to per-second by scaling by sqrt(samplesPerSecond).
    const samplesPerSec = 1000 / this.sampleIntervalMs;
    return perSample * Math.sqrt(samplesPerSec);
  }
}
