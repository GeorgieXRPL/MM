import { router } from './trpc.js';
import { vaultRouter } from './routers/vault.js';
import { runsRouter } from './routers/runs.js';
import { lpRouter } from './routers/lp.js';
import { systemRouter } from './routers/system.js';

export const appRouter = router({
  vault: vaultRouter,
  runs: runsRouter,
  lp: lpRouter,
  system: systemRouter,
});

export type AppRouter = typeof appRouter;
