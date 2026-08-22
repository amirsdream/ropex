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
  reclaimExpiredLeases,
} from "./queue.js";
import { runTask, type RunTaskOptions } from "./runtime.js";
import type { ClusterState, RunResult } from "./types.js";

export type DrainOptions = RunTaskOptions & {
  limit?: number;
  /** Max parallel runTask calls (default 1 = sequential). */
  concurrency?: number;
  /** Max claim attempts before dead-letter (default 3). */
  maxAttempts?: number;
  /** Claim lease duration in ms (default 5m). */
  leaseMs?: number;
};

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
  const concurrency = Math.max(1, opts.concurrency ?? 1);
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
          completeQueued(state, c.queueId, true, undefined, { maxAttempts: opts.maxAttempts });
          return result;
        } catch (err) {
          completeQueued(state, c.queueId, false, err instanceof Error ? err.message : String(err), {
            maxAttempts: opts.maxAttempts,
          });
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
