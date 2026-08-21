/**
 * Drain the work queue: claim idle workers, run Hermes→DeepSeek, mark done/failed.
 * Supports bounded concurrency for parallel replica execution.
 */

import { claimPending, completeQueued, ensureQueue } from "./queue.js";
import { runTask, type RunTaskOptions } from "./runtime.js";
import type { ClusterState, RunResult } from "./types.js";

export type DrainOptions = RunTaskOptions & {
  limit?: number;
  /** Max parallel runTask calls (default 1 = sequential). */
  concurrency?: number;
};

export async function drainQueue(
  state: ClusterState,
  opts: DrainOptions = {},
): Promise<RunResult[]> {
  ensureQueue(state);
  const { claimed } = claimPending(state, opts.limit ?? 32);
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const results: RunResult[] = [];

  for (let i = 0; i < claimed.length; i += concurrency) {
    const batch = claimed.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (c) => {
        const worker = state.workers.find((w) => w.id === c.workerId);
        if (!worker) {
          completeQueued(state, c.queueId, false, "worker missing");
          return undefined;
        }
        try {
          const result = await runTask(state, worker, c.task, opts);
          completeQueued(state, c.queueId, true);
          return result;
        } catch (err) {
          worker.status = "failed";
          completeQueued(state, c.queueId, false, err instanceof Error ? err.message : String(err));
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
