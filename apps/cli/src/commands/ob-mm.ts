import { Command } from 'commander';
import { PublicKey } from '@solana/web3.js';
import { Orchestrator } from '@amm/orchestrator';
import { getContext } from '../common.js';

export function registerObCommands(program: Command): void {
  const o = program.command('ob').description('order-book market maker (Phoenix)');

  o.command('start')
    .description('start a phoenix ob-mm run')
    .requiredOption('--market <pubkey>', 'phoenix market id')
    .requiredOption('--wallet <label>', 'mm wallet label')
    .option('--gamma <n>', 'risk aversion', '0.1')
    .option('--horizon <n>', 'time horizon (days)', '1.0')
    .option('--k <n>', 'order intensity', '1.5')
    .option('--layers <n>', '3')
    .option('--layer-spacing <frac>', '0.0015')
    .option('--layer-size <base>', '0.1')
    .option('--refresh-ms <n>', '5000')
    .option('--min-spread-frac <n>', '0.0008')
    .option('--inv-target <base>', '0')
    .option('--dry-run')
    .action(async (opts) => {
      const ctx = await getContext();
      const kp = ctx.vault.getKeypair(opts.wallet);
      if (!kp) throw new Error(`no wallet '${opts.wallet}'`);
      const orch = new Orchestrator(ctx);
      const runId = await orch.startObMm({
        marketId: new PublicKey(opts.market),
        wallet: kp,
        asParams: {
          gamma: parseFloat(opts.gamma),
          T: parseFloat(opts.horizon),
          k: parseFloat(opts.k),
        },
        layers: parseInt(opts.layers, 10),
        layerSpacing: parseFloat(opts.layerSpacing),
        layerSize: parseFloat(opts.layerSize),
        refreshMs: parseInt(opts.refreshMs, 10),
        minSpreadFraction: parseFloat(opts.minSpreadFrac),
        inventoryTarget: parseFloat(opts.invTarget),
        dryRun: !!opts.dryRun,
      });
      console.log(`ob-mm run ${runId} started. ctrl-c to stop.`);
      const shutdown = async () => {
        await orch.stop(runId);
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      await new Promise(() => {});
    });
}
