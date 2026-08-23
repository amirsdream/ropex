/**
 * Worker cordon / eviction — stop scheduling onto a worker, then retire when idle.
 * Prefer destroyWorker from scale.ts for on-demand teardown (memory promote + worktree GC).
 */

import { recordAudit } from "./audit.js";
import { destroyWorker } from "./scale.js";
import type { ClusterState, Worker } from "./types.js";

export function cordonWorker(state: ClusterState, workerId: string): Worker | undefined {
  const w = state.workers.find((x) => x.id === workerId && x.status !== "retired");
  if (!w) return undefined;
  w.cordoned = true;
  recordAudit(state, {
    kind: "info",
    message: `cordoned ${workerId}`,
    agent: w.agent,
    workerId,
  });
  return w;
}

export function uncordonWorker(state: ClusterState, workerId: string): Worker | undefined {
  const w = state.workers.find((x) => x.id === workerId && x.status !== "retired");
  if (!w) return undefined;
  w.cordoned = false;
  recordAudit(state, {
    kind: "info",
    message: `uncordoned ${workerId}`,
    agent: w.agent,
    workerId,
  });
  return w;
}

export type EvictResult = {
  worker?: Worker;
  status: "retired" | "cordoned" | "missing";
  reason: string;
};

/**
 * Evict a worker: if idle/pending/failed → retire immediately; if running → cordon and wait.
 */
export function evictWorker(state: ClusterState, workerId: string): EvictResult {
  const w = state.workers.find((x) => x.id === workerId && x.status !== "retired");
  if (!w) return { status: "missing", reason: `worker not found: ${workerId}` };
  if (w.status === "running") {
    w.cordoned = true;
    recordAudit(state, {
      kind: "info",
      message: `evict deferred (running) → cordoned ${workerId}`,
      agent: w.agent,
      workerId,
    });
    return {
      worker: w,
      status: "cordoned",
      reason: "worker running; cordoned until idle — re-evict when idle",
    };
  }
  const destroyed = destroyWorker(state, workerId, { reason: "evict" });
  return {
    worker: destroyed ?? w,
    status: "retired",
    reason: "retired",
  };
}

export function cordonedWorkers(state: ClusterState): Worker[] {
  return state.workers.filter((w) => w.cordoned && w.status !== "retired");
}
