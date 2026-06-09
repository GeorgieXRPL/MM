import { z } from 'zod';
import BN from 'bn.js';
import { PublicKey, type AddressLookupTableAccount } from '@solana/web3.js';
import { LAMPORTS_PER_SOL, createLogger, sleep, randomFloat, randomInt, NATIVE_SOL_MINT } from '@amm/shared';
import { Vault, distributeSol, sweepWallet } from '@amm/core';
import { JupiterVenue } from '@amm/venues';
import { router, publicProcedure, lockedProcedure } from '../trpc.js';

const log = createLogger('vault-api');

export const vaultRouter = router({
  status: publicProcedure.query(async ({ ctx }) => {
    const v = new Vault();
    return {
      exists: await v.exists(),
      unlocked: ctx.session.isUnlocked(),
      path: v.path,
    };
  }),

  unlock: publicProcedure
    .input(z.object({ passphrase: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.session.unlock(input.passphrase);
      return { ok: true };
    }),

  lock: lockedProcedure.mutation(({ ctx }) => {
    ctx.session.lock();
    return { ok: true };
  }),

  listWallets: lockedProcedure.query(async ({ ctx }) => {
    const c = ctx.session.context();
    const wallets = c.vault.list();
    // Fetch balances in parallel with a per-call timeout so a single slow
    // endpoint doesn't stall the whole list. Errors are surfaced as a
    // `balanceError` field rather than silently coerced to 0 (the previous
    // `.catch(() => 0)` made it impossible to distinguish a wallet that's
    // genuinely empty from one whose balance probe failed - e.g. when the
    // dev server inadvertently picked up an `RPC_PUBLIC=devnet` from the
    // shell env and reported every mainnet wallet as 0 SOL).
    const probes = wallets.map(async (w) => {
      const kp = c.vault.getKeypair(w.label)!;
      try {
        const lamports = await Promise.race([
          c.rpc.getBalance(kp.publicKey),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('balance probe timed out after 8s')), 8_000),
          ),
        ]);
        return {
          label: w.label,
          pubkey: kp.publicKey.toBase58(),
          tags: w.tags,
          createdAt: w.createdAt,
          balanceLamports: lamports,
          balanceError: undefined as string | undefined,
        };
      } catch (e) {
        return {
          label: w.label,
          pubkey: kp.publicKey.toBase58(),
          tags: w.tags,
          createdAt: w.createdAt,
          balanceLamports: 0,
          balanceError: (e as Error).message.slice(0, 200) as string | undefined,
        };
      }
    });
    return Promise.all(probes);
  }),

  generateWallets: lockedProcedure
    .input(
      z.object({
        count: z.number().int().min(1).max(50),
        prefix: z.string().min(1).max(32),
        tags: z.array(z.string()).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx.session.context();
      const labels = await c.vault.generate(input.count, input.prefix, input.tags);
      return { labels };
    }),

  // Import an external keypair into the vault. Accepts either a base58 secret
  // string (~88 chars) or a Solana CLI keypair JSON array `[1,2,...,64]` so
  // users can paste whichever format they have on hand. Always rejects the
  // pubkey-only or hex forms by failing Keypair.fromSecretKey validation.
  importWallet: lockedProcedure
    .input(
      z.object({
        label: z.string().min(1).max(64),
        tags: z.array(z.string()).default([]),
        secret: z.string().min(1).max(2_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx.session.context();
      const trimmed = input.secret.trim();
      if (trimmed.startsWith('[')) {
        let arr: unknown;
        try {
          arr = JSON.parse(trimmed);
        } catch (e) {
          throw new Error(`secret looks like JSON but is not parseable: ${(e as Error).message}`);
        }
        if (!Array.isArray(arr) || arr.length !== 64 || arr.some((n) => typeof n !== 'number')) {
          throw new Error('JSON keypair must be a 64-element array of bytes');
        }
        await c.vault.importFromSecretKey(input.label, Uint8Array.from(arr as number[]), input.tags);
      } else {
        try {
          await c.vault.importFromBase58(input.label, trimmed, input.tags);
        } catch (e) {
          // Surface the underlying error verbatim so the user sees whether it
          // was a bad secret-key format vs a duplicate label vs anything else.
          throw e instanceof Error ? e : new Error(String(e));
        }
      }
      const kp = c.vault.getKeypair(input.label)!;
      return { label: input.label, pubkey: kp.publicKey.toBase58() };
    }),

  removeWallet: lockedProcedure
    .input(z.object({ label: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.session.context().vault.remove(input.label);
      return { ok: true };
    }),

  retag: lockedProcedure
    .input(z.object({ label: z.string(), tags: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.session.context().vault.retag(input.label, input.tags);
      return { ok: true };
    }),

  // Distribute SOL from a funder wallet to all wallets matching `recipientTag`.
  // Wraps `distributeSol` from @amm/core which optionally inserts multi-hop
  // intermediates so the on-chain trace operator -> sub-wallets is broken.
  fundSubWallets: lockedProcedure
    .input(
      z.object({
        funderLabel: z.string().min(1),
        recipientTag: z.string().min(1),
        perWalletSol: z.number().positive(),
        jitterFraction: z.number().min(0).max(0.5).default(0.15),
        multiHop: z.boolean().default(true),
        minHops: z.number().int().min(1).max(10).default(3),
        maxHops: z.number().int().min(1).max(15).default(7),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx.session.context();
      const funder = c.vault.getKeypair(input.funderLabel);
      if (!funder) throw new Error(`no wallet '${input.funderLabel}'`);
      const recipients = c.vault
        .filterKeypairs([input.recipientTag])
        .map((w) => w.keypair.publicKey);
      if (recipients.length === 0) {
        throw new Error(`no wallets tagged '${input.recipientTag}'`);
      }
      const lamports = Math.round(input.perWalletSol * LAMPORTS_PER_SOL);
      const totalNeeded = lamports * recipients.length;
      const funderBalance = await c.rpc.getBalance(funder.publicKey).catch(() => 0);
      // ~5k lamports per hop fee; pad generously: up to maxHops + dust per recipient.
      const feeReserve = 50_000 * recipients.length * (input.multiHop ? input.maxHops + 2 : 2);
      if (funderBalance < totalNeeded + feeReserve) {
        throw new Error(
          `funder '${input.funderLabel}' has ${(funderBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL, ` +
            `needs ~${((totalNeeded + feeReserve) / LAMPORTS_PER_SOL).toFixed(4)} SOL ` +
            `(${(lamports * recipients.length / LAMPORTS_PER_SOL).toFixed(4)} payload + ${(feeReserve / LAMPORTS_PER_SOL).toFixed(4)} fee/rent reserve for ${recipients.length} wallets)`,
        );
      }
      log.info(
        {
          funder: input.funderLabel,
          recipientCount: recipients.length,
          perWalletSol: input.perWalletSol,
          multiHop: input.multiHop,
        },
        'fund-sub-wallets started',
      );

      // Iterate one recipient at a time so a single failure (RPC blip,
      // insufficient lamports on a hop, etc.) doesn't lose the work
      // already done for prior recipients. The dashboard surfaces both
      // `recipients` and `failed` so the user can see partial success.
      const results: { pubkey: string; sol: number; hops: number; firstSignature: string | null }[] = [];
      const failed: { pubkey: string; error: string }[] = [];
      for (const recipient of recipients) {
        try {
          const r = await distributeSol({
            rpc: c.rpc,
            exec: c.exec,
            funder,
            recipients: [recipient],
            meanLamports: lamports,
            jitterFraction: input.jitterFraction,
            hop: input.multiHop ? { minHops: input.minHops, maxHops: input.maxHops } : false,
            store: c.store,
          });
          const r0 = r[0]!;
          results.push({
            pubkey: r0.recipient,
            sol: r0.lamports / LAMPORTS_PER_SOL,
            hops: r0.signatures.length,
            firstSignature: r0.signatures[0] ?? null,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          log.error({ recipient: recipient.toBase58(), err: message }, 'fund-sub-wallets recipient failed');
          failed.push({ pubkey: recipient.toBase58(), error: message });
        }
      }

      const totalSol = results.reduce((s, r) => s + r.sol, 0);
      log.info(
        { funded: results.length, failed: failed.length, totalSol },
        'fund-sub-wallets done',
      );

      return { recipients: results, failed, totalSol };
    }),

  // Gather every lamport (and optionally token balance) from all wallets
  // matching `sourceTag` back to one or more destination wallets. Improves
  // on the legacy single-destination sweep in three ways the chain-analyst
  // would notice:
  //
  //   1. Multi-destination: pass `destinationLabels` as an array; each
  //      source is randomly assigned to one of them. Breaks the "all roads
  //      lead to wallet X" star pattern that common-input clustering would
  //      collapse in seconds.
  //   2. Phased: when `phaseDelaySec` is set, sweeps are forced sequential
  //      and a uniform-random delay is inserted between each source. Same
  //      final state, but the temporal correlation across sources is gone.
  //   3. Liquidate-before-sweep: when `liquidate: true`, residual non-quote
  //      tokens are first swapped to the quote mint via Jupiter (on the
  //      source wallet, before the sweep). The destination then only ever
  //      receives SOL, never the token - so the on-chain trace from
  //      "sub-wallet held GLOOM" to "destination received GLOOM" never
  //      forms. Token accounts are still closed for rent reclamation by
  //      the subsequent sweep call.
  gatherFunds: lockedProcedure
    .input(
      z.object({
        sourceTag: z.string().min(1),
        // Either pass a single destination (legacy/back-compat) or a list
        // of N destinations (round-robin random). At least one required.
        destinationLabel: z.string().min(1).optional(),
        destinationLabels: z.array(z.string().min(1)).optional(),
        includeTokens: z.boolean().default(true),
        // Sell residual base-token balances to SOL before sweeping. Slow
        // (one Jupiter swap per non-zero non-quote token per source) but
        // breaks the "destination received GLOOM at T+5min after sub-wallet
        // bought GLOOM" cluster signal.
        liquidate: z.boolean().default(false),
        // Slippage on the liquidation swaps (bps). Only used when liquidate=true.
        liquidateSlippageBps: z.number().int().min(1).max(5_000).default(300),
        // Inter-source phase delay (sec). [min, max] uniform random. When
        // either is > 0, concurrency is forced to 1 (sequential sweeps).
        phaseMinDelaySec: z.number().nonnegative().default(0),
        phaseMaxDelaySec: z.number().nonnegative().default(0),
        concurrency: z.number().int().min(1).max(16).default(4),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx.session.context();

      // Normalise destinations: accept either single label, array of labels,
      // or both (in which case array wins). Dedup, validate each.
      const destLabels = (input.destinationLabels && input.destinationLabels.length > 0)
        ? input.destinationLabels
        : input.destinationLabel
        ? [input.destinationLabel]
        : [];
      if (destLabels.length === 0) {
        throw new Error('must provide destinationLabel or destinationLabels');
      }
      const destinations = Array.from(new Set(destLabels)).map((label) => {
        const kp = c.vault.getKeypair(label);
        if (!kp) throw new Error(`no wallet '${label}'`);
        return { label, pubkey: kp.publicKey };
      });
      const destPubkeys = new Set(destinations.map((d) => d.pubkey.toBase58()));

      // Resolve sources, excluding any wallet that's also a destination.
      const sources = c.vault
        .filterKeypairs([input.sourceTag])
        .map((w) => w.keypair)
        .filter((kp) => !destPubkeys.has(kp.publicKey.toBase58()));
      if (sources.length === 0) {
        throw new Error(
          `no wallets tagged '${input.sourceTag}' (after excluding ${destinations.length} destination(s))`,
        );
      }

      // Phasing forces sequential execution. Concurrency only applies when
      // no delay is configured - mixing the two would make the temporal
      // distribution of sweeps batchy rather than smooth.
      const phased = input.phaseMinDelaySec > 0 || input.phaseMaxDelaySec > 0;
      const phaseMin = Math.min(input.phaseMinDelaySec, input.phaseMaxDelaySec);
      const phaseMax = Math.max(input.phaseMinDelaySec, input.phaseMaxDelaySec);

      log.info(
        {
          sources: sources.length,
          destinations: destinations.length,
          liquidate: input.liquidate,
          phased,
          phaseMin,
          phaseMax,
          includeTokens: input.includeTokens,
        },
        'gather-funds started',
      );

      // Pre-build a Jupiter venue once if we're going to liquidate; the
      // adapter is cheap (constructor only stores the connection) but we
      // want a stable LUT cache for repeated swaps to amortise loading.
      const jupiter = input.liquidate ? new JupiterVenue(c.rpc.pickConnection()) : null;
      const QUOTE_MINT = NATIVE_SOL_MINT;

      const results: { source: string; destination: string; signatures: string[]; liquidated: number }[] = [];
      const failed: { source: string; error: string }[] = [];

      const runSweep = async (kp: typeof sources[number]): Promise<void> => {
        const dest = destinations[randomInt(0, destinations.length - 1)]!;
        const sourceKey = kp.publicKey.toBase58();
        const allSigs: string[] = [];
        let liquidatedCount = 0;
        try {
          if (jupiter) {
            // Discover the source wallet's token holdings, then for each
            // non-zero, non-quote, non-zero-decimal token swap to SOL via
            // Jupiter. We do this BEFORE sweepWallet so the sweep then sees
            // a wallet holding only SOL + empty token accounts (which it
            // closes for rent reclamation).
            liquidatedCount = await liquidateTokensToQuote({
              jupiter,
              wallet: kp,
              quoteMint: QUOTE_MINT,
              slippageBps: input.liquidateSlippageBps,
              rpc: c.rpc,
              exec: c.exec,
              onSig: (sig) => allSigs.push(sig),
            });
          }
          const sweepSigs = await sweepWallet({
            rpc: c.rpc,
            exec: c.exec,
            source: kp,
            destination: dest.pubkey,
            includeTokens: input.includeTokens,
          });
          allSigs.push(...sweepSigs);
          results.push({
            source: sourceKey,
            destination: dest.pubkey.toBase58(),
            signatures: allSigs,
            liquidated: liquidatedCount,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log.error({ source: sourceKey, err: msg }, 'gather-funds source failed');
          failed.push({ source: sourceKey, error: msg });
        }
      };

      if (phased) {
        // Sequential, with a random delay between each source.
        for (let i = 0; i < sources.length; i++) {
          await runSweep(sources[i]!);
          if (i < sources.length - 1) {
            const delaySec = phaseMin === phaseMax ? phaseMin : randomFloat(phaseMin, phaseMax);
            log.info({ next: i + 1, of: sources.length, delaySec: +delaySec.toFixed(1) }, 'gather phase wait');
            await sleep(delaySec * 1000);
          }
        }
      } else {
        // Batch concurrency, no delay.
        const concurrency = Math.max(1, Math.min(input.concurrency, sources.length));
        for (let i = 0; i < sources.length; i += concurrency) {
          const batch = sources.slice(i, i + concurrency);
          await Promise.all(batch.map(runSweep));
        }
      }

      const totalTxs = results.reduce((s, r) => s + r.signatures.length, 0);
      const totalLiquidated = results.reduce((s, r) => s + r.liquidated, 0);
      log.info(
        { swept: results.length, failed: failed.length, totalTxs, totalLiquidated },
        'gather-funds done',
      );

      return {
        destinations: destinations.map((d) => ({ label: d.label, pubkey: d.pubkey.toBase58() })),
        wallets: results.map((r) => ({
          pubkey: r.source,
          destination: r.destination,
          txCount: r.signatures.length,
          firstSignature: r.signatures[0] ?? null,
          liquidatedTokens: r.liquidated,
        })),
        failed,
        totalTxs,
        totalLiquidated,
      };
    }),

  // Liquidate residual SPL token balances on every wallet matching `sourceTag`
  // back to native SOL via Jupiter, **without** sweeping. The SOL stays on
  // each source wallet, freeing them up to keep trading.
  //
  // This is the "unstick" path for the volume strategy after a stop/restart:
  // when `walletLastSide` is wiped on restart, the strict-alternate FSM
  // forces every wallet's first trade to be a buy. Wallets that still hold
  // tokens from the previous run hit `trade skipped: native SOL below swap +
  // rent reserve` because they spent down their SOL on tokens they never
  // got to sell. Calling this clears the token balances and refills SOL,
  // putting them back into a "fresh, all-SOL" state.
  //
  // Distinct from `gatherFunds(liquidate=true)` — that one liquidates *and*
  // sweeps to a destination, leaving sources at zero. This one stops after
  // the liquidation step.
  liquidateTokens: lockedProcedure
    .input(
      z.object({
        sourceTag: z.string().min(1),
        // Optional: restrict liquidation to a single mint. If unset, every
        // non-quote SPL balance on each source is liquidated. For the volume
        // strategy use-case you typically want to leave this unset so any
        // residual dust mints (e.g. from earlier experiments) get cleaned up
        // in the same pass.
        mint: z.string().min(32).max(64).optional(),
        slippageBps: z.number().int().min(1).max(5_000).default(300),
        concurrency: z.number().int().min(1).max(16).default(4),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx.session.context();
      const sources = c.vault
        .filterKeypairs([input.sourceTag])
        .map((w) => w.keypair);
      if (sources.length === 0) {
        throw new Error(`no wallets tagged '${input.sourceTag}'`);
      }

      const jupiter = new JupiterVenue(c.rpc.pickConnection());
      const QUOTE_MINT = NATIVE_SOL_MINT;
      const targetMint = input.mint ? new PublicKey(input.mint) : null;

      log.info(
        {
          sources: sources.length,
          slippageBps: input.slippageBps,
          mint: input.mint ?? 'all-non-quote',
        },
        'liquidate-tokens started',
      );

      const results: { source: string; signatures: string[]; liquidated: number }[] = [];
      const failed: { source: string; error: string }[] = [];

      const runOne = async (kp: typeof sources[number]): Promise<void> => {
        const sourceKey = kp.publicKey.toBase58();
        const sigs: string[] = [];
        try {
          const liquidated = await liquidateTokensToQuote({
            jupiter,
            wallet: kp,
            quoteMint: QUOTE_MINT,
            slippageBps: input.slippageBps,
            rpc: c.rpc,
            exec: c.exec,
            onSig: (sig) => sigs.push(sig),
            // Mint filter: when set, only that one mint is liquidated. Used
            // by the dashboard's "free SOL on these wallets" flow which
            // targets just the active pool's base mint and intentionally
            // leaves any dust from earlier experiments alone.
            mintFilter: targetMint,
          });
          results.push({ source: sourceKey, signatures: sigs, liquidated });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log.error({ source: sourceKey, err: msg }, 'liquidate-tokens source failed');
          failed.push({ source: sourceKey, error: msg });
        }
      };

      const concurrency = Math.max(1, Math.min(input.concurrency, sources.length));
      for (let i = 0; i < sources.length; i += concurrency) {
        const batch = sources.slice(i, i + concurrency);
        await Promise.all(batch.map(runOne));
      }

      const totalTxs = results.reduce((s, r) => s + r.signatures.length, 0);
      const totalLiquidated = results.reduce((s, r) => s + r.liquidated, 0);
      log.info(
        { sourcesProcessed: results.length, failed: failed.length, totalTxs, totalLiquidated },
        'liquidate-tokens done',
      );

      return {
        wallets: results.map((r) => ({
          pubkey: r.source,
          txCount: r.signatures.length,
          firstSignature: r.signatures[0] ?? null,
          liquidatedTokens: r.liquidated,
        })),
        failed,
        totalTxs,
        totalLiquidated,
      };
    }),
});

/**
 * Swap every non-zero, non-quote SPL balance held by `wallet` to the quote
 * mint via Jupiter. Returns the count of liquidations executed. The result
 * is that the wallet ends up with extra SOL and empty token accounts; the
 * caller's subsequent sweep then drains the SOL and closes the accounts to
 * reclaim rent.
 *
 * Token-2022 mints are included. Mints with 0 amount are skipped. Mints
 * whose Jupiter quote fails (no route, etc.) are logged and skipped.
 */
async function liquidateTokensToQuote(opts: {
  jupiter: JupiterVenue;
  wallet: import('@solana/web3.js').Keypair;
  quoteMint: PublicKey;
  slippageBps: number;
  rpc: import('@amm/core').RpcManager;
  exec: import('@amm/core').TxExecutor;
  onSig: (sig: string) => void;
  /**
   * Optional: restrict liquidation to a single mint. When unset, every
   * non-quote SPL balance is liquidated (dust included). Used by the
   * `liquidateTokens` endpoint to target only the active pool's base mint
   * so dust from earlier experiments isn't accidentally swept.
   */
  mintFilter?: PublicKey | null;
}): Promise<number> {
  const conn = opts.rpc.pickConnection();
  const programs = [
    new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
  ];
  let count = 0;
  for (const programId of programs) {
    let r;
    try {
      r = await conn.getParsedTokenAccountsByOwner(opts.wallet.publicKey, { programId });
    } catch (e) {
      log.warn({ programId: programId.toBase58(), err: (e as Error).message }, 'liquidate: list failed');
      continue;
    }
    for (const { account } of r.value) {
      const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } } } })
        .parsed?.info;
      if (!info?.mint || !info.tokenAmount?.amount) continue;
      const mintStr = info.mint;
      if (mintStr === opts.quoteMint.toBase58()) continue;
      if (opts.mintFilter && mintStr !== opts.mintFilter.toBase58()) continue;
      const atoms = info.tokenAmount.amount;
      if (atoms === '0' || atoms === '') continue;

      const mint = new PublicKey(mintStr);
      const amountIn = new BN(atoms);
      try {
        const built = await opts.jupiter.buildSwap({
          // Jupiter ignores poolId; pass the mint as a placeholder.
          poolId: mint,
          inputMint: mint,
          outputMint: opts.quoteMint,
          amountIn,
          user: opts.wallet.publicKey,
          slippageBps: opts.slippageBps,
        });
        let luts: AddressLookupTableAccount[] = [];
        if (built.addressLookupTables && built.addressLookupTables.length > 0) {
          luts = await opts.jupiter.loadLuts(built.addressLookupTables);
        }
        const er = await opts.exec.execute(
          opts.wallet,
          built.instructions,
          { skipPreflight: false, maxRetries: 2 },
          built.signers ?? [],
          luts,
        );
        opts.onSig(er.signature);
        count += 1;
        log.info(
          { mint: mintStr.slice(0, 6), atoms, sig: er.signature.slice(0, 12) },
          'liquidate: token swapped to quote',
        );
      } catch (e) {
        log.warn(
          { mint: mintStr.slice(0, 6), err: (e as Error).message.slice(0, 200) },
          'liquidate: swap failed; will leave token to be transferred',
        );
      }
    }
  }
  return count;
}
