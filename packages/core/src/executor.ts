import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Signer,
  type TransactionInstruction,
} from '@solana/web3.js';
import { createLogger, JITO_TIP_ACCOUNTS, pick, sleep } from '@amm/shared';
import type { ExecuteOptions, ExecuteResult } from '@amm/shared';
import { fetchJson } from './http.js';
import type { RpcManager } from './rpc.js';

const log = createLogger('exec');

const DEFAULT_CU_LIMIT = 600_000;
const DEFAULT_PRIORITY_FEE = 50_000; // micro-lamports per CU

export interface ExecutorConfig {
  /** Default priority fee (micro-lamports per CU). Used when none supplied or estimation fails. */
  defaultPriorityMicroLamports?: number;
  /** Default compute unit limit. */
  defaultComputeUnitLimit?: number;
  /** Default Jito tip in lamports. */
  defaultJitoTipLamports?: number;
  /** Jito block engine base URL. */
  jitoBlockEngineUrl?: string;
}

export class TxExecutor {
  private readonly cfg: Required<ExecutorConfig>;

  constructor(
    private readonly rpc: RpcManager,
    cfg: ExecutorConfig = {},
  ) {
    this.cfg = {
      defaultPriorityMicroLamports:
        cfg.defaultPriorityMicroLamports ?? DEFAULT_PRIORITY_FEE,
      defaultComputeUnitLimit: cfg.defaultComputeUnitLimit ?? DEFAULT_CU_LIMIT,
      defaultJitoTipLamports:
        cfg.defaultJitoTipLamports ?? Number(process.env.JITO_TIP_LAMPORTS ?? 10_000),
      jitoBlockEngineUrl:
        cfg.jitoBlockEngineUrl ??
        process.env.JITO_BLOCK_ENGINE_URL ??
        'https://mainnet.block-engine.jito.wtf',
    };
  }

  /**
   * Build a versioned transaction with compute budget instructions prepended.
   * Does not sign.
   */
  async build(
    payer: PublicKey,
    instructions: TransactionInstruction[],
    options: ExecuteOptions = {},
    luts: AddressLookupTableAccount[] = [],
  ): Promise<{ tx: VersionedTransaction; blockhash: string; lastValidBlockHeight: number }> {
    const cuLimit = options.computeUnitLimit ?? this.cfg.defaultComputeUnitLimit;
    const cuPrice = options.priorityMicroLamports ?? this.cfg.defaultPriorityMicroLamports;

    const cb = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
    ];

    const { blockhash, lastValidBlockHeight } = await this.rpc.getLatestBlockhash();

    const msg = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions: [...cb, ...instructions],
    }).compileToV0Message(luts);

    return { tx: new VersionedTransaction(msg), blockhash, lastValidBlockHeight };
  }

  /**
   * Simulate a versioned tx and throw on logical failure (program errors, etc).
   * Returns simulation logs.
   */
  async simulate(tx: VersionedTransaction): Promise<string[]> {
    const sim = await this.rpc.simulateVersioned(tx);
    if (sim.value.err) {
      const logs = sim.value.logs?.join('\n  ') ?? '<no logs>';
      throw new Error(
        `simulation failed: ${JSON.stringify(sim.value.err)}\nlogs:\n  ${logs}`,
      );
    }
    return sim.value.logs ?? [];
  }

  /**
   * Build, sign, simulate (unless `skipPreflight`), and send a transaction. If
   * `useJito` is set, sends through the Jito block engine with a tip transfer
   * appended.
   *
   * Retries on blockhash expiry by rebuilding with a fresh blockhash.
   */
  async execute(
    payer: Keypair,
    instructions: TransactionInstruction[],
    options: ExecuteOptions = {},
    extraSigners: Signer[] = [],
    luts: AddressLookupTableAccount[] = [],
  ): Promise<ExecuteResult> {
    const maxRetries = options.maxRetries ?? 3;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const ixs = [...instructions];
        if (options.useJito) {
          ixs.push(this.buildJitoTipIx(payer.publicKey, options.jitoTipLamports));
        }

        const { tx, blockhash, lastValidBlockHeight } = await this.build(
          payer.publicKey,
          ixs,
          options,
          luts,
        );
        tx.sign([payer, ...extraSigners]);

        if (!options.skipPreflight) {
          await this.simulate(tx);
        }

        const raw = Buffer.from(tx.serialize());

        let sig: string;
        if (options.useJito) {
          sig = await this.sendViaJito(raw);
        } else {
          sig = await this.rpc.sendRawTransactionFanout(raw, {
            skipPreflight: true,
            maxRetries: 0,
          });
        }

        const conf = await this.rpc.confirmTransaction(sig, blockhash, lastValidBlockHeight);
        if (conf.value.err) {
          throw new Error(`tx failed on-chain: ${JSON.stringify(conf.value.err)}`);
        }
        log.info({ sig, attempt }, 'tx confirmed');
        return { signature: sig, confirmed: true };
      } catch (e) {
        lastErr = e;
        const msg = (e as Error).message ?? String(e);
        const transient =
          msg.includes('blockhash') ||
          msg.includes('timed out') ||
          msg.includes('Node is behind') ||
          msg.includes('429');
        log.warn(
          { attempt, transient, err: msg.slice(0, 4000) },
          transient ? 'transient tx error, retrying' : 'tx error',
        );
        if (!transient) break;
        await sleep(500 * (attempt + 1));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /**
   * Send a Jito bundle of multiple pre-signed versioned transactions.
   * Returns the bundle id.
   */
  async sendJitoBundle(transactions: VersionedTransaction[]): Promise<string> {
    if (transactions.length === 0 || transactions.length > 5) {
      throw new Error(`bundle must contain 1-5 transactions, got ${transactions.length}`);
    }
    const encodedTxs = transactions.map((t) => Buffer.from(t.serialize()).toString('base64'));
    type RpcResp = { result?: string; error?: { message: string; code: number } };
    const resp = await fetchJson<RpcResp>(`${this.cfg.jitoBlockEngineUrl}/api/v1/bundles`, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [encodedTxs, { encoding: 'base64' }],
      }),
    });
    if (resp.error) throw new Error(`jito bundle error: ${resp.error.message}`);
    if (!resp.result) throw new Error('jito bundle: no result');
    log.info({ bundleId: resp.result, txs: transactions.length }, 'jito bundle sent');
    return resp.result;
  }

  buildJitoTipIx(from: PublicKey, lamportsOverride?: number): TransactionInstruction {
    const lamports = lamportsOverride ?? this.cfg.defaultJitoTipLamports;
    const tipAccount = new PublicKey(pick(JITO_TIP_ACCOUNTS));
    return SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: tipAccount,
      lamports,
    });
  }

  private async sendViaJito(raw: Buffer): Promise<string> {
    type RpcResp = { result?: string; error?: { message: string; code: number } };
    const resp = await fetchJson<RpcResp>(`${this.cfg.jitoBlockEngineUrl}/api/v1/transactions`, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [raw.toString('base64'), { encoding: 'base64' }],
      }),
    });
    if (resp.error) throw new Error(`jito send error: ${resp.error.message}`);
    if (!resp.result) throw new Error('jito send: no result');
    return resp.result;
  }

  /**
   * Estimate a sane priority fee from recent priority-fee samples on a hot account.
   * Falls back to the configured default on failure.
   */
  async estimatePriorityFee(hotKeys: PublicKey[] = []): Promise<number> {
    try {
      const conn = this.rpc.pickConnection();
      const samples = await conn.getRecentPrioritizationFees({
        lockedWritableAccounts: hotKeys.slice(0, 8),
      });
      if (samples.length === 0) return this.cfg.defaultPriorityMicroLamports;
      const sorted = samples.map((s) => s.prioritizationFee).sort((a, b) => a - b);
      // 75th percentile so we land in the upper-but-not-crazy band.
      const p75 = sorted[Math.floor(sorted.length * 0.75)] ?? this.cfg.defaultPriorityMicroLamports;
      return Math.max(this.cfg.defaultPriorityMicroLamports, p75);
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'priority fee estimation failed');
      return this.cfg.defaultPriorityMicroLamports;
    }
  }
}
