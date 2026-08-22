/**
 * Drain the work queue: claim idle workers, run Hermes→DeepSeek, mark done/failed.
 * Supports bounded concurrency for parallel replica execution.
 * Transient failures release the worker and retry / dead-letter the queue item.
 * Heartbeats extend claim leases while a task runs.
 */

import {
  claimPending,
  completeQueued,
  ensureQueue,
  heartbeatClaim,
  isQueuePaused,
  queueSummary,
  reclaimExpiredLeases,
} from "./queue.js";
import { runTask, type RunTaskOptions } from "./runtime.js";
import { deliverGitTaskFromQueueItem } from "./tasks.js";
import type { ClusterState, RunResult } from "./types.js";

/** Hard ceiling so UI/API cannot spawn uncapped parallel drains. */
export const MAX_DRAIN_CONCURRENCY = 32;

export type DrainOptions = RunTaskOptions & {
  limit?: number;
  /** Max parallel runTask calls (default: state.drainConcurrency or 1). */
  concurrency?: number;
  /** Max claim attempts before dead-letter (default 3). */
  maxAttempts?: number;
  /** Claim lease duration in ms (default 5m). */
  leaseMs?: number;
};

export function clampDrainConcurrency(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_DRAIN_CONCURRENCY, Math.max(1, Math.floor(n)));
}

export function getDrainConcurrency(state: ClusterState): number {
  return clampDrainConcurrency(state.drainConcurrency ?? 1);
}

/** Persist preferred drain concurrency on cluster state (capped). */
export function setDrainConcurrency(state: ClusterState, n: number): number {
  const v = clampDrainConcurrency(n);
  state.drainConcurrency = v;
  return v;
}

export type DrainStatus = {
  concurrency: number;
  maxConcurrency: number;
  paused: boolean;
  pending: number;
  claimed: number;
  idleWorkers: number;
  runningWorkers: number;
};

export function drainStatus(state: ClusterState): DrainStatus {
  ensureQueue(state);
  const q = queueSummary(state);
  const live = state.workers.filter((w) => w.status !== "retired" && !w.cordoned);
  return {
    concurrency: getDrainConcurrency(state),
    maxConcurrency: MAX_DRAIN_CONCURRENCY,
    paused: isQueuePaused(state),
    pending: q.pending,
    claimed: q.claimed,
    idleWorkers: live.filter((w) => w.status === "idle").length,
    runningWorkers: live.filter((w) => w.status === "running").length,
  };
}

export async function drainQueue(
  state: ClusterState,
  opts: DrainOptions = {},
): Promise<RunResult[]> {
  ensureQueue(state);
  reclaimExpiredLeases(state, { maxAttempts: opts.maxAttempts });
  const { claimed } = claimPending(state, opts.limit ?? 32, {
    leaseMs: opts.leaseMs,
    maxAttempts: opts.maxAttempts,
  });
  const concurrency = clampDrainConcurrency(opts.concurrency ?? getDrainConcurrency(state));
  const results: RunResult[] = [];

  for (let i = 0; i < claimed.length; i += concurrency) {
    const batch = claimed.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (c) => {
        const worker = state.workers.find((w) => w.id === c.workerId);
        if (!worker) {
          completeQueued(state, c.queueId, false, "worker missing", {
            maxAttempts: opts.maxAttempts,
            releaseWorker: false,
          });
          return undefined;
        }
        try {
          heartbeatClaim(state, c.queueId, { leaseMs: opts.leaseMs });
          const result = await runTask(state, worker, c.task, opts);
          const updated = completeQueued(state, c.queueId, true, undefined, {
            maxAttempts: opts.maxAttempts,
          });
          if (updated) deliverGitTaskFromQueueItem(updated, result.output);
          return result;
        } catch (err) {
          const updated = completeQueued(state, c.queueId, false, err instanceof Error ? err.message : String(err), {
            maxAttempts: opts.maxAttempts,
          });
          if (updated) deliverGitTaskFromQueueItem(updated);
          return undefined;
        }
      }),
    );
    for (const r of batchResults) {
      if (r) results.push(r);
    }
  }

  return results;
}
