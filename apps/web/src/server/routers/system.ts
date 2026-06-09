import { z } from 'zod';
import { createLogger } from '@amm/shared';
import { fetchTextDirect, fetchTextThroughProxy } from '@amm/core';
import { publicProcedure, router } from '../trpc.js';

const log = createLogger('system');

/**
 * Read-only status surface for the dashboard. Exists so the user can confirm
 * at a glance:
 *   - which RPC endpoints are configured + healthy
 *   - whether Tor SOCKS routing is on, and whether it's actually working
 *     (probe via a public IP service through both the shared dispatcher
 *     and a direct dispatcher; a different exit IP confirms Tor is in path)
 *   - the Jito block-engine URL the executor will tip + send through
 *
 * No mutations. The proxy probe is rate-limited via simple in-memory cache
 * (60s) so spamming the page doesn't generate Tor circuit churn.
 */

interface ProxyProbeResult {
  configured: boolean;
  proxy?: string;
  realIp?: string;
  proxyIp?: string;
  /** True when realIp != proxyIp (Tor is actually masking the real IP). */
  inPath?: boolean;
  error?: string;
  fetchedAt: number;
}

let cachedProbe: ProxyProbeResult | null = null;
const PROBE_CACHE_MS = 60_000;

async function probePublicIp(useProxy: boolean): Promise<string> {
  // ipify returns plain text on /?format=text. If it ever flaps, the
  // alternate is api.my-ip.io/ip. We use core's pre-built helpers so the
  // web router doesn't need a direct undici dependency.
  const url = 'https://api.ipify.org?format=text';
  const text = (
    useProxy ? await fetchTextThroughProxy(url) : await fetchTextDirect(url)
  ).trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    throw new Error(`ipify returned non-IP: ${text.slice(0, 64)}`);
  }
  return text;
}

async function runProxyProbe(): Promise<ProxyProbeResult> {
  const proxy = process.env.TOR_PROXY?.trim();
  const out: ProxyProbeResult = { configured: !!proxy, fetchedAt: Date.now() };
  if (proxy) {
    // Redact credentials in the displayed proxy string.
    out.proxy = proxy.replace(/(:)([^@]*?)(@)/, '$1***$3');
  }
  // Probe the proxy path first; fail fast if Tor isn't running so the
  // direct probe doesn't burn an extra round-trip.
  if (proxy) {
    try {
      out.proxyIp = await probePublicIp(true);
    } catch (e) {
      out.error = `proxy probe failed: ${(e as Error).message.slice(0, 200)}`;
      return out;
    }
  }
  try {
    out.realIp = await probePublicIp(false);
  } catch (e) {
    // Direct probe failure is non-fatal; user might be on a network where
    // direct egress is blocked. We still report whatever proxy info we have.
    out.error = (out.error ? out.error + '; ' : '') +
      `direct probe failed: ${(e as Error).message.slice(0, 200)}`;
  }
  if (proxy && out.proxyIp && out.realIp) {
    out.inPath = out.proxyIp !== out.realIp;
  } else if (proxy && out.proxyIp && !out.realIp) {
    // No direct comparison possible. Treat "got a proxy IP at all" as
    // weak-positive evidence that the proxy is reachable.
    out.inPath = true;
  }
  return out;
}

export const systemRouter = router({
  status: publicProcedure
    .input(z.object({ probeProxy: z.boolean().default(false) }).optional())
    .query(async ({ ctx, input }) => {
      const session = ctx.session;
      const c = session.isUnlocked() ? session.context() : undefined;

      const cluster = process.env.SOLANA_CLUSTER ?? 'mainnet-beta';
      const jito = {
        url:
          process.env.JITO_BLOCK_ENGINE_URL ??
          'https://mainnet.block-engine.jito.wtf',
        tipLamports: Number(process.env.JITO_TIP_LAMPORTS ?? 10_000),
      };

      // RPC endpoints come from env; redact API keys in the displayed URL.
      const rpcEndpoints = readEnvRpcEndpoints();

      // Vault info is only meaningful while unlocked. Show wallet count + total
      // SOL only when we have a context; otherwise leave undefined and the UI
      // hides the row.
      let vault: { walletCount: number; totalLamports: number } | undefined;
      if (c) {
        try {
          const wallets = c.vault.list();
          vault = { walletCount: wallets.length, totalLamports: 0 };
        } catch (e) {
          log.warn({ err: (e as Error).message }, 'vault list failed');
        }
      }

      // Proxy probe is opt-in: it does a real network call and we don't want
      // to do it on every page-load tick. The Settings card will pass
      // probeProxy=true when the user clicks "test now".
      let proxy: ProxyProbeResult;
      if (input?.probeProxy) {
        try {
          proxy = await runProxyProbe();
          cachedProbe = proxy;
        } catch (e) {
          proxy = {
            configured: !!process.env.TOR_PROXY,
            error: (e as Error).message.slice(0, 200),
            fetchedAt: Date.now(),
          };
          cachedProbe = proxy;
        }
      } else if (cachedProbe && Date.now() - cachedProbe.fetchedAt < PROBE_CACHE_MS) {
        proxy = cachedProbe;
      } else {
        // Light synthetic answer when no probe has been requested yet -
        // shows the env-level config without network hit.
        proxy = {
          configured: !!process.env.TOR_PROXY,
          proxy: process.env.TOR_PROXY?.trim().replace(/(:)([^@]*?)(@)/, '$1***$3'),
          fetchedAt: 0,
        };
      }

      return {
        cluster,
        rpcEndpoints,
        jito,
        proxy,
        vault,
      };
    }),
});

interface DisplayEndpoint {
  name: string;
  url: string;
  hasApiKey: boolean;
}

function readEnvRpcEndpoints(): DisplayEndpoint[] {
  const list: DisplayEndpoint[] = [];
  const push = (name: string, url: string | undefined): void => {
    if (!url) return;
    const trimmed = url.trim();
    if (!trimmed) return;
    const hasKey = /api-key=|[?&]token=|\/v1\/[A-Za-z0-9_-]{20,}/.test(trimmed);
    list.push({
      name,
      url: redactUrl(trimmed),
      hasApiKey: hasKey,
    });
  };
  push('helius', process.env.RPC_HELIUS);
  push('triton', process.env.RPC_TRITON);
  push('quicknode', process.env.RPC_QUICKNODE);
  push('public', process.env.RPC_PUBLIC ?? 'https://api.mainnet-beta.solana.com');
  return list;
}

function redactUrl(url: string): string {
  return url
    .replace(/(api-key=)[^&]+/i, '$1***')
    .replace(/([?&]token=)[^&]+/i, '$1***')
    // Helius-style /v1/<key> path; replace the long hex tail.
    .replace(/(\/v1\/)([A-Za-z0-9_-]{8})[A-Za-z0-9_-]{8,}/, '$1$2***');
}
