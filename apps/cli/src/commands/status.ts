import { Command } from 'commander';
import { getContext } from '../common.js';

export function registerStatusCommands(program: Command): void {
  program
    .command('status')
    .description('show recent runs and trades')
    .option('-n, --limit <n>', '10')
    .action(async (opts) => {
      const ctx = await getContext();
      const limit = parseInt(opts.limit ?? '10', 10);
      const runs = ctx.store.listRuns(limit);
      if (runs.length === 0) {
        console.log('no runs recorded yet.');
        return;
      }
      for (const r of runs) {
        const dur = (r.stoppedAt ?? Date.now()) - r.startedAt;
        const status = r.status.padEnd(8);
        console.log(
          `  #${r.id}  ${status}  ${r.strategy.padEnd(10)}  ${r.pool.slice(0, 8)}...  ${(dur / 60_000).toFixed(1)}m`,
        );
      }
    });

  program
    .command('trades')
    .description('list trades for a run')
    .requiredOption('-r, --run <id>', 'run id')
    .option('-n, --limit <n>', '50')
    .action(async (opts) => {
      const ctx = await getContext();
      const trades = ctx.store.recentTrades(parseInt(opts.run, 10), parseInt(opts.limit ?? '50', 10));
      for (const t of trades) {
        const ts = new Date(t.ts).toISOString();
        console.log(
          `  ${ts}  ${t.side.padEnd(4)}  ${t.wallet.slice(0, 6)}...  in=${t.amountIn.padStart(14)}  sig=${t.signature.slice(0, 12)}...`,
        );
      }
    });
}
