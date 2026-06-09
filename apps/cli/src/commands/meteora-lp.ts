import { Command } from 'commander';
import { PublicKey } from '@solana/web3.js';
import { Orchestrator } from '@amm/orchestrator';
import { getContext } from '../common.js';

type LpMode = 'two-sided' | 'quote-only' | 'base-only';
type LpStrategy = 'spot' | 'curve' | 'bid-ask';

function parseMode(v: string): LpMode {
  if (v !== 'two-sided' && v !== 'quote-only' && v !== 'base-only') {
    throw new Error(`invalid --mode '${v}'`);
  }
  return v;
}

function parseStrategy(v: string): LpStrategy {
  if (v !== 'spot' && v !== 'curve' && v !== 'bid-ask') {
    throw new Error(`invalid --strategy-type '${v}'`);
  }
  return v;
}

export function registerMeteoraLpCommands(program: Command): void {
  const c = program
    .command('meteora-lp')
    .description(
      'Meteora DLMM auto-LP strategy (two-sided or single-sided). NOTE: pause / resume / edit only work against an in-process orchestrator (typically the web dashboard). When you run `start` from the CLI, the run lives only inside that CLI process.',
    );

  c.command('start')
    .description('start a meteora-lp run (blocks; ctrl-c to stop)')
    .requiredOption('--pool <pubkey>', 'lbPair pubkey')
    .requiredOption('--wallet <label>', 'LP wallet label')
    .option('--mode <mode>', 'two-sided | quote-only | base-only', 'two-sided')
    .option('--strategy-type <t>', 'spot | curve | bid-ask', 'spot')
    .option('--width <frac>', 'half-width fraction', '0.05')
    .option('--bin-offset <n>', 'gap in bins from active (single-sided)', '1')
    .option('--hysteresis <frac>', 'rebalance hysteresis', '0.01')
    .option('--slippage-bps <n>', 'slippage', '80')
    .option('--cooldown-ms <n>', 'cooldown after rebalance', '30000')
    .option('--poll-ms <n>', 'poll interval', '5000')
    .option('--no-compound', 'disable fee compounding')
    .option('--fee-claim-ms <n>', 'fee claim interval', '300000')
    .option('--no-auto-redeploy', 'do not auto-redeploy after single-sided fill')
    .option('--no-inventory-swap', 'do not balance inventory two-sided')
    .option('--target-base-frac <frac>', 'two-sided target base fraction', '0.5')
    .option('--dry-run', 'simulate only')
    .action(async (opts) => {
      const ctx = await getContext();
      const kp = ctx.vault.getKeypair(opts.wallet);
      if (!kp) throw new Error(`no wallet '${opts.wallet}'`);
      const orch = new Orchestrator(ctx);
      const runId = await orch.startMeteoraLp({
        poolId: new PublicKey(opts.pool),
        wallet: kp,
        mode: parseMode(opts.mode),
        strategyType: parseStrategy(opts.strategyType),
        widthFraction: parseFloat(opts.width),
        binOffset: parseInt(opts.binOffset, 10),
        rebalanceHysteresis: parseFloat(opts.hysteresis),
        slippageBps: parseInt(opts.slippageBps, 10),
        cooldownMs: parseInt(opts.cooldownMs, 10),
        pollIntervalMs: parseInt(opts.pollMs, 10),
        compoundFees: opts.compound !== false,
        feeClaimIntervalMs: parseInt(opts.feeClaimMs, 10),
        autoRedeployOnFill: opts.autoRedeploy !== false,
        inventorySwapToTarget: opts.inventorySwap !== false,
        targetBaseFraction: parseFloat(opts.targetBaseFrac),
        dryRun: !!opts.dryRun,
      });
      console.log(`meteora-lp run ${runId} started. ctrl-c to stop.`);
      const shutdown = async () => {
        await orch.stop(runId);
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      await new Promise(() => {});
    });

  c.command('pause')
    .description('pause a meteora-lp run (in-process only)')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts) => {
      const ctx = await getContext();
      const orch = new Orchestrator(ctx);
      await orch.pause(parseInt(opts.run, 10));
      console.log(`run ${opts.run} paused`);
    });

  c.command('resume')
    .description('resume a paused meteora-lp run (in-process only)')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts) => {
      const ctx = await getContext();
      const orch = new Orchestrator(ctx);
      await orch.resume(parseInt(opts.run, 10));
      console.log(`run ${opts.run} resumed`);
    });

  c.command('edit')
    .description('runtime-edit a meteora-lp config (in-process only)')
    .requiredOption('--run <id>', 'run id')
    .option('--width <frac>', 'half-width fraction')
    .option('--hysteresis <frac>', 'rebalance hysteresis')
    .option('--slippage-bps <n>', 'slippage')
    .option('--bin-offset <n>', 'bin offset')
    .option('--no-compound', 'disable fee compounding')
    .option('--compound', 'enable fee compounding')
    .option('--fee-claim-ms <n>', 'fee claim interval')
    .option('--no-auto-redeploy', 'disable auto-redeploy')
    .option('--auto-redeploy', 'enable auto-redeploy')
    .option('--target-base-frac <frac>', 'two-sided target base fraction')
    .option('--dry-run', 'enable dry-run')
    .option('--no-dry-run', 'disable dry-run')
    .action(async (opts) => {
      const ctx = await getContext();
      const orch = new Orchestrator(ctx);
      const patch: Record<string, unknown> = {};
      if (opts.width !== undefined) patch.widthFraction = parseFloat(opts.width);
      if (opts.hysteresis !== undefined)
        patch.rebalanceHysteresis = parseFloat(opts.hysteresis);
      if (opts.slippageBps !== undefined)
        patch.slippageBps = parseInt(opts.slippageBps, 10);
      if (opts.binOffset !== undefined) patch.binOffset = parseInt(opts.binOffset, 10);
      if (opts.compound === true || opts.compound === false)
        patch.compoundFees = opts.compound;
      if (opts.feeClaimMs !== undefined)
        patch.feeClaimIntervalMs = parseInt(opts.feeClaimMs, 10);
      if (opts.autoRedeploy === true || opts.autoRedeploy === false)
        patch.autoRedeployOnFill = opts.autoRedeploy;
      if (opts.targetBaseFrac !== undefined)
        patch.targetBaseFraction = parseFloat(opts.targetBaseFrac);
      if (opts.dryRun === true || opts.dryRun === false) patch.dryRun = opts.dryRun;

      await orch.update(parseInt(opts.run, 10), patch);
      console.log(`run ${opts.run} updated: ${JSON.stringify(patch)}`);
    });

  c.command('stop')
    .description('stop a meteora-lp run (in-process only)')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts) => {
      const ctx = await getContext();
      const orch = new Orchestrator(ctx);
      await orch.stop(parseInt(opts.run, 10));
      console.log(`run ${opts.run} stopped`);
    });

  c.command('status')
    .description('list meteora-lp runs from the local store')
    .option('-n, --limit <n>', 'limit', '20')
    .action(async (opts) => {
      const ctx = await getContext();
      const limit = parseInt(opts.limit, 10);
      const runs = ctx.store.listRuns(limit).filter((r) => r.strategy === 'meteora-lp');
      if (runs.length === 0) {
        console.log('no meteora-lp runs found.');
        return;
      }
      for (const r of runs) {
        const dur = (r.stoppedAt ?? Date.now()) - r.startedAt;
        console.log(
          `  #${r.id}  ${r.status.padEnd(8)}  ${r.pool.slice(0, 8)}...  ${(dur / 60_000).toFixed(1)}m`,
        );
      }
    });
}
