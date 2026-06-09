import type { StrategyId } from '@amm/shared';

export interface StrategyHandle {
  readonly id: StrategyId;
  readonly runId: number;
  /** Starts the run (returns once the loop has begun). */
  start(): Promise<void>;
  /** Stops the run gracefully (resolves when the active iteration finishes). */
  stop(): Promise<void>;
  /** True between start() and stop(). */
  isRunning(): boolean;
  /** Optional pause: keeps the loop alive but skips actions until resume(). */
  pause?(): Promise<void>;
  /** Optional resume from a previous pause(). */
  resume?(): Promise<void>;
  /** Optional runtime config patch. Strategies may reject illegal keys. */
  update?(patch: Record<string, unknown>): Promise<void>;
  /** Returns true if currently paused (false otherwise / if not supported). */
  isPaused?(): boolean;
}
