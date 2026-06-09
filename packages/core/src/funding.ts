import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js';
import { createLogger, randomFloat, randomInt, sleep } from '@amm/shared';
import type { TxExecutor } from './executor.js';
import type { RpcManager } from './rpc.js';
import type { Store } from './store.js';

const log = createLogger('funding');

export interface MultiHopFundingConfig {
  /** Min number of intermediate hops. */
  minHops?: number;
  /** Max number of intermediate hops. */
  maxHops?: number;
  /** Min delay between hops (ms). */
  minHopDelayMs?: number;
  /** Max delay between hops (ms). */
  maxHopDelayMs?: number;
  /** Lamports left in each intermediate wallet (covers rent & accidental dust). */
  intermediateReserveLamports?: number;
  /** Whether to use Jito bundles (atomic but on-chain visible as bundle). */
  useJito?: boolean;
}

// Hop transfers don't need any priority fee or much CU. We pin them low so
// the per-hop on-chain cost is exactly base_fee + small_priority and the
// reserve maths below is deterministic regardless of executor defaults.
const HOP_CU_LIMIT = 1_000;
const HOP_PRIORITY_MICRO_LAMPORTS = 0;
const HOP_BASE_FEE = 5_000;
// micro-lamports per CU * cu_limit / 1e6, rounded up
const HOP_PRIORITY_FEE = Math.ceil((HOP_CU_LIMIT * HOP_PRIORITY_MICRO_LAMPORTS) / 1_000_000);
const HOP_TX_FEE_LAMPORTS = HOP_BASE_FEE + HOP_PRIORITY_FEE;

const DEFAULTS: Required<MultiHopFundingConfig> = {
  minHops: 3,
  maxHops: 7,
  minHopDelayMs: 1_500,
  maxHopDelayMs: 8_000,
  // Reserve must cover the actual hop tx fee (base + priority); see HOP_TX_FEE_LAMPORTS.
  // We pad slightly so a future bump in priority doesn't immediately re-break this.
  intermediateReserveLamports: HOP_TX_FEE_LAMPORTS,
  useJito: false,
};

/**
 * Move SOL from `funder` to `target` through a chain of N freshly-generated
 * intermediate wallets. Each hop sleeps a randomized amount and uses a
 * randomized amount transferred from the prior wallet. Breaks the on-chain
 * trace from operator wallet to trading sub-wallet.
 *
 * The intermediate keypairs exist only in memory - they are never written to
 * the vault. After the funds reach `target`, the intermediates hold only the
 * configured reserve lamports.
 *
 * Returns the set of signatures, in hop order.
 */
export async function multiHopFund(opts: {
  rpc: RpcManager;
  exec: TxExecutor;
  funder: Keypair;
  target: PublicKey;
  lamports: number;
  store?: Store;
  runId?: number;
  config?: MultiHopFundingConfig;
}): Promise<{ signatures: string[]; intermediates: PublicKey[] }> {
  const cfg = { ...DEFAULTS, ...(opts.config ?? {}) };
  const hops = randomInt(cfg.minHops, cfg.maxHops);
  log.info(
    {
      from: opts.funder.publicKey.toBase58(),
      to: opts.target.toBase58(),
      sol: opts.lamports / LAMPORTS_PER_SOL,
      hops,
    },
    'multi-hop funding starting',
  );

  const intermediates = Array.from({ length: hops }, () => Keypair.generate());
  const signatures: string[] = [];
  const reserve = cfg.intermediateReserveLamports;

  let from = opts.funder;
  let amount = opts.lamports + (hops + 1) * reserve; // pad so the final wallet receives `lamports`

  for (let i = 0; i <= hops; i++) {
    const isLast = i === hops;
    const to = isLast ? opts.target : intermediates[i]!.publicKey;
    const sendAmount = isLast ? opts.lamports : amount - reserve;

    const ix: TransactionInstruction = SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports: sendAmount,
    });

    // Pin CU limit + priority to known values so the actual on-chain fee
    // matches `HOP_TX_FEE_LAMPORTS` exactly. Default executor priority is
    // 50k microLamports/CU * 600k CU = 30k lamports, which would consume
    // the entire 5k-lamport reserve on every hop and break the chain on
    // the second hop with "insufficient lamports" (off by ~30k lamports).
    const result = await opts.exec.execute(from, [ix], {
      useJito: cfg.useJito,
      computeUnitLimit: HOP_CU_LIMIT,
      priorityMicroLamports: HOP_PRIORITY_MICRO_LAMPORTS,
    });
    signatures.push(result.signature);
    opts.store?.recordHop({
      runId: opts.runId ?? null,
      fromWallet: from.publicKey.toBase58(),
      toWallet: to.toBase58(),
      lamports: sendAmount,
      signature: result.signature,
      hopIndex: i,
    });

    if (!isLast) {
      from = intermediates[i]!;
      amount = sendAmount;
      const delay = randomInt(cfg.minHopDelayMs, cfg.maxHopDelayMs);
      log.debug({ hop: i, delay }, 'sleeping between hops');
      await sleep(delay);
    }
  }

  log.info(
    {
      to: opts.target.toBase58(),
      hops,
      signatures: signatures.length,
    },
    'multi-hop funding done',
  );
  return { signatures, intermediates: intermediates.map((k) => k.publicKey) };
}

/**
 * Distribute SOL across a fleet of sub-wallets with randomized amounts to
 * avoid the visible "all received exactly 0.05 SOL" pattern.
 */
export async function distributeSol(opts: {
  rpc: RpcManager;
  exec: TxExecutor;
  funder: Keypair;
  recipients: PublicKey[];
  /** Mean lamports per recipient. */
  meanLamports: number;
  /** Standard deviation as a fraction of mean (default 0.15). */
  jitterFraction?: number;
  /** Optional multi-hop indirection per recipient. */
  hop?: MultiHopFundingConfig | false;
  store?: Store;
  runId?: number;
}): Promise<{ recipient: string; lamports: number; signatures: string[] }[]> {
  const jitter = opts.jitterFraction ?? 0.15;
  const results: { recipient: string; lamports: number; signatures: string[] }[] = [];

  for (const recipient of opts.recipients) {
    const factor = 1 + randomFloat(-jitter, jitter);
    const lamports = Math.max(0, Math.round(opts.meanLamports * factor));

    if (opts.hop === false || opts.hop === undefined) {
      const ix = SystemProgram.transfer({
        fromPubkey: opts.funder.publicKey,
        toPubkey: recipient,
        lamports,
      });
      // Direct funding: no priority fee needed (not latency-sensitive).
      const r = await opts.exec.execute(opts.funder, [ix], {
        computeUnitLimit: HOP_CU_LIMIT,
        priorityMicroLamports: HOP_PRIORITY_MICRO_LAMPORTS,
      });
      results.push({ recipient: recipient.toBase58(), lamports, signatures: [r.signature] });
    } else {
      const r = await multiHopFund({
        rpc: opts.rpc,
        exec: opts.exec,
        funder: opts.funder,
        target: recipient,
        lamports,
        store: opts.store,
        runId: opts.runId,
        config: opts.hop,
      });
      results.push({
        recipient: recipient.toBase58(),
        lamports,
        signatures: r.signatures,
      });
    }
  }
  return results;
}
