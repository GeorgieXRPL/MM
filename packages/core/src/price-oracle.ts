import { PublicKey } from '@solana/web3.js';
import { createLogger, NATIVE_SOL_MINT } from '@amm/shared';
import { fetchJson } from './http.js';

const log = createLogger('oracle');
const SOL_MINT_KEY = NATIVE_SOL_MINT.toBase58();

/**
 * Jupiter Price V3 response shape (free `lite-api` host):
 *   { "<mint>": { usdPrice, decimals, blockId, priceChange24h, liquidity?, ... } }
 *
 * Replaces the legacy V2 shape `{ data: { "<mint>": { price } } }`. V2 was
 * retired alongside the v6 swap endpoint; hitting it now returns 404 even for
 * tokens Jupiter clearly indexes (verified on a low-cap pump.fun mint that
 * V3 returns within 100ms while V2 404s).
 */
type JupPriceV3Resp = Record<
  string,
  {
    usdPrice?: number;
    decimals?: number;
    blockId?: number;
    priceChange24h?: number;
    liquidity?: number;
    launchpad?: string;
  } | undefined
>;

/**
 * Lightweight price aggregator. Sources from Jupiter Price V3 — covers
 * effectively every Solana token Jupiter routes (including low-cap pump.fun
 * tokens that V2 used to refuse). Returns USD prices.
 *
 * Default base is the free `lite-api.jup.ag` host. Override via the
 * `JUPITER_PRICE_API_BASE` env var if you've moved to the paid tier.
 *
 * Cached for `cacheMs` to avoid hammering the endpoint inside hot loops.
 */
export class PriceOracle {
  private readonly cache = new Map<string, { price: number; ts: number }>();
  private readonly base: string;

  constructor(private readonly cacheMs = 1500, base?: string) {
    this.base =
      base ??
      process.env.JUPITER_PRICE_API_BASE?.trim() ??
      'https://lite-api.jup.ag/price/v3';
  }

  async getPrice(mint: PublicKey | string): Promise<number | undefined> {
    const key = typeof mint === 'string' ? mint : mint.toBase58();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.ts < this.cacheMs) return cached.price;

    try {
      const resp = await fetchJson<JupPriceV3Resp>(`${this.base}?ids=${key}`);
      const px = Number(resp?.[key]?.usdPrice);
      if (Number.isFinite(px) && px > 0) {
        this.cache.set(key, { price: px, ts: Date.now() });
        return px;
      }
    } catch (e) {
      log.warn({ key, err: (e as Error).message }, 'price fetch failed');
    }
    return undefined;
  }

  async getPrices(mints: (PublicKey | string)[]): Promise<Record<string, number>> {
    const keys = mints.map((m) => (typeof m === 'string' ? m : m.toBase58()));
    const out: Record<string, number> = {};
    const missing: string[] = [];
    for (const k of keys) {
      const cached = this.cache.get(k);
      if (cached && Date.now() - cached.ts < this.cacheMs) {
        out[k] = cached.price;
      } else {
        missing.push(k);
      }
    }
    if (missing.length === 0) return out;
    try {
      const resp = await fetchJson<JupPriceV3Resp>(
        `${this.base}?ids=${missing.join(',')}`,
      );
      for (const k of missing) {
        const px = Number(resp?.[k]?.usdPrice);
        if (Number.isFinite(px) && px > 0) {
          this.cache.set(k, { price: px, ts: Date.now() });
          out[k] = px;
        }
      }
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'batch price fetch failed');
    }
    return out;
  }

  /**
   * Returns the SOL-denominated price of `mint` (i.e. how many SOL one whole
   * token costs), derived from a single Jupiter Price V3 batch call for both
   * `mint` and the wrapped-SOL mint. Useful when comparing a token's price to
   * pool-derived spot prices (which are naturally SOL-per-token), so callers
   * can mix sources without unit-mismatch corruption.
   *
   * Returns undefined if Jupiter doesn't index either side, or if SOL price
   * is non-positive.
   */
  async getPriceInSol(mint: PublicKey | string): Promise<number | undefined> {
    const key = typeof mint === 'string' ? mint : mint.toBase58();
    if (key === SOL_MINT_KEY) return 1;
    const prices = await this.getPrices([key, SOL_MINT_KEY]);
    const tokenUsd = prices[key];
    const solUsd = prices[SOL_MINT_KEY];
    if (!tokenUsd || !solUsd || solUsd <= 0) return undefined;
    return tokenUsd / solUsd;
  }
}
