import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import { logBuffer } from '@amm/shared';
import { lockedProcedure, publicProcedure, router } from '../trpc.js';

export const runsRouter = router({
  list: lockedProcedure.input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(({ ctx, input }) => {
      return ctx.session.context().store.listRuns(input?.limit ?? 50);
    }),

  trades: lockedProcedure
    .input(z.object({ runId: z.number().int(), limit: z.number().int().min(1).max(500).default(100) }))
    .query(({ ctx, input }) => {
      return ctx.session.context().store.recentTrades(input.runId, input.limit);
    }),

  active: lockedProcedure.query(({ ctx }) => {
    return ctx.session.orchestrator().list();
  }),

  // Log viewer for the dashboard. Uses the in-process ring buffer in
  // @amm/shared/logger (capacity 1000 lines). Filters by `mod` substring,
  // minimum level, and a `since` epoch-ms cursor for incremental polling.
  logs: publicProcedure
    .input(
      z
        .object({
          since: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(500).default(200),
          mod: z.string().optional(),
          minLevel: z.number().int().min(10).max(60).default(30),
        })
        .optional(),
    )
    .query(({ input }) => {
      const opts = input ?? { since: 0, limit: 200, minLevel: 30 };
      const { entries, tip } = logBuffer.recent(opts.limit, opts.since);
      const filtered = entries.filter((e) => {
        if (e.level < opts.minLevel) return false;
        if (opts.mod && (!e.mod || !e.mod.includes(opts.mod))) return false;
        return true;
      });
      return { entries: filtered, tip, totalBuffered: logBuffer.size() };
    }),

  startVolume: lockedProcedure
    .input(
      z.object({
        poolId: z.string(),
        venue: z.string(),
        baseMint: z.string().optional(),
        quoteMint: z.string().optional(),
        walletTag: z.string().default('volume'),
        slippageBps: z.number().int().default(100),
        minQuoteSize: z.number().positive().default(0.005),
        maxQuoteSize: z.number().positive().default(1),
        meanQuoteSize: z.number().positive().default(0.05),
        // Spread of the lognormal size distribution. Lower = sizes cluster
        // tighter around the mean; higher = wider tails (occasional whales).
        // Default 0.6 gives ~95% of swaps within ~5x of the mean either way.
        sizeLogStd: z.number().positive().default(0.6),
        // Behaviour preset. organic = manipulative volume; passive = flat
        // FSM with strict alternation; scheduled = passive + UTC time gate.
        mode: z.enum(['organic', 'passive', 'scheduled']).default('organic'),
        strictAlternate: z.boolean().optional(),
        activeStartHourUtc: z.number().int().min(0).max(23).optional(),
        activeEndHourUtc: z.number().int().min(0).max(23).optional(),
        // Pacing override: average seconds between trades GLOBALLY across
        // all wallets. 0 = use FSM-derived rate (mode default). Useful for
        // slow "support presence" passive runs where you want minutes
        // between trades regardless of mode.
        globalIntervalSec: z.number().nonnegative().default(0),
        // Hard minimum gap between any two trades. Tames the heavy tail
        // of the Poisson distribution (~28% of samples are < 1/3 of mean).
        minIntervalSec: z.number().nonnegative().default(0),
        // Wallet rotation knobs.
        walletTradeCap: z.number().int().nonnegative().default(0),
        walletCooldownMs: z.number().int().nonnegative().default(0),
        slippageJitter: z.number().min(0).max(0.9).default(0),
        // Priority-fee + CU jitter for per-tx fingerprint defence.
        priorityMicroLamports: z.number().nonnegative().default(0),
        priorityFeeJitter: z.number().min(0).max(0.9).default(0),
        cuJitter: z.number().min(0).max(0.9).default(0),
        // Jito-on by default for live mainnet runs: bypasses the public
        // mempool, removes the pre-confirmation-observability fingerprint,
        // and gives the tx a real shot at landing during congestion. Costs
        // JITO_TIP_LAMPORTS (default 10k) per trade. Harmless under dryRun
        // because dryRun never actually executes.
        useJito: z.boolean().default(true),
        dryRun: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx.session.context();
      const wallets = c.vault.filterKeypairs([input.walletTag]).map((w) => w.keypair);
      if (wallets.length === 0) throw new Error(`no wallets tagged '${input.walletTag}'`);
      if (input.minQuoteSize > input.maxQuoteSize) {
        throw new Error(
          `minQuoteSize (${input.minQuoteSize}) cannot exceed maxQuoteSize (${input.maxQuoteSize})`,
        );
      }
      // Validate active-hours window: both bounds or neither, and they must differ.
      const hasStart = input.activeStartHourUtc !== undefined;
      const hasEnd = input.activeEndHourUtc !== undefined;
      if (hasStart !== hasEnd) {
        throw new Error('activeStartHourUtc and activeEndHourUtc must both be provided');
      }
      const activeHoursUtc: [number, number] | undefined =
        hasStart && hasEnd
          ? [input.activeStartHourUtc!, input.activeEndHourUtc!]
          : undefined;

      const runId = await ctx.session.orchestrator().startVolume({
        poolId: new PublicKey(input.poolId),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        venue: input.venue as any,
        baseMint: input.baseMint ? new PublicKey(input.baseMint) : undefined,
        quoteMint: input.quoteMint ? new PublicKey(input.quoteMint) : undefined,
        wallets,
        slippageBps: input.slippageBps,
        minQuoteSize: input.minQuoteSize,
        maxQuoteSize: input.maxQuoteSize,
        sizeLogMean: Math.log(input.meanQuoteSize),
        sizeLogStd: input.sizeLogStd,
        mode: input.mode,
        strictAlternate: input.strictAlternate,
        activeHoursUtc,
        globalIntervalSec: input.globalIntervalSec || undefined,
        minIntervalSec: input.minIntervalSec || undefined,
        walletTradeCap: input.walletTradeCap || undefined,
        walletCooldownMs: input.walletCooldownMs || undefined,
        slippageJitter: input.slippageJitter || undefined,
        priorityMicroLamports: input.priorityMicroLamports || undefined,
        priorityFeeJitter: input.priorityFeeJitter || undefined,
        cuJitter: input.cuJitter || undefined,
        useJito: input.useJito,
        dryRun: input.dryRun,
      });
      return { runId };
    }),

  startInventoryRebalance: lockedProcedure
    .input(
      z.object({
        poolId: z.string(),
        venue: z.string(),
        baseMint: z.string().optional(),
        quoteMint: z.string().optional(),
        walletLabel: z.string(),
        targetBaseFraction: z.number().min(0).max(1).default(0.5),
        driftThreshold: z.number().min(0.005).max(0.5).default(0.05),
        slippageBps: z.number().int().default(100),
        slippageJitter: z.number().min(0).max(0.9).default(0.2),
        pollIntervalMs: z.number().int().positive().default(30_000),
        cooldownMs: z.number().int().nonnegative().default(60_000),
        maxTradeQuote: z.number().positive().default(1),
        useJito: z.boolean().default(false),
        dryRun: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx.session.context();
      const kp = c.vault.getKeypair(input.walletLabel);
      if (!kp) throw new Error(`no wallet '${input.walletLabel}'`);
      const runId = await ctx.session.orchestrator().startInventoryRebalance({
        poolId: new PublicKey(input.poolId),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        venue: input.venue as any,
        wallet: kp,
        baseMint: input.baseMint ? new PublicKey(input.baseMint) : undefined,
        quoteMint: input.quoteMint ? new PublicKey(input.quoteMint) : undefined,
        targetBaseFraction: input.targetBaseFraction,
        driftThreshold: input.driftThreshold,
        slippageBps: input.slippageBps,
        slippageJitter: input.slippageJitter,
        pollIntervalMs: input.pollIntervalMs,
        cooldownMs: input.cooldownMs,
        maxTradeQuote: input.maxTradeQuote,
        useJito: input.useJito,
        dryRun: input.dryRun,
      });
      return { runId };
    }),

  startCounterMomentum: lockedProcedure
    .input(
      z.object({
        poolId: z.string(),
        venue: z.string(),
        baseMint: z.string().optional(),
        quoteMint: z.string().optional(),
        walletLabel: z.string(),
        triggerPct: z.number().min(0.001).max(0.5).default(0.02),
        lookbackSec: z.number().int().positive().default(300),
        sampleIntervalMs: z.number().int().positive().default(5_000),
        cooldownMs: z.number().int().nonnegative().default(60_000),
        sizeFraction: z.number().min(0.001).max(1).default(0.1),
        maxSizeQuote: z.number().positive().default(0.5),
        slippageBps: z.number().int().default(100),
        slippageJitter: z.number().min(0).max(0.9).default(0.2),
        useJito: z.boolean().default(false),
        dryRun: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx.session.context();
      const kp = c.vault.getKeypair(input.walletLabel);
      if (!kp) throw new Error(`no wallet '${input.walletLabel}'`);
      const runId = await ctx.session.orchestrator().startCounterMomentum({
        poolId: new PublicKey(input.poolId),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        venue: input.venue as any,
        wallet: kp,
        baseMint: input.baseMint ? new PublicKey(input.baseMint) : undefined,
        quoteMint: input.quoteMint ? new PublicKey(input.quoteMint) : undefined,
        triggerPct: input.triggerPct,
        lookbackSec: input.lookbackSec,
        sampleIntervalMs: input.sampleIntervalMs,
        cooldownMs: input.cooldownMs,
        sizeFraction: input.sizeFraction,
        maxSizeQuote: input.maxSizeQuote,
        slippageBps: input.slippageBps,
        slippageJitter: input.slippageJitter,
        useJito: input.useJito,
        dryRun: input.dryRun,
      });
      return { runId };
    }),

  startMeteoraLp: lockedProcedure
    .input(
      z.object({
        poolId: z.string(),
        walletLabel: z.string(),
        mode: z.enum(['two-sided', 'quote-only', 'base-only']).default('two-sided'),
        strategyType: z.enum(['spot', 'curve', 'bid-ask']).default('spot'),
        widthFraction: z.number().positive().default(0.05),
        binOffset: z.number().int().nonnegative().default(1),
        rebalanceHysteresis: z.number().nonnegative().default(0.01),
        cooldownMs: z.number().int().nonnegative().default(30_000),
        pollIntervalMs: z.number().int().positive().default(5_000),
        slippageBps: z.number().int().default(80),
        feeClaimIntervalMs: z.number().int().positive().default(300_000),
        compoundFees: z.boolean().default(true),
        autoRedeployOnFill: z.boolean().default(true),
        inventorySwapToTarget: z.boolean().default(true),
        targetBaseFraction: z.number().min(0).max(1).default(0.5),
        dryRun: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx.session.context();
      const kp = c.vault.getKeypair(input.walletLabel);
      if (!kp) throw new Error(`no wallet '${input.walletLabel}'`);
      const runId = await ctx.session.orchestrator().startMeteoraLp({
        poolId: new PublicKey(input.poolId),
        wallet: kp,
        mode: input.mode,
        strategyType: input.strategyType,
        widthFraction: input.widthFraction,
        binOffset: input.binOffset,
        rebalanceHysteresis: input.rebalanceHysteresis,
        cooldownMs: input.cooldownMs,
        pollIntervalMs: input.pollIntervalMs,
        slippageBps: input.slippageBps,
        feeClaimIntervalMs: input.feeClaimIntervalMs,
        compoundFees: input.compoundFees,
        autoRedeployOnFill: input.autoRedeployOnFill,
        inventorySwapToTarget: input.inventorySwapToTarget,
        targetBaseFraction: input.targetBaseFraction,
        dryRun: input.dryRun,
      });
      return { runId };
    }),

  pause: lockedProcedure
    .input(z.object({ runId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.session.orchestrator().pause(input.runId);
      return { ok: true };
    }),

  resume: lockedProcedure
    .input(z.object({ runId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.session.orchestrator().resume(input.runId);
      return { ok: true };
    }),

  update: lockedProcedure
    .input(
      z.object({
        runId: z.number().int(),
        patch: z.record(z.string(), z.unknown()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.session.orchestrator().update(input.runId, input.patch);
      return { ok: true };
    }),

  stop: lockedProcedure
    .input(z.object({ runId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.session.orchestrator().stop(input.runId);
      return { ok: true };
    }),
});
