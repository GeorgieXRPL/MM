import { Command } from 'commander';
import { password, confirm } from '@inquirer/prompts';
import { Vault } from '@amm/core';

export function registerVaultCommands(program: Command): void {
  const vault = program.command('vault').description('manage the encrypted wallet vault');

  vault
    .command('init')
    .description('create a new vault')
    .option(
      '--from-env',
      'read passphrase from AMM_VAULT_PASSPHRASE (or legacy VAULT_PASSPHRASE) non-interactively',
    )
    .action(async (opts: { fromEnv?: boolean }) => {
      const v = new Vault();
      if (await v.exists()) {
        console.error(`vault already exists at ${v.path}`);
        process.exit(1);
      }
      let p1: string;
      // Prefer the namespaced env var so an operator who's also running the
      // treasury (which exports TREASURY_VAULT_PASSPHRASE) cannot accidentally
      // initialise the MM vault with a stale generic passphrase from their shell.
      const envPass = process.env.AMM_VAULT_PASSPHRASE ?? process.env.VAULT_PASSPHRASE;
      if (opts.fromEnv || envPass) {
        if (!envPass) {
          console.error('neither AMM_VAULT_PASSPHRASE nor VAULT_PASSPHRASE is set');
          process.exit(1);
        }
        if (!process.env.AMM_VAULT_PASSPHRASE && process.env.VAULT_PASSPHRASE) {
          console.warn(
            '[amm-cli] using legacy VAULT_PASSPHRASE; rename to AMM_VAULT_PASSPHRASE to avoid collision with sibling deployments (e.g. treasury).',
          );
        }
        p1 = envPass;
      } else {
        p1 = await password({ message: 'new passphrase:', mask: '*' });
        const p2 = await password({ message: 'confirm passphrase:', mask: '*' });
        if (p1 !== p2) {
          console.error('passphrases do not match');
          process.exit(1);
        }
        if (p1.length < 12) {
          const ok = await confirm({
            message: 'passphrase is short (<12 chars). continue?',
            default: false,
          });
          if (!ok) process.exit(1);
        }
      }
      await v.init(p1);
      console.log(`vault created at ${v.path}`);
    });

  vault
    .command('info')
    .description('show vault location and wallet count')
    .action(async () => {
      const v = new Vault();
      console.log(`path:   ${v.path}`);
      console.log(`exists: ${await v.exists()}`);
    });

  vault
    .command('change-passphrase')
    .description('rotate the vault passphrase')
    .action(async () => {
      const v = new Vault();
      const oldP = await password({ message: 'current passphrase:', mask: '*' });
      await v.unlock(oldP);
      const newP1 = await password({ message: 'new passphrase:', mask: '*' });
      const newP2 = await password({ message: 'confirm new passphrase:', mask: '*' });
      if (newP1 !== newP2) {
        console.error('passphrases do not match');
        process.exit(1);
      }
      await v.changePassphrase(newP1);
      console.log('passphrase rotated.');
    });
}
