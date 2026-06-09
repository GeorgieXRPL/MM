import { Vault } from '@amm/core';
import { buildContext, Orchestrator, type AppContext } from '@amm/orchestrator';

/**
 * In-process singleton holding the unlocked vault and live orchestrator.
 *
 * The web app is a single-user, localhost-only tool. The vault is unlocked
 * once via the unlock screen, then held in memory for the life of the dev
 * server / next start process.
 */
class Session {
  private vault: Vault | null = null;
  private ctx: AppContext | null = null;
  private orch: Orchestrator | null = null;

  async unlock(passphrase: string): Promise<void> {
    if (this.vault) return;
    const v = new Vault();
    if (!(await v.exists())) {
      throw new Error('no vault. create one with `pnpm cli vault init`.');
    }
    await v.unlock(passphrase);
    this.vault = v;
    this.ctx = buildContext(v);
    this.orch = new Orchestrator(this.ctx);
  }

  isUnlocked(): boolean {
    return this.vault !== null;
  }

  context(): AppContext {
    if (!this.ctx) throw new Error('vault locked');
    return this.ctx;
  }

  orchestrator(): Orchestrator {
    if (!this.orch) throw new Error('vault locked');
    return this.orch;
  }

  lock(): void {
    this.orch?.stopAll().catch(() => {});
    this.vault?.lock();
    this.vault = null;
    this.ctx = null;
    this.orch = null;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __ammSession: Session | undefined;
}

export const session: Session = (globalThis.__ammSession ??= new Session());
