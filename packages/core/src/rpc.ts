import {
  Connection,
  type ConnectionConfig,
  type Commitment,
  type GetVersionedTransactionConfig,
  type RpcResponseAndContext,
  type SignatureResult,
  type TransactionSignature,
  type VersionedTransaction,
  type SendOptions,
  type Transaction,
  type Signer,
} from '@solana/web3.js';
import { fetch as undiciFetch } from 'undici';
import { createLogger } from '@amm/shared';
import { closeDispatcher, getDispatcher } from './http.js';
import { rotateTorCircuit, torControlConfigFromEnv, type TorControlConfig } from './tor-control.js';

const log = createLogger('rpc');

/**
 * If TOR_CONTROL_* is configured, fire `SIGNAL NEWNYM` after sustained 429s.
 *
 * Read of env is deliberately lazy: `treasury/src/cli.ts` calls `dotenv.config()`
 * AFTER its top-level imports, so reading `process.env.TOR_CONTROL_*` at module
 * eval time sees an empty environment. Probing on first call sees the loaded env.
 *
 * State here is module-scoped (one per process) — the MM web app and the
 * treasury engine each have their own RpcManager and their own control port,
 * so they rotate independently.
 */
let torControlProbed = false;
let torControlCfg: TorControlConfig | null = null;
let lastTorRotationAt = 0;
let torRotationInFlight = false;
const TOR_ROTATION_MIN_INTERVAL_MS = 30_000;

function getTorControlCfg(): TorControlConfig | null {
  if (torControlProbed) return torControlCfg;
  torControlProbed = true;
  torControlCfg = torControlConfigFromEnv();
  if (torControlCfg) {
    log.info(
      {
        host: torControlCfg.host,
        port: torControlCfg.port,
        auth: torControlCfg.cookiePath ? 'cookie' : 'password',
      },
      'tor circuit rotation enabled (triggered on 429)',
    );
  }
  return torControlCfg;
}

async function rotateTorOnce(cfg: TorControlConfig): Promise<void> {
  await rotateTorCircuit(cfg);
  // Drop pooled sockets so the next request opens a fresh circuit.
  await closeDispatcher();
}

function maybeRotateTor(): void {
  const cfg = getTorControlCfg();
  if (!cfg) return;
  const now = Date.now();
  if (torRotationInFlight) return;
  if (now - lastTorRotationAt < TOR_ROTATION_MIN_INTERVAL_MS) return;
  torRotationInFlight = true;
  rotateTorOnce(cfg)
    .then(() => {
      lastTorRotationAt = Date.now();
    })
    .catch((e) => log.warn({ err: (e as Error).message }, 'tor rotation failed'))
    .finally(() => {
      torRotationInFlight = false;
    });
}

export interface RpcEndpoint {
  /** Friendly name (e.g. "helius", "triton", "public"). Used in logs and budgets. */
  name: string;
  url: string;
  /** Optional websocket URL (use the http url's ws variant if omitted). */
  ws?: string;
  /** Per-second request budget. Defaults to no limit. */
  ratePerSecond?: number;
  /** Weight in load-balancing (default 1). Higher = more requests routed here. */
  weight?: number;
}

interface EndpointState {
  ep: RpcEndpoint;
  conn: Connection;
  recentErrors: number;
  recentRequests: number[]; // unix-ms timestamps of last second
  unhealthyUntil: number;
}

function endpointsFromEnv(): RpcEndpoint[] {
  const list: RpcEndpoint[] = [];
  const helius = process.env.RPC_HELIUS?.trim();
  const triton = process.env.RPC_TRITON?.trim();
  const quicknode = process.env.RPC_QUICKNODE?.trim();

  if (helius) {
    list.push({
      name: 'helius',
      url: helius,
      ws: process.env.RPC_WS_HELIUS?.trim(),
      ratePerSecond: 30,
      weight: 4,
    });
  }
  if (triton) {
    list.push({ name: 'triton', url: triton, ratePerSecond: 30, weight: 4 });
  }
  if (quicknode) {
    list.push({ name: 'quicknode', url: quicknode, ratePerSecond: 30, weight: 4 });
  }
  // Public mainnet-beta RPC: globally rate-limited at ~5 RPS per source IP. Behind
  // Tor that means the entire shared exit IP pool fights for the same budget — it
  // is effectively perma-429, and every fraction of traffic the load balancer
  // routes there burns ~7.5s on web3.js's internal retry chain before falling
  // through to a paid endpoint.
  //
  //   RPC_PUBLIC unset       -> default ON only when no paid endpoint is configured
  //                             (small projects + e2e tests still want a usable RPC)
  //   RPC_PUBLIC=""          -> explicit OPT OUT (recommended once you have helius/triton/quicknode)
  //   RPC_PUBLIC=https://... -> explicit URL, included regardless of paid endpoints
  const pubRaw = process.env.RPC_PUBLIC;
  const pubTrimmed = pubRaw === undefined ? undefined : pubRaw.trim();
  let pubUrl: string | undefined;
  if (pubTrimmed === undefined) {
    if (list.length === 0) pubUrl = 'https://api.mainnet-beta.solana.com';
  } else if (pubTrimmed.length > 0) {
    pubUrl = pubTrimmed;
  } // pubTrimmed === '' → explicit opt-out, leave pubUrl undefined
  if (pubUrl) {
    list.push({
      name: 'public',
      url: pubUrl,
      ws: process.env.RPC_WS_PUBLIC?.trim() ?? 'wss://api.mainnet-beta.solana.com',
      ratePerSecond: 5,
      weight: 1,
    });
  }
  if (list.length === 0) {
    throw new Error(
      'no RPC endpoints configured: set RPC_HELIUS / RPC_TRITON / RPC_QUICKNODE, or unset RPC_PUBLIC',
    );
  }
  return list;
}

/**
 * Multi-RPC manager.
 *
 * Wraps N Solana Connections with health checks, rate limiting, weighted
 * routing, and a thin convenience surface for the most common ops.
 *
 * - Reads (`getBalance`, `getAccountInfo`, ...) are routed to a healthy endpoint
 *   chosen by weight. Anonymity benefit: requests are sprayed across providers
 *   so no single provider sees your full pattern.
 * - Writes (`sendRawTransaction`) are fanned out to ALL healthy endpoints to
 *   maximise inclusion odds.
 */
export class RpcManager {
  private readonly states: EndpointState[];
  private readonly commitment: Commitment;

  constructor(endpoints: RpcEndpoint[] = endpointsFromEnv(), commitment: Commitment = 'confirmed') {
    if (endpoints.length === 0) {
      throw new Error('RpcManager requires at least one endpoint');
    }
    this.commitment = commitment;
    this.states = endpoints.map((ep) => {
      const cfg: ConnectionConfig = {
        commitment,
        confirmTransactionInitialTimeout: 60_000,
        wsEndpoint: ep.ws,
        // Route fetches through our shared dispatcher (Tor-aware).
        fetch: ((input: string, init?: { method?: string; headers?: unknown; body?: unknown }) => {
          return undiciFetch(input, { ...init, dispatcher: getDispatcher() } as never) as never;
        }) as never,
      };
      return {
        ep,
        conn: new Connection(ep.url, cfg),
        recentErrors: 0,
        recentRequests: [],
        unhealthyUntil: 0,
      };
    });
    log.info(
      { endpoints: this.states.map((s) => ({ name: s.ep.name, weight: s.ep.weight ?? 1 })) },
      'rpc manager initialised',
    );
    // Probe TOR_CONTROL_* now (env is loaded by this point) so the user sees
    // "rotation enabled" at startup, not after the first 429.
    getTorControlCfg();
  }

  /** All wrapped Connection instances (read-only). */
  get connections(): readonly Connection[] {
    return this.states.map((s) => s.conn);
  }

  /** Pick a healthy endpoint by weighted random, respecting rate limits. */
  pickConnection(): Connection {
    const now = Date.now();
    const healthy = this.states.filter((s) => {
      if (s.unhealthyUntil > now) return false;
      // Rate limit window
      s.recentRequests = s.recentRequests.filter((t) => t > now - 1000);
      const limit = s.ep.ratePerSecond;
      if (limit && s.recentRequests.length >= limit) return false;
      return true;
    });
    const pool = healthy.length > 0 ? healthy : this.states;
    const totalWeight = pool.reduce((s, e) => s + (e.ep.weight ?? 1), 0);
    let r = Math.random() * totalWeight;
    for (const s of pool) {
      r -= s.ep.weight ?? 1;
      if (r <= 0) {
        s.recentRequests.push(now);
        return s.conn;
      }
    }
    const last = pool[pool.length - 1]!;
    last.recentRequests.push(now);
    return last.conn;
  }

  /** Mark an endpoint unhealthy for a cooloff period. */
  markUnhealthy(
    conn: Connection,
    cooloffMs = 30_000,
    ctx?: { cause?: string; err?: string },
  ): void {
    const s = this.states.find((x) => x.conn === conn);
    if (!s) return;
    s.recentErrors++;
    s.unhealthyUntil = Date.now() + cooloffMs;
    log.warn(
      {
        name: s.ep.name,
        cooloffMs,
        cause: ctx?.cause,
        err: ctx?.err,
      },
      'endpoint marked unhealthy',
    );
  }

  /**
   * Convenience: run a read with retries across endpoints on failure.
   *
   * 429 ("Too Many Requests") gets special treatment: longer endpoint cooloff
   * (30s, vs 5s for generic errors) and exponential backoff between attempts
   * (1s -> 3s -> 9s). Without this, a Tor exit IP that just got rate-limited
   * by Helius gets re-hammered immediately and burns the whole retry budget.
   */
  async withRetry<T>(fn: (c: Connection) => Promise<T>, attempts = 3): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      const conn = this.pickConnection();
      try {
        return await fn(conn);
      } catch (e) {
        lastErr = e;
        const msg = (e as { message?: string })?.message ?? String(e);
        const is429 = /\b429\b|too many requests/i.test(msg);
        // Dead/dropped Tor circuit fingerprints. undici tends to surface these
        // as `fetch failed` with one of these inner causes; keep matching loose
        // because the wording shifts across undici/node versions.
        const isSocketDrop =
          !is429 &&
          /fetch failed|socketerror|other side closed|econnreset|econnrefused|etimedout|und_err_socket|und_err_connect|socks/i.test(
            msg,
          );
        const cause = is429 ? '429' : isSocketDrop ? 'tor-socket-drop' : 'other';
        // 429 from a shared Tor exit takes a while to clear at the upstream
        // provider; 5s often re-trips. 30s gives the Tor circuit + provider
        // bucket a chance to recover. Socket drops behind Tor mean THIS exit
        // is unusable — same 30s cooloff so retries don't reuse it. Generic
        // errors keep the original 5s.
        const cooloffMs = is429 || isSocketDrop ? 30_000 : 5_000;
        this.markUnhealthy(conn, cooloffMs, {
          cause,
          err: msg.slice(0, 300),
        });
        // Both 429 and dead-circuit cases benefit from a fresh Tor exit IP.
        // `maybeRotateTor` is internally a no-op when Tor control isn't
        // configured, and is rate-limited to ≥30s between rotations so a
        // burst of failures all firing this can't thrash circuits.
        if (is429 || isSocketDrop) maybeRotateTor();
        if (i + 1 < attempts) {
          // Backoff schedule: 429 → 1s, 3s, 9s (provider bucket recovery).
          // Tor-socket-drop → 0.5s, 1.5s, 4.5s (NEWNYM is async; give it a
          // moment to take, then close the dispatcher pool).
          const delayMs = is429
            ? 1000 * Math.pow(3, i)
            : isSocketDrop
              ? Math.round(500 * Math.pow(3, i))
              : 0;
          if (delayMs > 0) {
            log.warn(
              {
                name: this.states.find((s) => s.conn === conn)?.ep.name,
                attempt: i,
                delayMs,
                cause,
              },
              'rpc backoff before next attempt',
            );
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }
      }
    }
    throw lastErr;
  }

  /**
   * Fan out a raw transaction send to every healthy endpoint. Returns the first
   * successful signature. Resolves quickly since send is fire-and-forget at the
   * RPC layer; confirmation is handled separately.
   */
  async sendRawTransactionFanout(
    raw: Buffer | Uint8Array,
    options: SendOptions = { skipPreflight: true, maxRetries: 0 },
  ): Promise<TransactionSignature> {
    const now = Date.now();
    const targets = this.states.filter((s) => s.unhealthyUntil <= now);
    const pool = targets.length > 0 ? targets : this.states;
    const promises = pool.map((s) =>
      s.conn
        .sendRawTransaction(raw, options)
        .then((sig) => ({ sig, name: s.ep.name }))
        .catch((e: unknown) => {
          this.markUnhealthy(s.conn, 5_000);
          return { error: e as Error, name: s.ep.name };
        }),
    );
    // Race for first success
    const results = await Promise.allSettled(promises);
    for (const r of results) {
      if (r.status === 'fulfilled' && 'sig' in r.value) {
        log.debug({ via: r.value.name, sig: r.value.sig }, 'tx sent');
        return r.value.sig;
      }
    }
    const errors = results
      .map((r) => (r.status === 'fulfilled' && 'error' in r.value ? r.value.error.message : ''))
      .filter(Boolean)
      .join(' | ');
    throw new Error(`all RPC sends failed: ${errors || 'unknown'}`);
  }

  async confirmTransaction(
    signature: TransactionSignature,
    blockhash: string,
    lastValidBlockHeight: number,
    commitment: Commitment = this.commitment,
  ): Promise<RpcResponseAndContext<SignatureResult>> {
    return this.withRetry((c) =>
      c.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, commitment),
    );
  }

  async getLatestBlockhash(commitment: Commitment = this.commitment) {
    return this.withRetry((c) => c.getLatestBlockhash(commitment));
  }

  async getBalance(pubkey: import('@solana/web3.js').PublicKey, commitment?: Commitment) {
    return this.withRetry((c) => c.getBalance(pubkey, commitment ?? this.commitment));
  }

  async getAccountInfo(
    pubkey: import('@solana/web3.js').PublicKey,
    commitment?: Commitment,
  ) {
    return this.withRetry((c) => c.getAccountInfo(pubkey, commitment ?? this.commitment));
  }

  async getTransaction(
    sig: TransactionSignature,
    cfg: GetVersionedTransactionConfig = { maxSupportedTransactionVersion: 0 },
  ) {
    return this.withRetry((c) => c.getTransaction(sig, cfg));
  }

  async simulateLegacy(tx: Transaction, signers: Signer[]) {
    return this.withRetry((c) => c.simulateTransaction(tx, signers));
  }

  async simulateVersioned(tx: VersionedTransaction) {
    return this.withRetry((c) =>
      c.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true }),
    );
  }
}
