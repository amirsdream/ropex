/**
 * Autoscale recommendations — GitOps patches for concurrency caps (onDemand)
 * or standing replicas (static). Never mutates desired state in place.
 */

import { evaluateBacklogSlo } from "./health.js";
import { recordAudit } from "./audit.js";
import { resolveMaxConcurrent, resolveScaleMode } from "./scale.js";
import { maxReplicas } from "./spec.js";
import type { ClusterState, DesiredAgent } from "./types.js";

export type ScaleRecommendation = {
  /** Fleet name when derived; otherwise standalone agent. */
  kind: "Fleet" | "Agent";
  name: string;
  currentReplicas: number;
  recommendedReplicas: number;
  /** Alias for concurrency-oriented UIs. */
  currentConcurrent: number;
  recommendedConcurrent: number;
  scale: "onDemand" | "static";
  delta: number;
  reason: string;
  cappedByPolicy: boolean;
  pending: number;
  idle: number;
  running: number;
};

export type AutoscalePlan = {
  recommendations: ScaleRecommendation[];
  /** Combined YAML patches ready to commit. */
  yaml: string;
  backlogBreached: boolean;
  policyCap: number;
  at: string;
};

export type AutoscaleOptions = {
  /** Pending tasks per idle/available slot before scale-up (default 2). */
  pendingPerIdle?: number;
  /** Scale up by at most this many per tick (default 4). */
  maxScaleUp?: number;
  /** Scale down when idle surplus exceeds this (default 2) — static only. */
  idleSurplus?: number;
  /** Minimum concurrent/replicas to keep (default 1). */
  minReplicas?: number;
  now?: number;
  /** Record an audit event when recommendations are non-empty. */
  audit?: boolean;
};

function liveWorkers(state: ClusterState, agent: string) {
  return state.workers.filter((w) => w.agent === agent && w.status !== "retired");
}

function pendingFor(state: ClusterState, agent: string): number {
  return (state.queue ?? []).filter(
    (q) => q.task.agent === agent && (q.status === "pending" || q.status === "claimed"),
  ).length;
}

function groupKey(agent: DesiredAgent): { kind: "Fleet" | "Agent"; name: string } {
  if (agent.derivedFrom?.fleet) {
    return { kind: "Fleet", name: agent.derivedFrom.fleet };
  }
  return { kind: "Agent", name: agent.metadata.name };
}

function currentCapacity(state: ClusterState, key: { kind: string; name: string }): number {
  const agents =
    key.kind === "Fleet"
      ? state.desired.filter((a) => a.derivedFrom?.fleet === key.name)
      : state.desired.filter((a) => a.metadata.name === key.name);
  if (!agents.length) return 0;
  const mode = resolveScaleMode(agents[0].spec);
  if (mode === "onDemand") {
    return agents.reduce((n, a) => n + resolveMaxConcurrent(a.spec), 0);
  }
  if (key.kind === "Fleet") {
    return state.workers.filter((w) => w.fleet === key.name && w.status !== "retired").length;
  }
  return liveWorkers(state, key.name).length;
}

function agentsInGroup(state: ClusterState, key: { kind: string; name: string }): DesiredAgent[] {
  if (key.kind === "Fleet") {
    return state.desired.filter((a) => a.derivedFrom?.fleet === key.name);
  }
  return state.desired.filter((a) => a.metadata.name === key.name);
}

function capacityYaml(
  kind: "Fleet" | "Agent",
  name: string,
  n: number,
  scale: "onDemand" | "static",
): string {
  if (scale === "onDemand") {
    return [
      "apiVersion: ropex.dev/v1",
      `kind: ${kind}`,
      "metadata:",
      `  name: ${name}`,
      "spec:",
      "  scale: onDemand",
      `  maxConcurrent: ${n}`,
      "# commit this to git — Ropex admits spawns under this cap",
      "",
    ].join("\n");
  }
  return [
    "apiVersion: ropex.dev/v1",
    `kind: ${kind}`,
    "metadata:",
    `  name: ${name}`,
    "spec:",
    "  scale: static",
    `  replicas: ${n}`,
    "# commit this to git — Ropex derives standing workers from the repo",
    "",
  ].join("\n");
}

/**
 * Compute scale recommendations from queue depth + worker idle/running.
 * Honors Policy.maxReplicas. Does not write cluster state (GitOps).
 */
export function planAutoscale(state: ClusterState, opts: AutoscaleOptions = {}): AutoscalePlan {
  const pendingPerIdle = opts.pendingPerIdle ?? 2;
  const maxScaleUp = opts.maxScaleUp ?? 4;
  const idleSurplus = opts.idleSurplus ?? 2;
  const minReplicas = opts.minReplicas ?? 1;
  const now = opts.now ?? Date.now();
  const policyCap = maxReplicas(state.policies ?? []);
  const finiteCap = Number.isFinite(policyCap) ? policyCap : 1_000;
  const backlog = evaluateBacklogSlo(state, { now });

  const groups = new Map<string, { kind: "Fleet" | "Agent"; name: string }>();
  for (const a of state.desired ?? []) {
    const key = groupKey(a);
    groups.set(`${key.kind}:${key.name}`, key);
  }

  const recommendations: ScaleRecommendation[] = [];

  for (const key of groups.values()) {
    const groupAgents = agentsInGroup(state, key);
    if (!groupAgents.length) continue;
    const scale = resolveScaleMode(groupAgents[0].spec);
    let pending = 0;
    let idle = 0;
    let running = 0;
    for (const a of groupAgents) {
      pending += pendingFor(state, a.metadata.name);
      const live = liveWorkers(state, a.metadata.name);
      idle += live.filter((w) => w.status === "idle" || w.status === "pending").length;
      running += live.filter((w) => w.status === "running").length;
    }
    const current = currentCapacity(state, key);
    if (current === 0 && pending === 0) continue;

    let recommended = current;
    let reason = "steady";

    if (scale === "onDemand") {
      // Cap should cover pending + running with headroom; idle warm pool is not the signal.
      const need = Math.max(running + pending, minReplicas);
      if (need > current && (pending > 0 || backlog.breached)) {
        const bump = Math.min(maxScaleUp, need - current);
        recommended = current + Math.max(1, bump);
        reason = backlog.breached
          ? `backlog SLO breached; raise maxConcurrent +${bump}`
          : `pending=${pending} running=${running}; raise maxConcurrent +${bump}`;
      } else if (pending === 0 && running === 0 && current > minReplicas) {
        const down = Math.min(maxScaleUp, current - minReplicas);
        if (down > 0) {
          recommended = current - down;
          reason = `quiet queue; lower maxConcurrent -${down}`;
        }
      }
    } else {
      const load = idle === 0 ? pending : pending / Math.max(idle, 1);
      if (pending > 0 && (idle === 0 || load >= pendingPerIdle || backlog.breached)) {
        const need = idle === 0 ? Math.min(pending, maxScaleUp) : Math.ceil(pending / pendingPerIdle) - idle;
        const bump = Math.max(1, Math.min(maxScaleUp, need));
        recommended = current + bump;
        reason = backlog.breached
          ? `backlog SLO breached; scale up +${bump}`
          : idle === 0
            ? `no idle workers with ${pending} pending; scale up +${bump}`
            : `pending/idle=${load.toFixed(1)} ≥ ${pendingPerIdle}; scale up +${bump}`;
      } else if (pending === 0 && idle > idleSurplus && current > minReplicas) {
        const down = Math.min(idle - idleSurplus, current - minReplicas, maxScaleUp);
        if (down > 0) {
          recommended = current - down;
          reason = `idle surplus ${idle} with empty queue; scale down -${down}`;
        }
      }
    }

    let cappedByPolicy = false;
    if (recommended > finiteCap) {
      recommended = finiteCap;
      cappedByPolicy = true;
      reason = `${reason} (capped by Policy.maxReplicas=${finiteCap})`;
    }
    recommended = Math.max(minReplicas, recommended);

    if (recommended === current) continue;

    recommendations.push({
      kind: key.kind,
      name: key.name,
      currentReplicas: current,
      recommendedReplicas: recommended,
      currentConcurrent: current,
      recommendedConcurrent: recommended,
      scale,
      delta: recommended - current,
      reason,
      cappedByPolicy,
      pending,
      idle,
      running,
    });
  }

  const yaml = recommendations
    .map((r) => capacityYaml(r.kind, r.name, r.recommendedReplicas, r.scale))
    .join("---\n");

  if (opts.audit && recommendations.length) {
    recordAudit(state, {
      kind: "info",
      message: `autoscale ${recommendations.length} recommendation(s)`,
      meta: {
        up: recommendations.filter((r) => r.delta > 0).length,
        down: recommendations.filter((r) => r.delta < 0).length,
        backlogBreached: backlog.breached,
      },
    });
  }

  return {
    recommendations,
    yaml,
    backlogBreached: backlog.breached,
    policyCap: finiteCap,
    at: new Date(now).toISOString(),
  };
}
