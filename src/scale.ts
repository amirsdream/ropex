/**
 * On-demand agent orchestration — spawn under concurrency caps, destroy by default.
 * Git desired state holds agent/fleet *definitions*; workers are ephemeral executors.
 * Learning lives on the memory bus + skill registry, not on warm replica inventory.
 */

import { recordAudit } from "./audit.js";
import { type ImageResolveOptions } from "./image.js";
import { promoteMemoryFact } from "./memory.js";
import { workerFromDesired } from "./runtime.js";
import { removeWorktree } from "./worktree.js";
import type { ClusterState, DesiredAgent, ScaleMode, Worker } from "./types.js";

export const DEFAULT_IDLE_TTL_MS = 0;

/** Resolve scale mode. Legacy YAML with `replicas` (no maxConcurrent) stays static. */
export function resolveScaleMode(spec: {
  scale?: ScaleMode;
  replicas?: number;
  maxConcurrent?: number;
}): ScaleMode {
  if (spec.scale === "onDemand" || spec.scale === "static") return spec.scale;
  if (spec.maxConcurrent != null) return "onDemand";
  if (spec.replicas != null && spec.replicas > 0) return "static";
  return "onDemand";
}

/** Concurrent run cap for an agent definition (policy applied separately). */
export function resolveMaxConcurrent(spec: {
  scale?: ScaleMode;
  replicas?: number;
  maxConcurrent?: number;
}): number {
  const mode = resolveScaleMode(spec);
  if (mode === "static") {
    return Math.max(1, Math.floor(spec.replicas ?? 1));
  }
  const n = spec.maxConcurrent ?? spec.replicas ?? 1;
  return Math.max(1, Math.floor(n));
}

export function resolveIdleTTLMs(spec: { idleTTLMs?: number; scale?: ScaleMode }): number {
  if (spec.idleTTLMs != null && Number.isFinite(spec.idleTTLMs)) {
    return Math.max(0, Math.floor(spec.idleTTLMs));
  }
  return resolveScaleMode(spec) === "onDemand" ? DEFAULT_IDLE_TTL_MS : Number.POSITIVE_INFINITY;
}

export function isOnDemandAgent(agent: DesiredAgent | undefined): boolean {
  if (!agent) return false;
  return resolveScaleMode(agent.spec) === "onDemand";
}

/** Live (non-retired) workers for an agent name. */
export function liveWorkersFor(state: ClusterState, agentName: string): Worker[] {
  return state.workers.filter((w) => w.agent === agentName && w.status !== "retired");
}

export function runningWorkersFor(state: ClusterState, agentName: string): Worker[] {
  return liveWorkersFor(state, agentName).filter((w) => w.status === "running");
}

/** Cluster-wide live workers (policy maxReplicas ceiling). */
export function liveWorkerCount(state: ClusterState): number {
  return state.workers.filter((w) => w.status !== "retired").length;
}

/**
 * Next free replica index for ephemeral spawn (reuses gaps from retired slots).
 */
export function nextReplicaIndex(state: ClusterState, agentName: string): number {
  const used = new Set(
    state.workers.filter((w) => w.agent === agentName && w.status !== "retired").map((w) => w.replica),
  );
  let i = 0;
  while (used.has(i)) i += 1;
  return i;
}

export type SpawnGate = {
  ok: boolean;
  reason?: string;
  running: number;
  live: number;
  maxConcurrent: number;
  policyCap: number;
};

export function canSpawnWorker(
  state: ClusterState,
  agentName: string,
  policyCap: number,
): SpawnGate {
  const agent = state.desired.find((a) => a.metadata.name === agentName);
  if (!agent) {
    return {
      ok: false,
      reason: `desired agent missing: ${agentName}`,
      running: 0,
      live: 0,
      maxConcurrent: 0,
      policyCap,
    };
  }
  const maxConcurrent = resolveMaxConcurrent(agent.spec);
  const live = liveWorkersFor(state, agentName);
  const running = live.filter((w) => w.status === "running").length;
  const active = live.filter((w) => w.status === "running" || w.status === "idle" || w.status === "pending")
    .length;
  if (active >= maxConcurrent) {
    return {
      ok: false,
      reason: `agent ${agentName} at maxConcurrent=${maxConcurrent}`,
      running,
      live: live.length,
      maxConcurrent,
      policyCap,
    };
  }
  const clusterLive = liveWorkerCount(state);
  if (Number.isFinite(policyCap) && clusterLive >= policyCap) {
    return {
      ok: false,
      reason: `policy maxReplicas=${policyCap} reached`,
      running,
      live: live.length,
      maxConcurrent,
      policyCap,
    };
  }
  return { ok: true, running, live: live.length, maxConcurrent, policyCap };
}

export type SpawnOptions = ImageResolveOptions & {
  /** Mark worker running immediately (claim path). Default pending. */
  status?: Worker["status"];
};

/**
 * Create an ephemeral worker for an on-demand agent. Caller must already pass canSpawn.
 */
export function spawnWorker(
  state: ClusterState,
  agentName: string,
  opts: SpawnOptions = {},
): Worker | undefined {
  const agent = state.desired.find((a) => a.metadata.name === agentName);
  if (!agent) return undefined;
  const replica = nextReplicaIndex(state, agentName);
  const worker = workerFromDesired(agent, replica, opts);
  worker.status = opts.status ?? "pending";
  // Seed skills from image only; registry skills are loaded at runTask time.
  state.workers.push(worker);
  recordAudit(state, {
    kind: "info",
    message: `spawned ${worker.id} (onDemand)`,
    agent: agentName,
    workerId: worker.id,
    meta: {
      scale: "onDemand",
      maxConcurrent: resolveMaxConcurrent(agent.spec),
      imageDigest: worker.imageDigest,
    },
  });
  return worker;
}

/**
 * Promote worker-scoped facts to agent scope so learning survives destroy.
 * Returns number of facts promoted.
 */
export function promoteWorkerMemory(state: ClusterState, workerId: string): number {
  const worker = state.workers.find((w) => w.id === workerId);
  if (!worker) return 0;
  let n = 0;
  for (const fact of [...state.memory]) {
    if (fact.scope !== "worker") continue;
    if (fact.worker !== workerId && fact.sourceWorker !== workerId) continue;
    const next = promoteMemoryFact(state, fact.id, "agent");
    if (next) n += 1;
  }
  return n;
}

export type DestroyOptions = {
  root?: string;
  now?: number;
  reason?: string;
};

/**
 * Retire a worker, promote worker-local memory, tear down worktree.
 */
export function destroyWorker(
  state: ClusterState,
  workerId: string,
  opts: DestroyOptions = {},
): Worker | undefined {
  const w = state.workers.find((x) => x.id === workerId && x.status !== "retired");
  if (!w) return undefined;
  if (w.status === "running") {
    w.cordoned = true;
    recordAudit(state, {
      kind: "info",
      message: `destroy deferred (running) → cordoned ${workerId}`,
      agent: w.agent,
      workerId,
    });
    return w;
  }
  const promoted = promoteWorkerMemory(state, workerId);
  w.status = "retired";
  w.cordoned = false;
  if (opts.root) {
    removeWorktree(opts.root, workerId);
    w.worktree = undefined;
  }
  recordAudit(state, {
    kind: "info",
    message: `destroyed ${workerId}${promoted ? ` (promoted ${promoted} memory)` : ""}`,
    agent: w.agent,
    workerId,
    meta: { reason: opts.reason ?? "idle", promoted },
  });
  return w;
}

/**
 * After a task finishes: keep warm until idleTTL, else destroy (onDemand).
 * Static agents stay idle.
 */
export function releaseOrDestroyWorker(
  state: ClusterState,
  workerId: string | undefined,
  opts: DestroyOptions = {},
): "idle" | "destroyed" | "skipped" {
  if (!workerId) return "skipped";
  const w = state.workers.find((x) => x.id === workerId && x.status !== "retired");
  if (!w) return "skipped";
  const agent = state.desired.find((a) => a.metadata.name === w.agent);
  const now = opts.now ?? Date.now();
  w.lastTaskAt = new Date(now).toISOString();

  if (!agent || resolveScaleMode(agent.spec) !== "onDemand") {
    if (w.status === "running" || w.status === "failed") w.status = "idle";
    return "idle";
  }

  const ttl = resolveIdleTTLMs(agent.spec);
  if (ttl > 0) {
    w.status = "idle";
    w.cordoned = false;
    return "idle";
  }
  // idleTTL 0 → destroy immediately
  if (w.status === "running" || w.status === "failed" || w.status === "idle" || w.status === "pending") {
    w.status = "idle"; // destroyWorker refuses running
  }
  destroyWorker(state, workerId, { ...opts, reason: opts.reason ?? "task-complete" });
  return "destroyed";
}

/**
 * Sweep on-demand idle workers past idleTTL. Returns destroyed ids.
 */
export function sweepIdleWorkers(
  state: ClusterState,
  opts: DestroyOptions = {},
): string[] {
  const now = opts.now ?? Date.now();
  const destroyed: string[] = [];
  for (const w of [...state.workers]) {
    if (w.status !== "idle" || w.cordoned) continue;
    const agent = state.desired.find((a) => a.metadata.name === w.agent);
    if (!agent || resolveScaleMode(agent.spec) !== "onDemand") continue;
    const ttl = resolveIdleTTLMs(agent.spec);
    if (!Number.isFinite(ttl) || ttl <= 0) {
      // ttl 0 should already have destroyed; clean up any leftover idle
      destroyWorker(state, w.id, { ...opts, now, reason: "idleTTL-0" });
      destroyed.push(w.id);
      continue;
    }
    const last = w.lastTaskAt ? Date.parse(w.lastTaskAt) : NaN;
    if (!Number.isFinite(last)) continue;
    if (now - last < ttl) continue;
    destroyWorker(state, w.id, { ...opts, now, reason: "idleTTL" });
    destroyed.push(w.id);
  }
  return destroyed;
}

/** Desired standing workers for reconcile (static only). On-demand → []. */
export function expandStandingWorkers(
  agent: DesiredAgent,
  opts: ImageResolveOptions = {},
): Worker[] {
  if (resolveScaleMode(agent.spec) === "onDemand") return [];
  const n = agent.derivedFrom ? 1 : Math.max(0, agent.spec.replicas);
  return Array.from({ length: n }, (_, i) => {
    const w = workerFromDesired(agent, i, opts);
    w.status = "idle";
    return w;
  });
}
