import BN from 'bn.js';
import { Decimal } from 'decimal.js';

export function bnToDecimal(amount: BN, decimals: number): Decimal {
  return new Decimal(amount.toString()).div(new Decimal(10).pow(decimals));
}

export function decimalToBn(amount: Decimal | number | string, decimals: number): BN {
  const d = new Decimal(amount).mul(new Decimal(10).pow(decimals)).toFixed(0);
  return new BN(d);
}

export function applySlippageDown(amount: BN, slippageBps: number): BN {
  // amount * (10000 - slippageBps) / 10000
  return amount.muln(10_000 - slippageBps).divn(10_000);
}

export function applySlippageUp(amount: BN, slippageBps: number): BN {
  return amount.muln(10_000 + slippageBps).divn(10_000);
}

export function priceFromAmounts(
  baseAmount: BN,
  baseDecimals: number,
  quoteAmount: BN,
  quoteDecimals: number,
): number {
  if (baseAmount.isZero()) return 0;
  const base = bnToDecimal(baseAmount, baseDecimals);
  const quote = bnToDecimal(quoteAmount, quoteDecimals);
  return quote.div(base).toNumber();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
