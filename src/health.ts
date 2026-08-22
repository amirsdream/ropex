/**
 * Worker health probes + backlog SLO evaluation.
 */

import { existsSync } from "node:fs";
import { queueSummary } from "./queue.js";
import type { ClusterState, QueuedTask, Worker } from "./types.js";

export type WorkerHealth = {
  id: string;
  status: Worker["status"];
  healthy: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
};

export type BacklogSlo = {
  pending: number;
  oldestPendingAgeMs: number | null;
  /** True when pending depth or age exceeds thresholds. */
  breached: boolean;
  reasons: string[];
};

export type HealthReport = {
  ok: boolean;
  workers: WorkerHealth[];
  unhealthy: number;
  backlog: BacklogSlo;
  at: string;
};

export type HealthOptions = {
  /** Max age of oldest pending item before SLO breach (default 5m). */
  maxPendingAgeMs?: number;
  /** Max pending depth before SLO breach (default 100). */
  maxPendingDepth?: number;
  /** Max time a worker may stay `running` on a claim before unhealthy (default 30m). */
  maxRunningMs?: number;
  now?: number;
};

function claimedForWorker(state: ClusterState | undefined, workerId: string): QueuedTask | undefined {
  return state?.queue?.find((q) => q.status === "claimed" && q.workerId === workerId);
}

export function probeWorker(
  worker: Worker,
  opts: HealthOptions = {},
  state?: ClusterState,
): WorkerHealth {
  const now = opts.now ?? Date.now();
  const maxRunning = opts.maxRunningMs ?? 30 * 60_000;
  const checks: WorkerHealth["checks"] = [];

  checks.push({
    name: "digest",
    ok: Boolean(worker.imageDigest && worker.imageDigest.length >= 8),
    detail: worker.imageDigest?.slice(0, 8),
  });

  if (worker.status !== "retired") {
    checks.push({
      name: "worktree",
      ok: !worker.worktree || existsSync(worker.worktree),
      detail: worker.worktree,
    });
  }

  if (worker.status === "failed") {
    checks.push({ name: "not-failed", ok: false, detail: "failed" });
  } else if (worker.status === "running") {
    const claim = claimedForWorker(state, worker.id);
    const started = claim?.claimedAt ?? claim?.enqueuedAt;
    if (started) {
      const age = now - Date.parse(started);
      const ok = Number.isFinite(age) && age <= maxRunning;
      checks.push({
        name: "not-stuck",
        ok,
        detail: ok ? `running ${Math.round(age / 1000)}s` : `stuck ${Math.round(age / 1000)}s > ${maxRunning / 1000}s`,
      });
    } else {
      // Running without a claim — orphaned; treat as unhealthy.
      checks.push({ name: "not-stuck", ok: false, detail: "running without claim" });
    }
  } else {
    checks.push({
      name: "lifecycle",
      ok: worker.status === "idle" || worker.status === "pending",
      detail: worker.status,
    });
  }

  const healthy = checks.every((c) => c.ok);
  return { id: worker.id, status: worker.status, healthy, checks };
}

export function evaluateBacklogSlo(state: ClusterState, opts: HealthOptions = {}): BacklogSlo {
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxPendingAgeMs ?? 5 * 60_000;
  const maxDepth = opts.maxPendingDepth ?? 100;
  const pending = state.queue?.filter((q) => q.status === "pending") ?? [];
  const q = queueSummary(state);
  let oldestPendingAgeMs: number | null = null;
  for (const item of pending) {
    const age = now - Date.parse(item.enqueuedAt);
    if (!Number.isFinite(age)) continue;
    if (oldestPendingAgeMs === null || age > oldestPendingAgeMs) oldestPendingAgeMs = age;
  }
  const reasons: string[] = [];
  if (q.pending > maxDepth) reasons.push(`pending depth ${q.pending} > ${maxDepth}`);
  if (oldestPendingAgeMs !== null && oldestPendingAgeMs > maxAge) {
    reasons.push(`oldest pending age ${oldestPendingAgeMs}ms > ${maxAge}ms`);
  }
  return {
    pending: q.pending,
    oldestPendingAgeMs,
    breached: reasons.length > 0,
    reasons,
  };
}

export function healthReport(state: ClusterState, opts: HealthOptions = {}): HealthReport {
  const live = (state.workers ?? []).filter((w) => w.status !== "retired");
  const workers = live.map((w) => probeWorker(w, opts, state));
  const backlog = evaluateBacklogSlo(state, opts);
  const unhealthy = workers.filter((w) => !w.healthy).length;
  return {
    ok: unhealthy === 0 && !backlog.breached,
    workers,
    unhealthy,
    backlog,
    at: new Date(opts.now ?? Date.now()).toISOString(),
  };
}
