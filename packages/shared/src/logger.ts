import pino, { type Logger, type LoggerOptions } from 'pino';
import { Writable } from 'node:stream';

const level = process.env.LOG_LEVEL ?? 'info';
// Pretty transport relies on worker_threads which is fragile inside Next.js
// route handlers. Auto-disable when not running in a TTY (i.e. piped output,
// next start, etc.) unless LOG_PRETTY is explicitly set to true.
const prettyEnv = process.env.LOG_PRETTY;
const pretty =
  prettyEnv === 'true' ? true : prettyEnv === 'false' ? false : Boolean(process.stdout.isTTY);

const baseOpts: LoggerOptions = {
  level,
  base: undefined,
  redact: {
    paths: [
      '*.privateKey',
      '*.secretKey',
      '*.passphrase',
      '*.password',
      '*.mnemonic',
      'privateKey',
      'secretKey',
      'passphrase',
      'password',
      'mnemonic',
    ],
    censor: '[REDACTED]',
  },
};

export interface LogEntry {
  time: number;
  level: number;
  mod?: string;
  msg?: string;
  raw: string;
  // any extra structured fields pino emitted
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fields?: Record<string, any>;
}

class LogRingBuffer {
  private items: LogEntry[] = [];
  private seq = 0;
  constructor(private readonly cap: number = 1000) {}

  push(line: string): void {
    const trimmed = line.trimEnd();
    if (!trimmed) return;
    let entry: LogEntry;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed = JSON.parse(trimmed) as Record<string, any>;
      const { time, level: lvl, mod, msg, ...rest } = parsed;
      entry = {
        time: typeof time === 'number' ? time : Date.now(),
        level: typeof lvl === 'number' ? lvl : 30,
        mod: typeof mod === 'string' ? mod : undefined,
        msg: typeof msg === 'string' ? msg : undefined,
        raw: trimmed,
        fields: Object.keys(rest).length ? rest : undefined,
      };
    } catch {
      entry = { time: Date.now(), level: 30, raw: trimmed };
    }
    this.items.push(entry);
    this.seq++;
    if (this.items.length > this.cap) this.items.shift();
  }

  /** Return up to `limit` entries strictly newer than `sinceMs` (epoch ms). */
  recent(limit: number, sinceMs: number): { entries: LogEntry[]; tip: number } {
    const start = sinceMs > 0
      ? this.items.findIndex((i) => i.time > sinceMs)
      : Math.max(0, this.items.length - limit);
    const slice = start >= 0 ? this.items.slice(start) : [];
    const entries = slice.length > limit ? slice.slice(-limit) : slice;
    const tip = entries.length ? entries[entries.length - 1]!.time : sinceMs;
    return { entries, tip };
  }

  size(): number {
    return this.items.length;
  }
}

// Pin the ring buffer on globalThis so it survives module re-evaluation.
// Next.js dev mode re-bundles server routes when sibling routes compile,
// which would otherwise create a fresh `LogRingBuffer` and orphan the
// previous one (verified empirically: vault.unlock would write to the
// "old" buffer while the LogPanel polled the "new" one and saw 0 entries).
const globalRef = globalThis as { __ammLogBuffer?: LogRingBuffer };
if (!globalRef.__ammLogBuffer) {
  globalRef.__ammLogBuffer = new LogRingBuffer(1000);
}
export const logBuffer: LogRingBuffer = globalRef.__ammLogBuffer;

// Always resolve `logBuffer` via globalThis at write time so even pino
// streams bound to an OLD module instance still feed the live singleton
// after a Next.js dev re-evaluation.
const bufferStream = new Writable({
  write(chunk, _enc, cb) {
    try {
      const buf = (globalThis as { __ammLogBuffer?: LogRingBuffer }).__ammLogBuffer;
      if (buf) buf.push(chunk.toString('utf8'));
    } catch {
      // never block the logger pipeline
    }
    cb();
  },
});

// We always need every log call to fan out to TWO destinations:
//   1. stdout (for the user's terminal - either pretty or JSON depending on mode)
//   2. the in-process ring buffer (so the dashboard's /runs LogPanel + the
//      docked footer panel can poll it via `runs.logs`).
//
// Earlier we tried `pino.multistream([stdout, bufferStream])` for the non-pretty
// path, but pino's multistream writes via `sonic-boom`'s API and silently
// dropped the writes against a plain node `Writable` (verified empirically:
// stdout received JSON lines while logBuffer.size() stayed at 0). The pretty
// path already used two separate pino loggers behind a Proxy fanout - we now
// use that same approach unconditionally so the buffer never gets out of sync
// with stdout.

let stdoutLogger: Logger;
if (pretty) {
  stdoutLogger = pino({
    ...baseOpts,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
  });
} else {
  stdoutLogger = pino(baseOpts, process.stdout);
}

const bufferLogger: Logger = pino(baseOpts, bufferStream);

/**
 * Forward every log/child call to BOTH the stdout-bound logger and the
 * buffer-bound logger. Children recursively get the same fanout so that
 * `createLogger('foo').child({ bar: 1 })` still writes to both.
 */
function fanout(p: Logger, b: Logger): Logger {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Proxy(p, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'child') {
        return (bindings: Record<string, unknown>, opts?: object) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pc = (target.child as any).call(target, bindings, opts) as Logger;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const bc = (b.child as any).call(b, bindings, opts) as Logger;
          return fanout(pc, bc);
        };
      }
      if (typeof value === 'function' && ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(String(prop))) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (...args: any[]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (b as any)[prop](...args);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  }) as Logger;
}

export const rootLogger: Logger = fanout(stdoutLogger, bufferLogger);

export function createLogger(name: string, bindings: Record<string, unknown> = {}): Logger {
  return rootLogger.child({ mod: name, ...bindings });
}

export type { Logger } from 'pino';
