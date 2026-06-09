import { Agent, ProxyAgent, buildConnector, fetch as undiciFetch, type RequestInit } from 'undici';
import { SocksClient, type SocksProxy } from 'socks';
import * as tls from 'node:tls';
import * as net from 'node:net';
import { createLogger } from '@amm/shared';

const log = createLogger('http');

let cachedDispatcher: Agent | ProxyAgent | undefined;

/**
 * Parse a SOCKS proxy URL (socks5://, socks5h://, socks4://, socks4a://) into
 * the shape the `socks` package expects. We deliberately do NOT use
 * `socks-proxy-agent` here: its v8 API is built around node's http.Agent and
 * doesn't expose a callback-style connect that undici can plug into. Going
 * straight to the lower-level `socks` package is both simpler and lets us
 * support socks5h DNS-side resolution explicitly.
 */
function parseSocksUrl(raw: string): { proxy: SocksProxy; remoteResolveDns: boolean } {
  const url = new URL(raw);
  const scheme = url.protocol.replace(':', '').toLowerCase();
  let type: 4 | 5;
  let remoteResolveDns = false;
  switch (scheme) {
    case 'socks':
    case 'socks5':
      type = 5;
      break;
    case 'socks5h':
      type = 5;
      remoteResolveDns = true;
      break;
    case 'socks4':
      type = 4;
      break;
    case 'socks4a':
      type = 4;
      remoteResolveDns = true;
      break;
    default:
      throw new Error(`unsupported SOCKS scheme: ${scheme}`);
  }
  const proxy: SocksProxy = {
    host: url.hostname,
    port: Number(url.port || (type === 5 ? 1080 : 1080)),
    type,
  };
  if (url.username) proxy.userId = decodeURIComponent(url.username);
  if (url.password) proxy.password = decodeURIComponent(url.password);
  return { proxy, remoteResolveDns };
}

function buildSocksConnector(proxy: SocksProxy): buildConnector.connector {
  return (options, callback) => {
    const opts = options as unknown as {
      hostname: string;
      host?: string;
      port: number | string;
      protocol?: string;
      servername?: string;
    };
    const host = opts.hostname || opts.host;
    // undici passes port=0 when the URL has no explicit port; we have to apply
    // the protocol default ourselves (otherwise Tor rejects with "general
    // failure" on the CONNECT to :0 and looks like a fingerprint problem).
    let port = Number(opts.port);
    if (!Number.isFinite(port) || port <= 0) {
      port = opts.protocol === 'http:' ? 80 : 443;
    }
    if (!host) {
      callback(new Error(`invalid connect target host=${host}`), null);
      return;
    }
    SocksClient.createConnection(
      {
        proxy,
        command: 'connect',
        destination: { host, port },
        timeout: 30_000,
      },
      (err, info) => {
        if (err || !info) {
          callback(err ?? new Error('socks connect failed'), null);
          return;
        }
        const tcp = info.socket as net.Socket;
        // For HTTPS, undici needs a TLS-wrapped socket. We detect that via
        // the `protocol` hint (and the standard 443 fallback).
        const wantsTls = opts.protocol === 'https:' || port === 443;
        if (wantsTls) {
          const tlsSock = tls.connect({
            socket: tcp,
            servername: opts.servername || host,
            ALPNProtocols: ['http/1.1'],
          });
          tlsSock.once('secureConnect', () => callback(null, tlsSock));
          tlsSock.once('error', (e) => callback(e, null));
        } else {
          callback(null, tcp);
        }
      },
    );
  };
}

function buildDispatcher(): Agent | ProxyAgent {
  const tor = process.env.TOR_PROXY?.trim();
  if (tor) {
    log.info({ proxy: tor.replace(/(:)([^@]*?)(@)/, '$1***$3') }, 'routing http via tor');
    if (tor.startsWith('http://') || tor.startsWith('https://')) {
      return new ProxyAgent(tor);
    }
    const { proxy } = parseSocksUrl(tor);
    return new Agent({ connect: buildSocksConnector(proxy) });
  }
  return new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000 });
}

export function getDispatcher(): Agent | ProxyAgent {
  if (!cachedDispatcher) cachedDispatcher = buildDispatcher();
  return cachedDispatcher;
}

/**
 * Close the cached dispatcher and force the next request to build a fresh one.
 * Used after `SIGNAL NEWNYM` so already-pooled keep-alive sockets — which are
 * still glued to the OLD Tor circuit — are dropped, and the next request opens
 * a fresh socket that picks up the new circuit Tor just chose.
 */
export async function closeDispatcher(): Promise<void> {
  const d = cachedDispatcher;
  cachedDispatcher = undefined;
  if (d) {
    try {
      await d.close();
    } catch {
      /* noop: best-effort cleanup */
    }
  }
}

/** A fetch that respects TOR_PROXY and uses keep-alive. */
export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await undiciFetch(url, {
    ...init,
    dispatcher: getDispatcher(),
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`http ${res.status} ${res.statusText} from ${url}: ${body.slice(0, 256)}`);
  }
  return (await res.json()) as T;
}

export { undiciFetch as fetch };

/**
 * Fetch a URL through the shared dispatcher (tor-aware) and return the body
 * as plain text. Used by the proxy probe surface so the dashboard can
 * confirm Tor is actually in path without depending on undici directly.
 */
export async function fetchTextThroughProxy(url: string): Promise<string> {
  try {
    const res = await undiciFetch(url, {
      dispatcher: getDispatcher(),
      headers: { accept: 'text/plain' },
    });
    if (!res.ok) throw new Error(`http ${res.status} ${res.statusText} from ${url}`);
    return await res.text();
  } catch (e) {
    throw new Error(unwrapFetchError(e));
  }
}

/**
 * Fetch a URL through a fresh direct (non-proxy) dispatcher. Used to compare
 * against `fetchTextThroughProxy` to decide whether the configured TOR_PROXY
 * is actually masking the egress IP.
 */
export async function fetchTextDirect(url: string): Promise<string> {
  const direct = new Agent({ keepAliveTimeout: 5_000, keepAliveMaxTimeout: 10_000 });
  try {
    const res = await undiciFetch(url, {
      dispatcher: direct,
      headers: { accept: 'text/plain' },
    });
    if (!res.ok) throw new Error(`http ${res.status} ${res.statusText} from ${url}`);
    return await res.text();
  } catch (e) {
    throw new Error(unwrapFetchError(e));
  } finally {
    // Best-effort cleanup; undici Agent doesn't reuse across calls here so
    // closing isn't strictly required, but it's polite.
    void direct.close().catch(() => undefined);
  }
}

function unwrapFetchError(e: unknown): string {
  // undici's TypeError("fetch failed") buries the real cause on .cause; walk
  // the chain so the dashboard surfaces an actionable message.
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur; i++) {
    if (cur instanceof Error) {
      parts.push(cur.message || cur.name);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(' <- ');
}
