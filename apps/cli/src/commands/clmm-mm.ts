import { Command } from 'commander';
import { PublicKey } from '@solana/web3.js';
import { Orchestrator } from '@amm/orchestrator';
import { getContext } from '../common.js';

export function registerClmmCommands(program: Command): void {
  const c = program.command('clmm').description('CLMM auto-LP rebalancer');

  c.command('start')
    .description('start a clmm-mm run (blocks; ctrl-c to stop)')
    .requiredOption('--venue <id>', 'meteora-dlmm | raydium-clmm | orca-whirlpools')
    .requiredOption('--pool <pubkey>', 'pool id')
    .requiredOption('--wallet <label>', 'LP wallet label')
    .option('--width <frac>', 'half-width as fraction of price', '0.05')
    .option('--hysteresis <frac>', '0.01')
    .option('--target-base-frac <frac>', '0.5')
    .option('--inventory-tol <frac>', '0.1')
    .option('--slippage-bps <n>', '80')
    .option('--cooldown-ms <n>', '30000')
    .option('--poll-ms <n>', '5000')
    .option('--no-compound')
    .option('--dry-run')
    .action(async (opts) => {
      const ctx = await getContext();
      const kp = ctx.vault.getKeypair(opts.wallet);
      if (!kp) throw new Error(`no wallet '${opts.wallet}'`);
      const orch = new Orchestrator(ctx);
      const runId = await orch.startClmmMm({
        venue: opts.venue,
        poolId: new PublicKey(opts.pool),
        wallet: kp,
        rangeWidth: parseFloat(opts.width),
        rebalanceHysteresis: parseFloat(opts.hysteresis),
        targetBaseFraction: parseFloat(opts.targetBaseFrac),
        inventoryTolerance: parseFloat(opts.inventoryTol),
        slippageBps: parseInt(opts.slippageBps, 10),
        cooldownMs: parseInt(opts.cooldownMs, 10),
        pollIntervalMs: parseInt(opts.pollMs, 10),
        compoundFees: opts.compound !== false,
        dryRun: !!opts.dryRun,
      });
      console.log(`clmm-mm run ${runId} started. ctrl-c to stop.`);
      const shutdown = async () => {
        await orch.stop(runId);
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      await new Promise(() => {});
    });
}
