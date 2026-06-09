import { Command } from 'commander';
import { PublicKey } from '@solana/web3.js';
import { sweepAll } from '@amm/core';
import { getContext } from '../common.js';

export function registerSweepCommands(program: Command): void {
  program
    .command('sweep')
    .description('reclaim all funds from sub-wallets back to a destination')
    .requiredOption('--to <pubkey>', 'destination pubkey')
    .option('--wallet-tag <tag>', 'tag of source wallets', 'volume')
    .option('--no-tokens', 'sweep SOL only (do not move tokens)')
    .option('-c, --concurrency <n>', '4')
    .action(async (opts) => {
      const ctx = await getContext();
      const sources = ctx.vault.filterKeypairs([opts.walletTag]).map((w) => w.keypair);
      if (sources.length === 0) {
        console.error(`no wallets tagged '${opts.walletTag}'`);
        process.exit(1);
      }
      const results = await sweepAll({
        rpc: ctx.rpc,
        exec: ctx.exec,
        sources,
        destination: new PublicKey(opts.to),
        includeTokens: opts.tokens !== false,
        concurrency: opts.concurrency ? parseInt(opts.concurrency, 10) : 4,
      });
      for (const r of results) {
        console.log(`  ${r.wallet.slice(0, 6)}...  ${r.signatures.length} txs`);
      }
    });
}
