import { randomBytes } from 'node:crypto';

/** Cryptographically-secure float in [0, 1). */
export function secureRandom(): number {
  const bytes = randomBytes(8);
  // Take 53 bits of entropy and divide by 2^53 to get a uniform float.
  const hi = bytes.readUInt32BE(0) & 0x001fffff; // 21 bits
  const lo = bytes.readUInt32BE(4); // 32 bits
  return (hi * 0x100000000 + lo) / 0x20000000000000;
}

/** Uniform integer in [min, max] inclusive. */
export function randomInt(min: number, max: number): number {
  return Math.floor(secureRandom() * (max - min + 1)) + min;
}

/** Uniform float in [min, max). */
export function randomFloat(min: number, max: number): number {
  return secureRandom() * (max - min) + min;
}

/** Pick a random element from a non-empty array. */
export function pick<T>(arr: readonly T[]): T {
  if (arr.length === 0) throw new Error('pick: empty array');
  return arr[randomInt(0, arr.length - 1)] as T;
}

/** Pick `n` random elements without replacement. */
export function sample<T>(arr: readonly T[], n: number): T[] {
  if (n > arr.length) throw new Error('sample: n > arr.length');
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const idx = randomInt(0, copy.length - 1);
    out.push(copy[idx] as T);
    copy.splice(idx, 1);
  }
  return out;
}

/** Box-Muller normal sample with mean=0, stddev=1. */
export function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = secureRandom();
  while (v === 0) v = secureRandom();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/** Sample from a log-normal distribution with the given log-space mean and stddev. */
export function lognormal(logMean: number, logStd: number): number {
  return Math.exp(logMean + logStd * gaussian());
}

/** Inter-arrival time of a Poisson process with the given rate (events per unit time). */
export function poissonInterval(rate: number): number {
  if (rate <= 0) return Number.POSITIVE_INFINITY;
  // -ln(U) / rate
  const u = secureRandom();
  return -Math.log(1 - u) / rate;
}

/** Weighted choice. weights need not sum to 1. */
export function weightedPick<T>(items: readonly { item: T; weight: number }[]): T {
  const total = items.reduce((s, i) => s + Math.max(0, i.weight), 0);
  if (total <= 0) throw new Error('weightedPick: all weights zero');
  let r = secureRandom() * total;
  for (const { item, weight } of items) {
    r -= Math.max(0, weight);
    if (r <= 0) return item;
  }
  return items[items.length - 1]!.item;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
