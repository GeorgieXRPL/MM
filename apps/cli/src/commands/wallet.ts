import { Command } from 'commander';
import { password } from '@inquirer/prompts';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { Vault } from '@amm/core';
import { getContext, unlockVault, fmtSol } from '../common.js';

export function registerWalletCommands(program: Command): void {
  const w = program.command('wallet').description('inspect and manage wallets in the vault');

  w.command('list')
    .description('list all wallets in the vault')
    .option('-b, --balances', 'fetch on-chain SOL balances (slower)')
    .action(async (opts: { balances?: boolean }) => {
      const ctx = await getContext();
      const wallets = ctx.vault.list();
      if (wallets.length === 0) {
        console.log('vault is empty. use `amm wallet generate` to create some.');
        return;
      }
      for (const wd of wallets) {
        const kp = Keypair.fromSecretKey(bs58.decode(wd.secretKeyB58));
        const tags = wd.tags.length ? ` [${wd.tags.join(', ')}]` : '';
        let bal = '';
        if (opts.balances) {
          const lamports = await ctx.rpc.getBalance(kp.publicKey).catch(() => 0);
          bal = `  ${fmtSol(lamports)}`;
        }
        console.log(`  ${wd.label.padEnd(20)} ${kp.publicKey.toBase58()}${tags}${bal}`);
      }
    });

  w.command('generate')
    .description('generate new keypairs into the vault')
    .option('-c, --count <n>', 'number of wallets', '1')
    .option('-p, --prefix <s>', 'label prefix', 'wallet')
    .option('-t, --tag <tag...>', 'tags to attach')
    .action(async (opts: { count: string; prefix: string; tag?: string[] }) => {
      const ctx = await getContext();
      const labels = await ctx.vault.generate(parseInt(opts.count, 10), opts.prefix, opts.tag ?? []);
      console.log(`generated ${labels.length} wallets:`);
      for (const l of labels) console.log(`  ${l}`);
    });

  w.command('import')
    .description('import a wallet from a base58 secret key')
    .requiredOption('-l, --label <label>', 'wallet label')
    .option('-t, --tag <tag...>', 'tags to attach')
    .option('--replace', 'remove an existing wallet with this label first', false)
    .action(async (opts: { label: string; tag?: string[]; replace?: boolean }) => {
      const ctx = await getContext();
      if (opts.replace) {
        try {
          await ctx.vault.remove(opts.label);
        } catch {
          /* label didn't exist */
        }
      }
      const sk = await password({ message: 'base58 secret key:', mask: '*' });
      await ctx.vault.importFromBase58(opts.label, sk, opts.tag ?? []);
      console.log(`imported wallet '${opts.label}'`);
    });

  w.command('import-file')
    .description('import a wallet from a Solana CLI keypair JSON file')
    .requiredOption('-l, --label <label>', 'wallet label')
    .requiredOption('-f, --file <path>', 'keypair json file')
    .option('-t, --tag <tag...>', 'tags to attach')
    .action(async (opts: { label: string; file: string; tag?: string[] }) => {
      const ctx = await getContext();
      await ctx.vault.importFromKeypairFile(opts.label, opts.file, opts.tag ?? []);
      console.log(`imported wallet '${opts.label}' from ${opts.file}`);
    });

  w.command('remove')
    .description('remove a wallet from the vault (does NOT touch on-chain)')
    .requiredOption('-l, --label <label>', 'wallet label')
    .action(async (opts: { label: string }) => {
      const ctx = await getContext();
      await ctx.vault.remove(opts.label);
      console.log(`removed wallet '${opts.label}'`);
    });

  w.command('show')
    .description('reveal the secret key for a wallet (DANGEROUS)')
    .requiredOption('-l, --label <label>', 'wallet label')
    .action(async (opts: { label: string }) => {
      const v = new Vault();
      const p = await password({ message: 'vault passphrase:', mask: '*' });
      await v.unlock(p);
      const w2 = v.get(opts.label);
      if (!w2) {
        console.error(`no wallet '${opts.label}'`);
        process.exit(1);
      }
      const kp = Keypair.fromSecretKey(bs58.decode(w2.secretKeyB58));
      console.log(`label:      ${w2.label}`);
      console.log(`pubkey:     ${kp.publicKey.toBase58()}`);
      console.log(`secret b58: ${w2.secretKeyB58}`);
      console.log(`secret arr: [${Array.from(kp.secretKey).join(',')}]`);
    });

  // Suppress lint: unlockVault re-exported here for symmetry with other modules.
  void unlockVault;
}
