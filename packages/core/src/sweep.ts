import {
  Keypair,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import { createLogger, sleep } from '@amm/shared';
import type { TxExecutor } from './executor.js';
import type { RpcManager } from './rpc.js';

const log = createLogger('sweep');

const SPL_TOKEN_PROGRAMS: PublicKey[] = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

/**
 * Reclaim every token + lamport balance from a sub-wallet to a destination
 * wallet. Closes any token accounts on the way (recovers rent).
 *
 * Replaces legacy/gather.ts. Cleaner: no SDK swap needed (the strategy layer
 * decides whether to swap before sweeping; sweep is purely a custodial move).
 */
export async function sweepWallet(opts: {
  rpc: RpcManager;
  exec: TxExecutor;
  source: Keypair;
  destination: PublicKey;
  /** If true, transfer token balances (and close token accounts). */
  includeTokens?: boolean;
  /** Skip token mints in this set. Useful to leave a balance in a position-related token. */
  skipMints?: Set<string>;
}): Promise<string[]> {
  const includeTokens = opts.includeTokens ?? true;
  const sigs: string[] = [];
  const conn = opts.rpc.pickConnection();

  if (includeTokens) {
    // Fetch accounts from BOTH the legacy SPL Token program and Token-2022.
    // Token-2022 mints (e.g. pump.fun's `…pump` mints, all Solana-native fee
    // configs, etc.) live under a different program id and won't show up
    // when querying TOKEN_PROGRAM_ID alone - they'd be silently stranded
    // on the source wallet after a sweep.
    type DiscoveredToken = {
      pubkey: PublicKey;
      data: Buffer;
      tokenProgramId: PublicKey;
    };
    const discovered: DiscoveredToken[] = [];
    for (const programId of SPL_TOKEN_PROGRAMS) {
      try {
        const r = await conn.getTokenAccountsByOwner(opts.source.publicKey, { programId });
        for (const { pubkey, account } of r.value) {
          discovered.push({ pubkey, data: account.data, tokenProgramId: programId });
        }
      } catch (e) {
        log.warn(
          { programId: programId.toBase58(), err: (e as Error).message },
          'failed to list token accounts for program',
        );
      }
    }

    for (const { pubkey, data, tokenProgramId } of discovered) {
      // Decode token amount from the SPL Token account layout (offset 64..72 = u64 amount, offset 0..32 = mint).
      // Token-2022 accounts are 165+ bytes (extension data tacked on the end) but the base layout matches.
      const mint = new PublicKey(data.subarray(0, 32));
      if (opts.skipMints?.has(mint.toBase58())) continue;

      const amountBuf = data.subarray(64, 72);
      const amount = amountBuf.readBigUInt64LE(0);

      const ixs: TransactionInstruction[] = [];
      if (amount > 0n) {
        // ATA derivation is program-aware: the token program id is part of
        // the seed, so a Token-2022 ATA lives at a different address than
        // the classic ATA for the same mint+owner.
        const destAta = await getAssociatedTokenAddress(
          mint,
          opts.destination,
          /* allowOwnerOffCurve */ false,
          tokenProgramId,
        );
        const mintInfo = await conn.getParsedAccountInfo(mint);
        const decimals =
          (mintInfo.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info
            ?.decimals ?? 0;
        ixs.push(
          // Pay from `source` (the only signer on this tx) rather than the
          // destination. Same final state - the dest still owns the ATA -
          // but the tx no longer needs the destination's signature when
          // the ATA needs creating. Cost: ~0.00204 SOL of source's
          // pre-drain balance (one-time per mint per dest, idempotent).
          createAssociatedTokenAccountIdempotentInstruction(
            opts.source.publicKey,
            destAta,
            opts.destination,
            mint,
            tokenProgramId,
          ),
        );
        ixs.push(
          createTransferCheckedInstruction(
            pubkey,
            mint,
            destAta,
            opts.source.publicKey,
            amount,
            decimals,
            [],
            tokenProgramId,
          ),
        );
      }
      ixs.push(
        createCloseAccountInstruction(
          pubkey,
          opts.destination,
          opts.source.publicKey,
          [],
          tokenProgramId,
        ),
      );

      try {
        // priorityMicroLamports: 0 - sweeps are not latency-sensitive, no MEV
        // race. Avoids wasting ~30k lamports per token sweep on default priority.
        const r = await opts.exec.execute(opts.source, ixs, {
          priorityMicroLamports: 0,
        });
        sigs.push(r.signature);
      } catch (e) {
        log.warn(
          {
            mint: mint.toBase58(),
            tokenProgram: tokenProgramId.toBase58(),
            err: (e as Error).message,
          },
          'failed to sweep token account',
        );
      }
      await sleep(200);
    }
  }

  // SOL drain: reserve exactly the tx fee so the source wallet ends at 0.
  // Pin priority fee + CU limit explicitly so the reserve calculation stays
  // correct regardless of executor defaults (the previous hardcoded 5_000
  // reserve underflowed when default priority * CU limit was non-zero, e.g.
  // 100_000 CU * 50_000 micro-lamports/CU = 5_000 extra lamports needed).
  const SOL_DRAIN_CU_LIMIT = 1_000; // SystemProgram.transfer uses ~150 CU
  const SOL_DRAIN_PRIORITY = 0;
  const baseSignatureFee = 5_000;
  const priorityFeeLamports = Math.ceil(
    (SOL_DRAIN_CU_LIMIT * SOL_DRAIN_PRIORITY) / 1_000_000,
  );
  const txFee = baseSignatureFee + priorityFeeLamports;
  const balance = await opts.rpc.getBalance(opts.source.publicKey);
  const send = balance - txFee;
  if (send > 0) {
    const ix = SystemProgram.transfer({
      fromPubkey: opts.source.publicKey,
      toPubkey: opts.destination,
      lamports: send,
    });
    try {
      const r = await opts.exec.execute(opts.source, [ix], {
        computeUnitLimit: SOL_DRAIN_CU_LIMIT,
        priorityMicroLamports: SOL_DRAIN_PRIORITY,
      });
      sigs.push(r.signature);
    } catch (e) {
      log.warn({ err: (e as Error).message, balance, txFee, send }, 'failed to sweep sol');
    }
  }
  log.info(
    { source: opts.source.publicKey.toBase58(), txs: sigs.length },
    'wallet sweep complete',
  );
  return sigs;
}

export async function sweepAll(opts: {
  rpc: RpcManager;
  exec: TxExecutor;
  sources: Keypair[];
  destination: PublicKey;
  includeTokens?: boolean;
  /** Concurrent sweeps (default 4). Use 1 for sequential. */
  concurrency?: number;
}): Promise<{ wallet: string; signatures: string[] }[]> {
  const concurrency = opts.concurrency ?? 4;
  const out: { wallet: string; signatures: string[] }[] = [];
  for (let i = 0; i < opts.sources.length; i += concurrency) {
    const batch = opts.sources.slice(i, i + concurrency);
    const res = await Promise.all(
      batch.map(async (kp) => ({
        wallet: kp.publicKey.toBase58(),
        signatures: await sweepWallet({
          rpc: opts.rpc,
          exec: opts.exec,
          source: kp,
          destination: opts.destination,
          includeTokens: opts.includeTokens,
        }),
      })),
    );
    out.push(...res);
  }
  return out;
}
