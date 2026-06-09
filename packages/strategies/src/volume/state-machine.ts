import { weightedPick, secureRandom } from '@amm/shared';

/**
 * Markov-style state machine for organic-looking trading flow.
 *
 *   quiet         - low frequency, balanced sides, small sizes
 *   accumulate    - bias toward buys, medium sizes
 *   distribute    - bias toward sells, medium sizes
 *   burst         - high frequency, larger sizes, mixed sides
 *
 * Each state has its own:
 *   - transition probabilities (so we don't bounce uniformly)
 *   - dwell-time distribution (how many trades before re-rolling)
 *   - per-trade rate (Poisson lambda, trades/sec)
 *   - buy probability (split between buy/sell)
 *   - size multiplier (vs the configured base log-normal mean)
 */
export type VolumeState = 'quiet' | 'accumulate' | 'distribute' | 'burst';

export interface StateProfile {
  /** Mean trades per second while in this state. */
  ratePerSec: number;
  /** Probability the next trade is a buy (rest is sell). */
  buyProb: number;
  /** Multiplier on the configured base log-normal mean for trade size. */
  sizeMultiplier: number;
  /** Min/max trades to dwell in this state before re-rolling. */
  minDwell: number;
  maxDwell: number;
  /** Transition weights to the next state. */
  transitions: Record<VolumeState, number>;
}

export const DEFAULT_PROFILES: Record<VolumeState, StateProfile> = {
  quiet: {
    ratePerSec: 0.05,
    buyProb: 0.5,
    sizeMultiplier: 0.5,
    minDwell: 4,
    maxDwell: 12,
    transitions: { quiet: 6, accumulate: 2, distribute: 2, burst: 1 },
  },
  accumulate: {
    ratePerSec: 0.15,
    buyProb: 0.7,
    sizeMultiplier: 1.0,
    minDwell: 6,
    maxDwell: 18,
    transitions: { quiet: 3, accumulate: 5, distribute: 1, burst: 2 },
  },
  distribute: {
    ratePerSec: 0.15,
    buyProb: 0.3,
    sizeMultiplier: 1.0,
    minDwell: 6,
    maxDwell: 18,
    transitions: { quiet: 3, accumulate: 1, distribute: 5, burst: 2 },
  },
  burst: {
    ratePerSec: 0.6,
    buyProb: 0.5,
    sizeMultiplier: 1.8,
    minDwell: 4,
    maxDwell: 10,
    transitions: { quiet: 4, accumulate: 3, distribute: 3, burst: 1 },
  },
};

/**
 * Flat profile - all four states identical. Used by `mode: 'passive'` and
 * `mode: 'scheduled'` so the FSM is effectively neutralised: the strategy
 * trades at a constant low rate, balanced 50/50, with no burst spikes and
 * no size multiplier swings. Combined with `strictAlternate: true` this
 * yields a net-neutral price impact over time - "presence" rather than
 * volume manufacturing. ratePerSec=0.005 = 1 trade per ~3.3 minutes on
 * average.
 */
export const PASSIVE_PROFILES: Record<VolumeState, StateProfile> = (() => {
  const base: StateProfile = {
    ratePerSec: 0.005,
    buyProb: 0.5,
    sizeMultiplier: 1.0,
    minDwell: 1,
    maxDwell: 3,
    transitions: { quiet: 1, accumulate: 1, distribute: 1, burst: 1 },
  };
  return {
    quiet: { ...base },
    accumulate: { ...base },
    distribute: { ...base },
    burst: { ...base },
  };
})();

export class VolumeStateMachine {
  private state: VolumeState = 'quiet';
  private remainingDwell = 0;

  constructor(private readonly profiles: Record<VolumeState, StateProfile> = DEFAULT_PROFILES) {
    this.rerollDwell();
  }

  current(): VolumeState {
    return this.state;
  }

  profile(): StateProfile {
    return this.profiles[this.state];
  }

  /** Call after each trade. Transitions when the dwell counter hits zero. */
  tick(): void {
    this.remainingDwell--;
    if (this.remainingDwell > 0) return;
    const next = weightedPick(
      Object.entries(this.profile().transitions).map(([item, weight]) => ({
        item: item as VolumeState,
        weight,
      })),
    );
    this.state = next;
    this.rerollDwell();
  }

  private rerollDwell(): void {
    const p = this.profile();
    this.remainingDwell = Math.max(1, Math.round(p.minDwell + secureRandom() * (p.maxDwell - p.minDwell)));
  }
}
