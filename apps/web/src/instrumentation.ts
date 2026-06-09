/**
 * Server-side instrumentation. Runs once when the Next.js server boots
 * (Node runtime only).
 *
 * Two responsibilities:
 *
 * 1. Silence the spammy `bigint: Failed to load bindings, pure JS will be
 *    used (try npm run rebuild?)` console.log that `bigint-buffer` emits
 *    via `console.log` (NOT process.emitWarning, so NODE_NO_WARNINGS won't
 *    suppress it). The native binding falls back cleanly to a pure-JS
 *    implementation, so the warning is purely cosmetic - but it prints
 *    twice on every tRPC `runs.logs` poll (~once per second) and drowns
 *    the actual dev-server output. Filter it at the source.
 *
 * 2. Reconcile orphan `running` rows in the runs table. Previously this
 *    happened inside the `Orchestrator` constructor, which only fired on
 *    the first authenticated request after vault unlock. That left the
 *    "Recent runs" list lying — claiming runs were `running` for hours
 *    after the prior MM process had died, until someone happened to log
 *    in. Hoisting it here means the reconcile fires within seconds of MM
 *    boot, regardless of vault state. Touches only the `runs` table; no
 *    keypairs needed, so it's safe to run before unlock.
 */
export function register(): void {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const NOISE = [
    'bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)',
  ];

  const originalLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    if (
      args.length === 1 &&
      typeof args[0] === 'string' &&
      NOISE.some((needle) => (args[0] as string).includes(needle))
    ) {
      return; // drop
    }
    originalLog(...args);
  };

  // Fire the orphan-run reconcile asynchronously so we don't hold up the
  // Next.js server boot. Errors here are non-fatal — the existing reconcile
  // inside the Orchestrator constructor will still catch any rows we miss
  // (it's idempotent: rows that are already terminal are skipped).
  void reconcileOrphanRunsOnStartup();
}

async function reconcileOrphanRunsOnStartup(): Promise<void> {
  // Why direct SQL instead of importing `@amm/core`'s `Store`:
  // webpack's static analysis traces every import at build time, even
  // those gated by a runtime check. `@amm/core/index.ts` re-exports
  // `http.ts` which pulls in `socks` (Node-only `net` module) for Tor —
  // edge-runtime build of this file fails with "Module not found: 'net'"
  // even though we only ever run in nodejs at runtime. Doing the SQL
  // ourselves keeps the import graph tiny: just `better-sqlite3` (which
  // is already in `serverExternalPackages`, so webpack leaves it alone)
  // plus a hand-rolled `require` to dodge webpack's static analysis.
  //
  // Note: we deliberately avoid both `node:` scheme imports (Next.js's
  // webpack pipeline rejects them with `UnhandledSchemeError`) and
  // top-level `import` of node built-ins (would tie this file's bundle
  // to nodejs runtime forever). Instead we eval-up a `require` and pull
  // built-ins through it. Ugly but isolates the dirt to one block.
  try {
    // `eval('require')` returns the real CommonJS require even inside an
    // ESM module after webpack has rewritten the file, because webpack
    // doesn't trace through eval. This is the standard escape hatch for
    // "I need Node built-ins from a file webpack is bundling".
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-eval
    const nodeRequire = eval('require') as NodeJS.Require;
    const os = nodeRequire('os') as typeof import('os');
    const path = nodeRequire('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Database = nodeRequire('better-sqlite3') as any;

    const dbPath = path.join(os.homedir(), '.amm', 'state.db');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = new Database(dbPath, { fileMustExist: false });
    try {
      db.pragma('journal_mode = WAL');
      // The Store class creates this table on first construction; if the
      // server was restarted before any vault unlock ever happened (fresh
      // checkout, deleted state file, etc.) the table won't exist yet.
      // Skip silently in that case — there can't be orphan rows.
      const tableCheck = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='runs'`)
        .get() as { name?: string } | undefined;
      if (!tableCheck) {
        // eslint-disable-next-line no-console
        console.log('[startup-reconcile] no runs table yet (fresh DB); skipping');
        return;
      }
      const stale = db
        .prepare(`SELECT id FROM runs WHERE status = 'running'`)
        .all() as { id: number }[];
      if (stale.length === 0) {
        // eslint-disable-next-line no-console
        console.log('[startup-reconcile] no orphan running rows found at startup');
        return;
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[startup-reconcile] reconciling ${stale.length} orphan running row(s) from prior MM process: [${stale
          .map((r) => r.id)
          .join(', ')}]`,
      );
      const update = db.prepare(
        `UPDATE runs SET stoppedAt = ?, status = 'errored', notes = ? WHERE id = ? AND status = 'running'`,
      );
      const note = 'process exited unexpectedly before stop (reconciled at MM startup)';
      const now = Date.now();
      const tx = db.transaction((rows: { id: number }[]) => {
        for (const r of rows) update.run(now, note, r.id);
      });
      tx(stale);
    } finally {
      db.close();
    }
  } catch (e) {
    // Don't crash the server if the DB is locked or sqlite native bindings
    // failed to load; the lazy-init path inside `Orchestrator` will retry
    // the reconcile when the user finally logs in (idempotent — already-
    // terminal rows are skipped).
    // eslint-disable-next-line no-console
    console.warn('[startup-reconcile] skipped:', (e as Error).message);
  }
}
