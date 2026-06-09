import { createLogger, type StrategyId } from '@amm/shared';
import {
  ClmmMmStrategy,
  type ClmmMmConfig,
  CounterMomentumStrategy,
  type CounterMomentumConfig,
  InventoryRebalanceStrategy,
  type InventoryRebalanceConfig,
  MeteoraLpStrategy,
  type MeteoraLpConfig,
  ObMmStrategy,
  type ObMmConfig,
  VolumeStrategy,
  type VolumeStrategyConfig,
  type StrategyHandle,
} from '@amm/strategies';
import type { AppContext } from './context.js';

const log = createLogger('orchestrator');

/**
 * Tracks running strategies, persists their start/stop events, and exposes a
 * tiny RPC-able surface for the CLI and the web dashboard.
 */
export class Orchestrator {
  private readonly handles = new Map<number, StrategyHandle>();

  constructor(private readonly ctx: AppContext) {
    // Reconcile DB state on startup. The store records `status: running` as
    // soon as a strategy starts, and only flips it to `stopped`/`errored`
    // when the strategy's stop path runs cleanly. If the previous process
    // exited unexpectedly (force-kill, crash, OS power loss) those rows are
    // left in `running` state forever, which makes the dashboard's "Recent
    // runs" table lie about what's currently active and confuses the
    // "Active runs" card vs the live orchestrator handle map. This new
    // process can't possibly be running those strategies (handles map is
    // empty here) so we mark them errored with a clear reason. Cheap; a
    // single store read + N writes, none of them async.
    const stale = this.ctx.store
      .listRuns(1000)
      .filter((r) => r.status === 'running');
    if (stale.length > 0) {
      log.warn(
        { count: stale.length, ids: stale.map((r) => r.id) },
        'reconciling stale running rows from a prior process',
      );
      for (const r of stale) {
        this.ctx.store.stopRun(r.id, 'errored', 'process exited unexpectedly before stop');
      }
    }
  }

  list(): { runId: number; id: StrategyId; running: boolean; paused: boolean }[] {
    return Array.from(this.handles.values()).map((h) => ({
      runId: h.runId,
      id: h.id,
      running: h.isRunning(),
      paused: h.isPaused?.() ?? false,
    }));
  }

  async startVolume(cfg: VolumeStrategyConfig): Promise<number> {
    const runId = this.ctx.store.startRun('volume', cfg.poolId.toBase58(), {
      venue: cfg.venue,
      wallets: cfg.wallets.map((w) => w.publicKey.toBase58()),
    });
    const strat = new VolumeStrategy(runId, cfg, {
      rpc: this.ctx.rpc,
      exec: this.ctx.exec,
      venues: this.ctx.venues,
      store: this.ctx.store,
    });
    this.handles.set(runId, strat);
    await strat.start();
    log.info({ runId }, 'volume started');
    return runId;
  }

  async startClmmMm(cfg: ClmmMmConfig): Promise<number> {
    const runId = this.ctx.store.startRun('clmm-mm', cfg.poolId.toBase58(), {
      venue: cfg.venue,
      wallet: cfg.wallet.publicKey.toBase58(),
    });
    const strat = new ClmmMmStrategy(runId, cfg, {
      rpc: this.ctx.rpc,
      exec: this.ctx.exec,
      venues: this.ctx.venues,
      store: this.ctx.store,
      oracle: this.ctx.oracle,
    });
    this.handles.set(runId, strat);
    await strat.start();
    log.info({ runId }, 'clmm-mm started');
    return runId;
  }

  async startObMm(cfg: ObMmConfig): Promise<number> {
    const runId = this.ctx.store.startRun('ob-mm', cfg.marketId.toBase58(), {
      wallet: cfg.wallet.publicKey.toBase58(),
    });
    const strat = new ObMmStrategy(runId, cfg, {
      rpc: this.ctx.rpc,
      exec: this.ctx.exec,
      venues: this.ctx.venues,
      store: this.ctx.store,
    });
    this.handles.set(runId, strat);
    await strat.start();
    log.info({ runId }, 'ob-mm started');
    return runId;
  }

  async startInventoryRebalance(cfg: InventoryRebalanceConfig): Promise<number> {
    const runId = this.ctx.store.startRun('inventory-rebalance', cfg.poolId.toBase58(), {
      venue: cfg.venue,
      wallet: cfg.wallet.publicKey.toBase58(),
      targetBaseFraction: cfg.targetBaseFraction,
      driftThreshold: cfg.driftThreshold,
    });
    const strat = new InventoryRebalanceStrategy(runId, cfg, {
      rpc: this.ctx.rpc,
      exec: this.ctx.exec,
      venues: this.ctx.venues,
      store: this.ctx.store,
    });
    this.handles.set(runId, strat);
    await strat.start();
    log.info({ runId }, 'inventory-rebalance started');
    return runId;
  }

  async startCounterMomentum(cfg: CounterMomentumConfig): Promise<number> {
    const runId = this.ctx.store.startRun('counter-momentum', cfg.poolId.toBase58(), {
      venue: cfg.venue,
      wallet: cfg.wallet.publicKey.toBase58(),
      triggerPct: cfg.triggerPct,
      lookbackSec: cfg.lookbackSec,
    });
    const strat = new CounterMomentumStrategy(runId, cfg, {
      rpc: this.ctx.rpc,
      exec: this.ctx.exec,
      venues: this.ctx.venues,
      store: this.ctx.store,
    });
    this.handles.set(runId, strat);
    await strat.start();
    log.info({ runId }, 'counter-momentum started');
    return runId;
  }

  async startMeteoraLp(cfg: MeteoraLpConfig): Promise<number> {
    const runId = this.ctx.store.startRun('meteora-lp', cfg.poolId.toBase58(), {
      wallet: cfg.wallet.publicKey.toBase58(),
      mode: cfg.mode ?? 'two-sided',
      strategyType: cfg.strategyType ?? 'spot',
    });
    const strat = new MeteoraLpStrategy(runId, cfg, {
      rpc: this.ctx.rpc,
      exec: this.ctx.exec,
      venues: this.ctx.venues,
      store: this.ctx.store,
      oracle: this.ctx.oracle,
    });
    this.handles.set(runId, strat);
    await strat.start();
    log.info({ runId }, 'meteora-lp started');
    return runId;
  }

  async pause(runId: number): Promise<void> {
    const h = this.handles.get(runId);
    if (!h) throw new Error(`no run ${runId}`);
    if (typeof h.pause !== 'function') {
      throw new Error(`strategy '${h.id}' does not support pause`);
    }
    await h.pause();
  }

  async resume(runId: number): Promise<void> {
    const h = this.handles.get(runId);
    if (!h) throw new Error(`no run ${runId}`);
    if (typeof h.resume !== 'function') {
      throw new Error(`strategy '${h.id}' does not support resume`);
    }
    await h.resume();
  }

  async update(runId: number, patch: Record<string, unknown>): Promise<void> {
    const h = this.handles.get(runId);
    if (!h) throw new Error(`no run ${runId}`);
    if (typeof h.update !== 'function') {
      throw new Error(`strategy '${h.id}' does not support update`);
    }
    await h.update(patch);
  }

  async stop(runId: number): Promise<void> {
    const h = this.handles.get(runId);
    if (!h) throw new Error(`no run ${runId}`);
    await h.stop();
    this.handles.delete(runId);
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.handles.values()).map((h) => h.stop()));
    this.handles.clear();
  }
}
