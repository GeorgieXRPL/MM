import { password } from '@inquirer/prompts';
import { Vault } from '@amm/core';
import { buildContext, type AppContext } from '@amm/orchestrator';

let cachedCtx: AppContext | null = null;

/**
 * Resolve the MM vault passphrase from app-namespaced env vars first, then
 * fall back to the generic name with a one-time warning. The treasury uses
 * `TREASURY_VAULT_PASSPHRASE` exclusively, so once both sides are migrated
 * the generic var is dead and any operator reaching for it gets a clear
 * heads-up that they're using a deprecated channel that can collide.
 */
let warnedLegacyPassphrase = false;
function readMmPassphraseFromEnv(): string | undefined {
  if (process.env.AMM_VAULT_PASSPHRASE) return process.env.AMM_VAULT_PASSPHRASE;
  if (process.env.VAULT_PASSPHRASE) {
    if (!warnedLegacyPassphrase) {
      warnedLegacyPassphrase = true;
      console.warn(
        '[amm-cli] using legacy VAULT_PASSPHRASE env var; rename to AMM_VAULT_PASSPHRASE to avoid collision with sibling deployments (e.g. treasury).',
      );
    }
    return process.env.VAULT_PASSPHRASE;
  }
  return undefined;
}

export async function unlockVault(): Promise<Vault> {
  const v = new Vault();
  if (!(await v.exists())) {
    throw new Error(
      `no vault found at ${v.path}. run \`amm vault init\` first.`,
    );
  }
  const passphrase =
    readMmPassphraseFromEnv() ??
    (await password({ message: 'vault passphrase:', mask: '*' }));
  await v.unlock(passphrase);
  return v;
}

export async function getContext(): Promise<AppContext> {
  if (cachedCtx) return cachedCtx;
  const vault = await unlockVault();
  cachedCtx = buildContext(vault);
  return cachedCtx;
}

export function fmtSol(lamports: number): string {
  return `${(lamports / 1_000_000_000).toFixed(6)} SOL`;
}
