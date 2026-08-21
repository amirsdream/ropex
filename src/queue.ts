/**
 * Durable work queue + fair scheduler.
 * GitHub webhooks / simulate / CLI enqueue; drain claims idle workers LRU-first.
 */

import type { ClusterMetrics, ClusterState, QueuedTask, Task, Worker } from "./types.js";

export function emptyMetrics(): ClusterMetrics {
  return { tasksCompleted: 0, tasksFailed: 0, tasksEnqueued: 0 };
}

export function ensureQueue(state: ClusterState): ClusterState {
  if (!state.queue) state.queue = [];
  if (!state.metrics) state.metrics = emptyMetrics();
  return state;
}

export function enqueueTask(
  state: ClusterState,
  task: Task,
  source: QueuedTask["source"] = "cli",
): QueuedTask {
  ensureQueue(state);
  const existing = state.queue.find((q) => q.id === task.id && q.status === "pending");
  if (existing) return existing;

  const item: QueuedTask = {
    id: task.id,
    task,
    enqueuedAt: new Date().toISOString(),
    status: "pending",
    attempts: 0,
    source,
  };
  state.queue.push(item);
  state.metrics.tasksEnqueued += 1;
  state.metrics.lastEventAt = item.enqueuedAt;
  return item;
}

/** Idle workers only, least-recently-used first (fair across replicas). */
export function pickIdleWorker(state: ClusterState, agentName: string): Worker | undefined {
  const idle = state.workers.filter(
    (w) => w.agent === agentName && (w.status === "idle" || w.status === "running" || w.status === "pending"),
  );
  // Prefer truly idle; among them, oldest lastTaskAt (or never used).
  const ranked = [...idle].sort((a, b) => {
    const aIdle = a.status === "idle" || a.status === "pending" ? 0 : 1;
    const bIdle = b.status === "idle" || b.status === "pending" ? 0 : 1;
    if (aIdle !== bIdle) return aIdle - bIdle;
    const at = a.lastTaskAt ?? "";
    const bt = b.lastTaskAt ?? "";
    if (at !== bt) return at < bt ? -1 : 1;
    return a.replica - b.replica;
  });
  // Only claim idle/pending — never steal a busy running worker.
  return ranked.find((w) => w.status === "idle" || w.status === "pending");
}

export type DrainResult = {
  claimed: Array<{ queueId: string; workerId: string; task: Task }>;
  remaining: number;
};

/**
 * Claim up to `limit` pending queue items onto idle workers.
 * Does not execute — caller runs `runTask` then `completeQueued`.
 */
export function claimPending(state: ClusterState, limit = 32): DrainResult {
  ensureQueue(state);
  const claimed: DrainResult["claimed"] = [];
  const pending = state.queue.filter((q) => q.status === "pending");

  for (const item of pending) {
    if (claimed.length >= limit) break;
    const worker = pickIdleWorker(state, item.task.agent);
    if (!worker) continue;
    item.status = "claimed";
    item.workerId = worker.id;
    item.attempts += 1;
    worker.status = "running";
    claimed.push({ queueId: item.id, workerId: worker.id, task: item.task });
  }

  return {
    claimed,
    remaining: state.queue.filter((q) => q.status === "pending").length,
  };
}

export function completeQueued(
  state: ClusterState,
  queueId: string,
  ok: boolean,
  error?: string,
): void {
  ensureQueue(state);
  const item = state.queue.find((q) => q.id === queueId);
  if (!item) return;
  item.status = ok ? "done" : "failed";
  item.finishedAt = new Date().toISOString();
  if (error) item.error = error;
  if (ok) state.metrics.tasksCompleted += 1;
  else state.metrics.tasksFailed += 1;
  state.metrics.lastDrainAt = item.finishedAt;
}

export function queueSummary(state: ClusterState): {
  pending: number;
  claimed: number;
  done: number;
  failed: number;
} {
  ensureQueue(state);
  const counts = { pending: 0, claimed: 0, done: 0, failed: 0 };
  for (const q of state.queue) {
    counts[q.status] += 1;
  }
  return counts;
}
