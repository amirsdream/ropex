/**
 * Drain the work queue: claim idle workers, run Hermes→DeepSeek, mark done/failed.
 */

import { claimPending, completeQueued, ensureQueue } from "./queue.js";
import { runTask, type RunTaskOptions } from "./runtime.js";
import type { ClusterState, RunResult } from "./types.js";

export type DrainOptions = RunTaskOptions & {
  limit?: number;
};

export async function drainQueue(
  state: ClusterState,
  opts: DrainOptions = {},
): Promise<RunResult[]> {
  ensureQueue(state);
  const { claimed } = claimPending(state, opts.limit ?? 32);
  const results: RunResult[] = [];

  for (const c of claimed) {
    const worker = state.workers.find((w) => w.id === c.workerId);
    if (!worker) {
      completeQueued(state, c.queueId, false, "worker missing");
      continue;
    }
    try {
      const result = await runTask(state, worker, c.task, opts);
      completeQueued(state, c.queueId, true);
      results.push(result);
    } catch (err) {
      worker.status = "failed";
      completeQueued(state, c.queueId, false, err instanceof Error ? err.message : String(err));
    }
  }

  return results;
}
