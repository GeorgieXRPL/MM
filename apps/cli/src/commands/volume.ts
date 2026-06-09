import { Command } from 'commander';
import { PublicKey } from '@solana/web3.js';
import { Orchestrator } from '@amm/orchestrator';
import { distributeSol, multiHopFund } from '@amm/core';
import { LAMPORTS_PER_SOL } from '@amm/shared';
import { getContext } from '../common.js';

export function registerVolumeCommands(program: Command): void {
  const v = program.command('volume').description('organic-flow volume strategy');

  v.command('start')
    .description('start a volume run (blocks; ctrl-c to stop)')
    .requiredOption('-p, --pool <pubkey>', 'pool id')
    .option('--venue <id>', 'venue id', 'jupiter')
    .option('--base <mint>', 'base mint (required for venue=jupiter)')
    .option('--quote <mint>', 'quote mint (required for venue=jupiter)')
    .option('--wallet-tag <tag>', 'tag of wallets to use', 'volume')
    .option('--slippage-bps <n>', 'slippage in bps', '100')
    .option('--min-size <sol>', 'min trade size in SOL', '0.005')
    .option('--max-size <sol>', 'max trade size in SOL', '1.0')
    .option('--mean-size <sol>', 'mean trade size in SOL (log-normal mean)', '0.05')
    .option('--use-jito', 'route through jito bundles')
    .option('--dry-run', 'log only; do not send')
    .action(async (opts) => {
      const ctx = await getContext();
      const wallets = ctx.vault
        .filterKeypairs([opts.walletTag])
        .map((w) => w.keypair);
      if (wallets.length === 0) {
        console.error(`no wallets tagged '${opts.walletTag}'. tag some first.`);
        process.exit(1);
      }
      const orch = new Orchestrator(ctx);
      const runId = await orch.startVolume({
        poolId: new PublicKey(opts.pool),
        venue: opts.venue,
        baseMint: opts.base ? new PublicKey(opts.base) : undefined,
        quoteMint: opts.quote ? new PublicKey(opts.quote) : undefined,
        wallets,
        slippageBps: parseInt(opts.slippageBps, 10),
        minQuoteSize: parseFloat(opts.minSize),
        maxQuoteSize: parseFloat(opts.maxSize),
        sizeLogMean: Math.log(parseFloat(opts.meanSize)),
        useJito: !!opts.useJito,
        dryRun: !!opts.dryRun,
      });
      console.log(`volume run ${runId} started. ctrl-c to stop.`);
      const shutdown = async () => {
        console.log('\nshutting down...');
        await orch.stop(runId);
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      await new Promise(() => {});
    });

  v.command('fund')
    .description('distribute SOL to your trading sub-wallets, optionally with multi-hop indirection')
    .requiredOption('--from <label>', 'funder wallet label')
    .option('--wallet-tag <tag>', 'tag of recipients', 'volume')
    .option('--per-wallet <sol>', 'mean SOL per recipient', '0.1')
    .option('--jitter <frac>', 'amount jitter (e.g. 0.15 = +/-15%)', '0.15')
    .option('--no-hop', 'send directly (no multi-hop indirection)')
    .option('--min-hops <n>', 'min intermediate hops', '3')
    .option('--max-hops <n>', 'max intermediate hops', '7')
    .action(async (opts) => {
      const ctx = await getContext();
      const funder = ctx.vault.getKeypair(opts.from);
      if (!funder) {
        console.error(`no wallet '${opts.from}'`);
        process.exit(1);
      }
      const recipients = ctx.vault
        .filterKeypairs([opts.walletTag])
        .map((w) => w.keypair.publicKey);
      if (recipients.length === 0) {
        console.error(`no wallets tagged '${opts.walletTag}'`);
        process.exit(1);
      }
      const lamports = Math.round(parseFloat(opts.perWallet) * LAMPORTS_PER_SOL);
      console.log(`distributing ~${opts.perWallet} SOL to ${recipients.length} wallets...`);
      const results = await distributeSol({
        rpc: ctx.rpc,
        exec: ctx.exec,
        funder,
        recipients,
        meanLamports: lamports,
        jitterFraction: parseFloat(opts.jitter),
        hop: opts.hop === false
          ? false
          : { minHops: parseInt(opts.minHops, 10), maxHops: parseInt(opts.maxHops, 10) },
        store: ctx.store,
      });
      for (const r of results) {
        console.log(
          `  ${r.recipient.slice(0, 6)}...  ${(r.lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL  (${r.signatures.length} hops)`,
        );
      }
    });

  v.command('hop-once')
    .description('one-shot multi-hop transfer (testing/utility)')
    .requiredOption('--from <label>', 'funder wallet label')
    .requiredOption('--to <pubkey>', 'destination pubkey')
    .requiredOption('--sol <n>', 'amount in SOL')
    .option('--min-hops <n>', '3')
    .option('--max-hops <n>', '7')
    .action(async (opts) => {
      const ctx = await getContext();
      const funder = ctx.vault.getKeypair(opts.from);
      if (!funder) throw new Error(`no wallet '${opts.from}'`);
      const r = await multiHopFund({
        rpc: ctx.rpc,
        exec: ctx.exec,
        funder,
        target: new PublicKey(opts.to),
        lamports: Math.round(parseFloat(opts.sol) * LAMPORTS_PER_SOL),
        store: ctx.store,
        config: {
          minHops: opts.minHops ? parseInt(opts.minHops, 10) : 3,
          maxHops: opts.maxHops ? parseInt(opts.maxHops, 10) : 7,
        },
      });
      console.log(`done. ${r.signatures.length} txs.`);
    });
}
