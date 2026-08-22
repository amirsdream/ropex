/**
 * Durable work queue + fair scheduler.
 * GitHub webhooks / simulate / CLI enqueue; drain claims idle workers LRU-first.
 * Failed claims retry with backoff, then land in the dead-letter lane.
 */

import { buildAgentImage } from "./image.js";
import { admitTask } from "./admission.js";
import { recordAudit } from "./audit.js";
import { chargeBudget } from "./budget.js";
import { canPlace, placementScore } from "./placement.js";
import type { ClusterMetrics, ClusterState, QueuedTask, Task, Worker } from "./types.js";

/** Default max claim attempts before dead-letter. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Default claim lease duration (5 minutes). */
export const DEFAULT_LEASE_MS = 5 * 60_000;

export function emptyMetrics(): ClusterMetrics {
  return {
    tasksCompleted: 0,
    tasksFailed: 0,
    tasksEnqueued: 0,
    tasksRetried: 0,
    tasksDead: 0,
    leasesReclaimed: 0,
  };
}

export function ensureQueue(state: ClusterState): ClusterState {
  if (!state.queue) state.queue = [];
  if (!state.metrics) state.metrics = emptyMetrics();
  if (state.metrics.tasksRetried === undefined) state.metrics.tasksRetried = 0;
  if (state.metrics.tasksDead === undefined) state.metrics.tasksDead = 0;
  if (state.metrics.leasesReclaimed === undefined) state.metrics.leasesReclaimed = 0;
  return state;
}

export function enqueueTask(
  state: ClusterState,
  task: Task,
  source: QueuedTask["source"] = "cli",
  opts: { priority?: number } = {},
): QueuedTask {
  ensureQueue(state);
  const existing = state.queue.find((q) => q.id === task.id && q.status === "pending");
  if (existing) {
    if (opts.priority !== undefined && opts.priority > existing.priority) {
      existing.priority = opts.priority;
    }
    return existing;
  }

  const decision = admitTask(state, task);
  const item: QueuedTask = {
    id: task.id,
    task,
    enqueuedAt: new Date().toISOString(),
    status: decision.status === "deny" ? "failed" : "pending",
    attempts: 0,
    source,
    priority: opts.priority ?? 0,
    error: decision.status === "deny" ? decision.reason : undefined,
    finishedAt: decision.status === "deny" ? new Date().toISOString() : undefined,
  };
  state.queue.push(item);
  state.metrics.tasksEnqueued += 1;
  state.metrics.lastEventAt = item.enqueuedAt;
  if (decision.status === "deny") {
    state.metrics.tasksFailed += 1;
    recordAudit(state, {
      kind: "dead",
      message: `enqueue denied: ${decision.reason}`,
      agent: task.agent,
      taskId: task.id,
      meta: { source, denied: true },
    });
  } else {
    recordAudit(state, {
      kind: "enqueue",
      message: `enqueued via ${source}`,
      agent: task.agent,
      taskId: task.id,
      meta: { source, priority: item.priority },
    });
  }
  return item;
}

/** Idle workers only, least-recently-used first, with optional fleet affinity.
 * Prefers workers whose imageDigest matches the desired agent image (canary-safe).
 * Honors placement require/prefer/taints when the desired agent declares them.
 */
export function pickIdleWorker(
  state: ClusterState,
  agentName: string,
  opts: { preferFleet?: string; task?: Task } = {},
): Worker | undefined {
  const agent = state.desired.find((a) => a.metadata.name === agentName);
  const desiredDigest = agent ? buildAgentImage(agent).digest : undefined;
  const placement = agent?.spec.placement;
  const idle = state.workers.filter(
    (w) => w.agent === agentName && (w.status === "idle" || w.status === "running" || w.status === "pending"),
  );
  const ranked = [...idle].sort((a, b) => {
    // Prefer digest match so canary holdouts (old digest) are not claimed first.
    if (desiredDigest) {
      const aMatch = a.imageDigest === desiredDigest ? 0 : 1;
      const bMatch = b.imageDigest === desiredDigest ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
    }
    const aIdle = a.status === "idle" || a.status === "pending" ? 0 : 1;
    const bIdle = b.status === "idle" || b.status === "pending" ? 0 : 1;
    if (aIdle !== bIdle) return aIdle - bIdle;
    // Soft placement prefer (higher score first).
    const aScore = placementScore(a, placement, opts.task);
    const bScore = placementScore(b, placement, opts.task);
    if (aScore !== bScore) return bScore - aScore;
    // Fleet affinity: prefer workers in the requested fleet.
    if (opts.preferFleet) {
      const aFleet = a.fleet === opts.preferFleet ? 0 : 1;
      const bFleet = b.fleet === opts.preferFleet ? 0 : 1;
      if (aFleet !== bFleet) return aFleet - bFleet;
    }
    const at = a.lastTaskAt ?? "";
    const bt = b.lastTaskAt ?? "";
    if (at !== bt) return at < bt ? -1 : 1;
    return a.replica - b.replica;
  });
  const candidates = ranked.filter((w) => {
    if (!(w.status === "idle" || w.status === "pending")) return false;
    if (w.cordoned) return false;
    if (!canPlace(w, placement, opts.task)) return false;
    return true;
  });
  if (!desiredDigest) return candidates[0];
  return candidates.find((w) => w.imageDigest === desiredDigest);
}

export type DrainResult = {
  claimed: Array<{ queueId: string; workerId: string; task: Task }>;
  remaining: number;
};

/** Exponential backoff: 1s, 2s, 4s… capped at 15m (attempt is post-increment claim count). */
export function retryBackoffMs(attempts: number): number {
  const exp = Math.max(0, attempts - 1);
  return Math.min(1_000 * 2 ** exp, 15 * 60_000);
}

function isClaimablePending(item: QueuedTask, now: number): boolean {
  if (item.status !== "pending") return false;
  if (!item.nextRetryAt) return true;
  const at = Date.parse(item.nextRetryAt);
  return !Number.isFinite(at) || at <= now;
}

/**
 * Claim up to `limit` pending queue items onto idle workers.
 * Reclaims expired leases first. Skips items waiting on `nextRetryAt`.
 */
export function claimPending(
  state: ClusterState,
  limit = 32,
  opts: { preferFleet?: string; now?: number; leaseMs?: number; maxAttempts?: number } = {},
): DrainResult {
  ensureQueue(state);
  const now = opts.now ?? Date.now();
  reclaimExpiredLeases(state, {
    now,
    maxAttempts: opts.maxAttempts,
  });
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const claimed: DrainResult["claimed"] = [];
  const pending = state.queue
    .filter((q) => isClaimablePending(q, now))
    .sort((a, b) => {
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      if (pa !== pb) return pb - pa; // higher priority first
      return a.enqueuedAt < b.enqueuedAt ? -1 : a.enqueuedAt > b.enqueuedAt ? 1 : 0;
    });

  for (const item of pending) {
    if (claimed.length >= limit) break;
    const agent = state.desired.find((a) => a.metadata.name === item.task.agent);
    const fleetHint =
      opts.preferFleet ??
      state.workers.find((w) => w.agent === item.task.agent)?.fleet ??
      agent?.derivedFrom?.fleet;
    const worker = pickIdleWorker(state, item.task.agent, {
      preferFleet: fleetHint,
      task: item.task,
    });
    if (!worker) continue;
    item.status = "claimed";
    item.workerId = worker.id;
    item.claimedAt = new Date(now).toISOString();
    item.heartbeatAt = item.claimedAt;
    item.leaseExpiresAt = new Date(now + leaseMs).toISOString();
    item.nextRetryAt = undefined;
    item.attempts += 1;
    worker.status = "running";
    claimed.push({ queueId: item.id, workerId: worker.id, task: item.task });
    recordAudit(state, {
      kind: "claim",
      message: `claimed by ${worker.id}`,
      agent: item.task.agent,
      workerId: worker.id,
      taskId: item.id,
      meta: { attempt: item.attempts, leaseMs },
    });
  }

  return {
    claimed,
    remaining: state.queue.filter((q) => q.status === "pending").length,
  };
}

function releaseWorker(state: ClusterState, workerId?: string): void {
  if (!workerId) return;
  const worker = state.workers.find((w) => w.id === workerId);
  if (!worker) return;
  if (worker.status === "running" || worker.status === "failed") {
    worker.status = "idle";
    worker.lastTaskAt = new Date().toISOString();
  }
}

export type CompleteQueuedOptions = {
  /** Max claim attempts before dead-letter (default 3). */
  maxAttempts?: number;
  now?: number;
  /** When false, leave worker status alone (default true → idle). */
  releaseWorker?: boolean;
};

/**
 * Mark a claimed item done, or retry / dead-letter on failure.
 * Policy denials stay `failed` (never claimed). Runtime failures retry then `dead`.
 */
export function completeQueued(
  state: ClusterState,
  queueId: string,
  ok: boolean,
  error?: string,
  opts: CompleteQueuedOptions = {},
): QueuedTask | undefined {
  ensureQueue(state);
  const item = state.queue.find((q) => q.id === queueId);
  if (!item) return undefined;
  const now = opts.now ?? Date.now();
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const workerId = item.workerId;

  if (ok) {
    item.status = "done";
    item.finishedAt = new Date(now).toISOString();
    item.error = undefined;
    item.nextRetryAt = undefined;
    item.leaseExpiresAt = undefined;
    item.heartbeatAt = undefined;
    state.metrics.tasksCompleted += 1;
    state.metrics.lastDrainAt = item.finishedAt;
    if (opts.releaseWorker !== false) releaseWorker(state, workerId);
    chargeBudget(state, item.task, { now, workerId });
    recordAudit(state, {
      kind: "complete",
      message: "task completed",
      agent: item.task.agent,
      workerId,
      taskId: item.id,
    });
    return item;
  }

  if (error) item.error = error;

  const isLease = error === "lease expired";
  if (item.attempts > 0 && item.attempts < maxAttempts) {
    item.status = "pending";
    item.workerId = undefined;
    item.claimedAt = undefined;
    item.leaseExpiresAt = undefined;
    item.heartbeatAt = undefined;
    item.finishedAt = undefined;
    item.nextRetryAt = new Date(now + retryBackoffMs(item.attempts)).toISOString();
    state.metrics.tasksRetried = (state.metrics.tasksRetried ?? 0) + 1;
    state.metrics.lastDrainAt = new Date(now).toISOString();
    if (opts.releaseWorker !== false) releaseWorker(state, workerId);
    recordAudit(state, {
      kind: isLease ? "reclaim" : "retry",
      message: isLease ? "lease expired → retry" : `retry after failure: ${error ?? "unknown"}`,
      agent: item.task.agent,
      workerId,
      taskId: item.id,
      meta: { attempt: item.attempts, nextRetryAt: item.nextRetryAt },
    });
    return item;
  }

  item.status = "dead";
  item.finishedAt = new Date(now).toISOString();
  item.nextRetryAt = undefined;
  item.leaseExpiresAt = undefined;
  item.heartbeatAt = undefined;
  state.metrics.tasksFailed += 1;
  state.metrics.tasksDead = (state.metrics.tasksDead ?? 0) + 1;
  state.metrics.lastDrainAt = item.finishedAt;
  if (opts.releaseWorker !== false) releaseWorker(state, workerId);
  recordAudit(state, {
    kind: "dead",
    message: isLease ? "lease expired → dead" : `dead-letter: ${error ?? "unknown"}`,
    agent: item.task.agent,
    workerId,
    taskId: item.id,
    meta: { attempt: item.attempts },
  });
  return item;
}

/** Extend a claim lease (worker heartbeat). */
export function heartbeatClaim(
  state: ClusterState,
  queueId: string,
  opts: { now?: number; leaseMs?: number } = {},
): QueuedTask | undefined {
  ensureQueue(state);
  const item = state.queue.find((q) => q.id === queueId && q.status === "claimed");
  if (!item) return undefined;
  const now = opts.now ?? Date.now();
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  item.heartbeatAt = new Date(now).toISOString();
  item.leaseExpiresAt = new Date(now + leaseMs).toISOString();
  return item;
}

export type ReclaimResult = {
  reclaimed: QueuedTask[];
};

/**
 * Release claimed items whose lease expired — counts as a soft failure (retry / dead).
 */
export function reclaimExpiredLeases(
  state: ClusterState,
  opts: { now?: number; maxAttempts?: number } = {},
): ReclaimResult {
  ensureQueue(state);
  const now = opts.now ?? Date.now();
  const expiredIds: string[] = [];
  for (const item of state.queue) {
    if (item.status !== "claimed") continue;
    const exp = item.leaseExpiresAt ? Date.parse(item.leaseExpiresAt) : NaN;
    // Legacy claims without lease: treat claimedAt + default lease as expiry.
    const fallback = item.claimedAt ? Date.parse(item.claimedAt) + DEFAULT_LEASE_MS : NaN;
    const deadline = Number.isFinite(exp) ? exp : fallback;
    if (!Number.isFinite(deadline) || deadline > now) continue;
    expiredIds.push(item.id);
  }
  const reclaimed: QueuedTask[] = [];
  for (const id of expiredIds) {
    const updated = completeQueued(state, id, false, "lease expired", {
      now,
      maxAttempts: opts.maxAttempts,
    });
    if (updated) {
      state.metrics.leasesReclaimed = (state.metrics.leasesReclaimed ?? 0) + 1;
      reclaimed.push(updated);
    }
  }
  return { reclaimed };
}

/** Re-queue a dead-letter item for another attempt cycle. */
export function requeueDead(
  state: ClusterState,
  queueId: string,
  opts: { now?: number; resetAttempts?: boolean } = {},
): QueuedTask | undefined {
  ensureQueue(state);
  const item = state.queue.find((q) => q.id === queueId && q.status === "dead");
  if (!item) return undefined;
  item.status = "pending";
  item.workerId = undefined;
  item.claimedAt = undefined;
  item.leaseExpiresAt = undefined;
  item.heartbeatAt = undefined;
  item.finishedAt = undefined;
  item.nextRetryAt = undefined;
  item.error = undefined;
  if (opts.resetAttempts !== false) item.attempts = 0;
  return item;
}

export function deadLetters(state: ClusterState): QueuedTask[] {
  ensureQueue(state);
  return state.queue.filter((q) => q.status === "dead");
}

export function queueSummary(state: ClusterState): {
  pending: number;
  claimed: number;
  done: number;
  failed: number;
  dead: number;
  waitingRetry: number;
  leaseExpired: number;
} {
  ensureQueue(state);
  const now = Date.now();
  const counts = {
    pending: 0,
    claimed: 0,
    done: 0,
    failed: 0,
    dead: 0,
    waitingRetry: 0,
    leaseExpired: 0,
  };
  for (const q of state.queue) {
    if (q.status === "dead") counts.dead += 1;
    else if (q.status === "pending" || q.status === "claimed" || q.status === "done" || q.status === "failed") {
      counts[q.status] += 1;
    }
    if (q.status === "pending" && q.nextRetryAt && Date.parse(q.nextRetryAt) > now) {
      counts.waitingRetry += 1;
    }
    if (q.status === "claimed" && q.leaseExpiresAt && Date.parse(q.leaseExpiresAt) <= now) {
      counts.leaseExpired += 1;
    }
  }
  return counts;
}
