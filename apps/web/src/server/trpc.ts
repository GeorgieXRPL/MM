import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { session } from './session.js';

export interface Ctx {
  session: typeof session;
}

const t = initTRPC.context<Ctx>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

export const lockedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session.isUnlocked()) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'vault is locked' });
  }
  return next();
});

export function createContext(): Ctx {
  return { session };
}
