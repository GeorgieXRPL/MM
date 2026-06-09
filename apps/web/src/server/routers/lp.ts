import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { lockedProcedure, router } from '../trpc.js';
import type { VenueId } from '@amm/shared';

export const lpRouter = router({
  positions: lockedProcedure
    .input(
      z.object({
        ownerLabel: z.string(),
        pools: z.array(z.object({ venue: z.string(), poolId: z.string() })),
      }),
    )
    .query(async ({ ctx, input }) => {
      const c = ctx.session.context();
      const kp = c.vault.getKeypair(input.ownerLabel);
      if (!kp) throw new Error(`no wallet '${input.ownerLabel}'`);
      const positions = await c.lpManager.listAllPositions(
        kp.publicKey,
        input.pools.map((p) => p.venue as VenueId),
        input.pools.map((p) => ({ venue: p.venue as VenueId, poolId: new PublicKey(p.poolId) })),
      );
      return positions.map((p) => ({
        venue: p.venue,
        poolId: p.poolId.toBase58(),
        positionId: p.positionId.toBase58(),
        owner: p.owner.toBase58(),
        baseMint: p.baseMint.toBase58(),
        quoteMint: p.quoteMint.toBase58(),
        baseAmount: p.baseAmount.toString(),
        quoteAmount: p.quoteAmount.toString(),
        lowerPrice: p.lowerPrice ?? null,
        upperPrice: p.upperPrice ?? null,
        inRange: p.inRange,
        feesPendingBase: p.feesPendingBase?.toString() ?? null,
        feesPendingQuote: p.feesPendingQuote?.toString() ?? null,
      }));
    }),

  simulateDeposit: lockedProcedure
    .input(
      z.object({
        venue: z.string(),
        poolId: z.string(),
        owner: z.string(),
        baseAmount: z.string(),
        quoteAmount: z.string(),
        centerPrice: z.number().optional(),
        widthFraction: z.number().optional(),
        slippageBps: z.number().int().default(50),
        mode: z.enum(['two-sided', 'quote-only', 'base-only']).optional(),
        strategyType: z.enum(['spot', 'curve', 'bid-ask']).optional(),
        binOffset: z.number().int().nonnegative().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx.session.context();
      const kp = c.vault.getKeypair(input.owner);
      if (!kp) throw new Error(`no wallet '${input.owner}'`);
      return await c.lpManager.simulateDeposit({
        venue: input.venue as VenueId,
        poolId: new PublicKey(input.poolId),
        user: kp.publicKey,
        baseAmountMax: new BN(input.baseAmount),
        quoteAmountMax: new BN(input.quoteAmount),
        centerPrice: input.centerPrice,
        widthFraction: input.widthFraction,
        slippageBps: input.slippageBps,
        mode: input.mode,
        strategyType: input.strategyType,
        binOffset: input.binOffset,
      });
    }),

  deposit: lockedProcedure
    .input(
      z.object({
        venue: z.string(),
        poolId: z.string(),
        walletLabel: z.string(),
        baseAmount: z.string(),
        quoteAmount: z.string(),
        centerPrice: z.number().optional(),
        widthFraction: z.number().optional(),
        slippageBps: z.number().int().default(50),
        mode: z.enum(['two-sided', 'quote-only', 'base-only']).optional(),
        strategyType: z.enum(['spot', 'curve', 'bid-ask']).optional(),
        binOffset: z.number().int().nonnegative().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx.session.context();
      const kp = c.vault.getKeypair(input.walletLabel);
      if (!kp) throw new Error(`no wallet '${input.walletLabel}'`);
      const sig = await c.lpManager.deposit({
        venue: input.venue as VenueId,
        poolId: new PublicKey(input.poolId),
        wallet: kp,
        baseAmountMax: new BN(input.baseAmount),
        quoteAmountMax: new BN(input.quoteAmount),
        centerPrice: input.centerPrice,
        widthFraction: input.widthFraction,
        slippageBps: input.slippageBps,
        mode: input.mode,
        strategyType: input.strategyType,
        binOffset: input.binOffset,
      });
      return { signature: sig };
    }),

  claimFees: lockedProcedure
    .input(
      z.object({
        poolId: z.string(),
        positionId: z.string(),
        walletLabel: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx.session.context();
      const kp = c.vault.getKeypair(input.walletLabel);
      if (!kp) throw new Error(`no wallet '${input.walletLabel}'`);
      const sig = await c.lpManager.claimFees({
        poolId: new PublicKey(input.poolId),
        positionId: new PublicKey(input.positionId),
        wallet: kp,
      });
      return { signature: sig };
    }),

  withdraw: lockedProcedure
    .input(
      z.object({
        venue: z.string(),
        positionId: z.string(),
        walletLabel: z.string(),
        fraction: z.number().default(1),
        closePosition: z.boolean().default(false),
        slippageBps: z.number().int().default(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx.session.context();
      const kp = c.vault.getKeypair(input.walletLabel);
      if (!kp) throw new Error(`no wallet '${input.walletLabel}'`);
      const sig = await c.lpManager.withdraw({
        venue: input.venue as VenueId,
        positionId: new PublicKey(input.positionId),
        wallet: kp,
        fraction: input.fraction,
        closePosition: input.closePosition,
        slippageBps: input.slippageBps,
      });
      return { signature: sig };
    }),
});
