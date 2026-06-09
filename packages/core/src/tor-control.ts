import { Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createLogger } from '@amm/shared';

const log = createLogger('tor-control');

/**
 * Tor Control Protocol client.
 *
 * Lets us tell the local Tor daemon to rotate circuits (`SIGNAL NEWNYM`)
 * after we hit upstream rate limits — Helius / Jupiter ban Tor exit IPs
 * fairly aggressively, and `NEWNYM` swaps to fresh ones.
 *
 * Auth supports either:
 *  - cookie file (Tor Browser default; `CookieAuthentication 1`)
 *  - plaintext password (matches `HashedControlPassword` torrc setting)
 *
 * Conventions:
 *   TOR_CONTROL_HOST   default: 127.0.0.1
 *   TOR_CONTROL_PORT   e.g. 9151 for Tor Browser SocksPort 9150
 *   TOR_CONTROL_COOKIE path to control_auth_cookie (preferred)
 *   TOR_CONTROL_PASSWORD optional fallback
 *
 * If neither cookie nor password is configured, rotation is disabled — `RpcManager`
 * skips silently after one log line at startup.
 */

export interface TorControlConfig {
  host: string;
  port: number;
  cookiePath?: string;
  password?: string;
}

/** Read TOR_CONTROL_* env. Returns null if rotation isn't usable. */
export function torControlConfigFromEnv(): TorControlConfig | null {
  const portStr = process.env.TOR_CONTROL_PORT?.trim();
  if (!portStr) return null;
  const port = Number(portStr);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    log.warn({ TOR_CONTROL_PORT: portStr }, 'invalid TOR_CONTROL_PORT, rotation disabled');
    return null;
  }
  const host = process.env.TOR_CONTROL_HOST?.trim() || '127.0.0.1';
  const cookiePath = process.env.TOR_CONTROL_COOKIE?.trim();
  const password = process.env.TOR_CONTROL_PASSWORD?.trim();
  if (!cookiePath && !password) {
    log.warn(
      'TOR_CONTROL_PORT set but no TOR_CONTROL_COOKIE or TOR_CONTROL_PASSWORD; rotation disabled',
    );
    return null;
  }
  return { host, port, cookiePath, password };
}

/** Send AUTHENTICATE + SIGNAL NEWNYM + QUIT to the local Tor control port. */
export async function rotateTorCircuit(cfg: TorControlConfig): Promise<void> {
  const auth = await buildAuth(cfg);
  await runControlSession(cfg.host, cfg.port, [auth, 'SIGNAL NEWNYM', 'QUIT']);
  log.info({ host: cfg.host, port: cfg.port }, 'tor SIGNAL NEWNYM sent');
}

async function buildAuth(cfg: TorControlConfig): Promise<string> {
  if (cfg.cookiePath) {
    const buf = await readFile(cfg.cookiePath);
    return `AUTHENTICATE ${buf.toString('hex')}`;
  }
  if (cfg.password) {
    const escaped = cfg.password.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `AUTHENTICATE "${escaped}"`;
  }
  throw new Error('tor control: neither cookiePath nor password provided');
}

/**
 * Open a TCP connection to Tor's control port, send each command, expect
 * a `250 OK` (or `250-...` continuation lines) per command, then close.
 *
 * Keeps it dependency-free — Tor's control protocol is line-based ASCII.
 */
function runControlSession(
  host: string,
  port: number,
  commands: string[],
  timeoutMs = 8000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    let buf = '';
    let cmdIdx = 0;
    let done = false;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* noop */
      }
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('tor control timeout')), timeoutMs);

    sock.on('error', (e) => finish(e));
    sock.on('end', () => finish());
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        // 250-... is a continuation line; only 250 + space ("250 ") finishes a reply.
        if (line.startsWith('250-') || line.startsWith('250+')) continue;
        if (!line.startsWith('250 ')) {
          finish(new Error(`tor control unexpected reply: ${line}`));
          return;
        }
        cmdIdx++;
        if (cmdIdx >= commands.length) {
          finish();
          return;
        }
      }
    });

    sock.connect(port, host, () => {
      sock.write(commands.join('\r\n') + '\r\n');
    });
  });
}
