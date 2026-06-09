import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type DatabaseT from 'better-sqlite3';
import { createLogger } from '@amm/shared';

const log = createLogger('store');

// Load better-sqlite3 via createRequire so bundlers (Next.js webpack, etc.)
// don't statically trace through it. The native binding's path resolution
// breaks the moment webpack rewrites the module's __dirname.
const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database: typeof DatabaseT = requireFromHere('better-sqlite3') as any;

export interface RunRecord {
  id: number;
  strategy: string;
  pool: string;
  startedAt: number;
  stoppedAt: number | null;
  config: string; // json
  status: 'running' | 'stopped' | 'errored';
  notes: string | null;
}

export interface TradeRecord {
  id: number;
  runId: number;
  ts: number;
  wallet: string;
  side: 'buy' | 'sell';
  amountIn: string;
  amountOut: string;
  signature: string;
  pool: string;
  venue: string;
  slippageBps: number;
}

export interface PositionRecord {
  id: number;
  venue: string;
  poolId: string;
  positionId: string;
  owner: string;
  baseMint: string;
  quoteMint: string;
  lowerPrice: number | null;
  upperPrice: number | null;
  openedAt: number;
  closedAt: number | null;
  notes: string | null;
}

export class Store {
  private db: DatabaseT.Database;

  constructor(filePath: string = defaultStorePath()) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    log.info({ path: filePath }, 'store opened');
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy TEXT NOT NULL,
        pool TEXT NOT NULL,
        startedAt INTEGER NOT NULL,
        stoppedAt INTEGER,
        config TEXT NOT NULL,
        status TEXT NOT NULL,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        runId INTEGER REFERENCES runs(id) ON DELETE CASCADE,
        ts INTEGER NOT NULL,
        wallet TEXT NOT NULL,
        side TEXT NOT NULL,
        amountIn TEXT NOT NULL,
        amountOut TEXT NOT NULL,
        signature TEXT NOT NULL,
        pool TEXT NOT NULL,
        venue TEXT NOT NULL,
        slippageBps INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_trades_runId ON trades(runId);
      CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);

      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        venue TEXT NOT NULL,
        poolId TEXT NOT NULL,
        positionId TEXT NOT NULL UNIQUE,
        owner TEXT NOT NULL,
        baseMint TEXT NOT NULL,
        quoteMint TEXT NOT NULL,
        lowerPrice REAL,
        upperPrice REAL,
        openedAt INTEGER NOT NULL,
        closedAt INTEGER,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS funding_hops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        runId INTEGER REFERENCES runs(id) ON DELETE CASCADE,
        ts INTEGER NOT NULL,
        fromWallet TEXT NOT NULL,
        toWallet TEXT NOT NULL,
        lamports INTEGER NOT NULL,
        signature TEXT NOT NULL,
        hopIndex INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);
  }

  // -- runs --------------------------------------------------------------

  startRun(strategy: string, pool: string, config: object): number {
    const stmt = this.db.prepare(
      `INSERT INTO runs (strategy, pool, startedAt, config, status) VALUES (?, ?, ?, ?, 'running')`,
    );
    const info = stmt.run(strategy, pool, Date.now(), JSON.stringify(config));
    return Number(info.lastInsertRowid);
  }

  stopRun(runId: number, status: 'stopped' | 'errored' = 'stopped', notes?: string): void {
    this.db
      .prepare(`UPDATE runs SET stoppedAt = ?, status = ?, notes = ? WHERE id = ?`)
      .run(Date.now(), status, notes ?? null, runId);
  }

  listRuns(limit = 50): RunRecord[] {
    return this.db.prepare(`SELECT * FROM runs ORDER BY id DESC LIMIT ?`).all(limit) as RunRecord[];
  }

  // -- trades ------------------------------------------------------------

  recordTrade(t: Omit<TradeRecord, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO trades (runId, ts, wallet, side, amountIn, amountOut, signature, pool, venue, slippageBps)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.runId,
        t.ts,
        t.wallet,
        t.side,
        t.amountIn,
        t.amountOut,
        t.signature,
        t.pool,
        t.venue,
        t.slippageBps,
      );
  }

  recentTrades(runId: number, limit = 100): TradeRecord[] {
    return this.db
      .prepare(`SELECT * FROM trades WHERE runId = ? ORDER BY id DESC LIMIT ?`)
      .all(runId, limit) as TradeRecord[];
  }

  /**
   * For each provided wallet pubkey, return the side ('buy' | 'sell') of its
   * most recent successful trade on the given pool — across all runs.
   *
   * Used by `VolumeStrategy` on startup to seed its in-memory `walletLastSide`
   * map so that `strictAlternate` survives stop/restart cycles. Without this
   * seed, every restart resets the map and the FSM forces every wallet's
   * first trade to be a buy. Wallets that finished the prior run on a buy
   * (e.g. inventory was building up because sells kept failing or the user
   * stopped mid-cycle) then can't afford another buy and get stuck on
   * `trade skipped: native SOL below swap + rent reserve`.
   *
   * Returns a `Map<wallet, side>`. Missing wallets (no prior trade on this
   * pool) are simply absent from the map — callers should treat that as
   * "fresh wallet, force buy" (which is the existing default behaviour).
   *
   * Scoped to `pool` so that switching pools (e.g. running volume on
   * different tokens) doesn't bleed state across.
   */
  lastSidesByPool(pool: string, wallets: readonly string[]): Map<string, 'buy' | 'sell'> {
    const out = new Map<string, 'buy' | 'sell'>();
    if (wallets.length === 0) return out;
    // SQLite has a 999-parameter limit (`SQLITE_MAX_VARIABLE_NUMBER`); volume
    // strategies typically use <50 wallets so we don't bother chunking. The
    // correlated subquery picks the row with the largest `id` per wallet,
    // which is monotonic with `ts` and avoids a full sort.
    const placeholders = wallets.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT t.wallet, t.side
         FROM trades t
         WHERE t.pool = ?
           AND t.wallet IN (${placeholders})
           AND t.id = (
             SELECT MAX(t2.id)
             FROM trades t2
             WHERE t2.wallet = t.wallet AND t2.pool = t.pool
           )`,
      )
      .all(pool, ...wallets) as { wallet: string; side: string }[];
    for (const r of rows) {
      if (r.side === 'buy' || r.side === 'sell') {
        out.set(r.wallet, r.side);
      }
    }
    return out;
  }

  // -- positions ---------------------------------------------------------

  upsertPosition(p: Omit<PositionRecord, 'id' | 'closedAt' | 'notes'>): void {
    this.db
      .prepare(
        `INSERT INTO positions (venue, poolId, positionId, owner, baseMint, quoteMint, lowerPrice, upperPrice, openedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(positionId) DO UPDATE SET
           lowerPrice = excluded.lowerPrice,
           upperPrice = excluded.upperPrice`,
      )
      .run(
        p.venue,
        p.poolId,
        p.positionId,
        p.owner,
        p.baseMint,
        p.quoteMint,
        p.lowerPrice,
        p.upperPrice,
        p.openedAt,
      );
  }

  closePosition(positionId: string, notes?: string): void {
    this.db
      .prepare(`UPDATE positions SET closedAt = ?, notes = ? WHERE positionId = ?`)
      .run(Date.now(), notes ?? null, positionId);
  }

  openPositions(): PositionRecord[] {
    return this.db
      .prepare(`SELECT * FROM positions WHERE closedAt IS NULL ORDER BY openedAt DESC`)
      .all() as PositionRecord[];
  }

  // -- funding hops ------------------------------------------------------

  recordHop(h: {
    runId: number | null;
    fromWallet: string;
    toWallet: string;
    lamports: number;
    signature: string;
    hopIndex: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO funding_hops (runId, ts, fromWallet, toWallet, lamports, signature, hopIndex)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(h.runId, Date.now(), h.fromWallet, h.toWallet, h.lamports, h.signature, h.hopIndex);
  }

  // -- kv ----------------------------------------------------------------

  setKv(key: string, value: unknown): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO kv (k, v, updatedAt) VALUES (?, ?, ?)`)
      .run(key, JSON.stringify(value), Date.now());
  }

  getKv<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare(`SELECT v FROM kv WHERE k = ?`).get(key) as
      | { v: string }
      | undefined;
    if (!row) return undefined;
    return JSON.parse(row.v) as T;
  }

  close(): void {
    this.db.close();
  }
}

export function defaultStorePath(): string {
  return path.join(os.homedir(), '.amm', 'state.db');
}
