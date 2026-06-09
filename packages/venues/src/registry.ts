import type { Connection } from '@solana/web3.js';
import type { VenueId } from '@amm/shared';
import { JupiterVenue } from './jupiter.js';
import { PumpSwapVenue } from './pumpswap.js';
import { RaydiumVenue, RaydiumPoolKind } from './raydium.js';
import { OrcaVenue } from './orca.js';
import { MeteoraDlmmVenue } from './meteora.js';
import { PhoenixVenue } from './phoenix.js';
import type { Venue } from './venue.js';

/**
 * Returns a Venue instance by id, lazily constructed and cached per process.
 * For raydium, the registry returns a venue that auto-detects whether the
 * pool is AMM v4 / CPMM / CLMM at quote time (id 'raydium-amm-v4' uses AMM,
 * 'raydium-cpmm' uses CPMM, 'raydium-clmm' uses CLMM).
 */
export class VenueRegistry {
  private readonly cache = new Map<VenueId, Venue>();

  constructor(private readonly connection: Connection) {}

  get(id: VenueId): Venue {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const v = this.build(id);
    this.cache.set(id, v);
    return v;
  }

  private build(id: VenueId): Venue {
    switch (id) {
      case 'pumpswap':
        return new PumpSwapVenue(this.connection);
      case 'jupiter':
        return new JupiterVenue(this.connection);
      case 'raydium-amm-v4':
        return new RaydiumVenue(this.connection, RaydiumPoolKind.AmmV4);
      case 'raydium-cpmm':
        return new RaydiumVenue(this.connection, RaydiumPoolKind.Cpmm);
      case 'raydium-clmm':
        return new RaydiumVenue(this.connection, RaydiumPoolKind.Clmm);
      case 'orca-whirlpools':
        return new OrcaVenue(this.connection);
      case 'meteora-dlmm':
        return new MeteoraDlmmVenue(this.connection);
      case 'phoenix':
        return new PhoenixVenue(this.connection);
      default:
        throw new Error(`unknown venue id: ${id satisfies never}`);
    }
  }
}
