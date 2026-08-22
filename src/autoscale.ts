/**
 * Worker-pool autoscaler stub — GitOps scale recommendations from backlog SLO.
 * Never mutates desired replicas in place; emits YAML to commit (source of truth is git).
 */

import { evaluateBacklogSlo } from "./health.js";
import { recordAudit } from "./audit.js";
import { maxReplicas } from "./spec.js";
import type { ClusterState, DesiredAgent } from "./types.js";

export type ScaleRecommendation = {
  /** Fleet name when derived; otherwise standalone agent. */
  kind: "Fleet" | "Agent";
  name: string;
  currentReplicas: number;
  recommendedReplicas: number;
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
  /** Pending tasks per idle worker before scale-up (default 2). */
  pendingPerIdle?: number;
  /** Scale up by at most this many replicas per tick (default 4). */
  maxScaleUp?: number;
  /** Scale down when idle workers exceed pending by this margin (default 2). */
  idleSurplus?: number;
  /** Minimum replicas to keep even when idle (default 1). */
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

function currentReplicasFor(state: ClusterState, key: { kind: string; name: string }): number {
  if (key.kind === "Fleet") {
    return state.workers.filter((w) => w.fleet === key.name && w.status !== "retired").length;
  }
  return liveWorkers(state, key.name).length;
}

function agentsInGroup(state: ClusterState, key: { kind: string; name: string }): string[] {
  if (key.kind === "Fleet") {
    return [
      ...new Set(
        state.desired.filter((a) => a.derivedFrom?.fleet === key.name).map((a) => a.metadata.name),
      ),
    ];
  }
  return [key.name];
}

function fleetOrAgentYaml(kind: "Fleet" | "Agent", name: string, replicas: number): string {
  return [
    "apiVersion: ropex.dev/v1",
    `kind: ${kind}`,
    "metadata:",
    `  name: ${name}`,
    "spec:",
    `  replicas: ${replicas}`,
    "# commit this to git — Ropex derives workers from the repo",
    "",
  ].join("\n");
}

/**
 * Compute HPA-style scale recommendations from queue depth + worker idle/running.
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

  // Group desired agents by fleet (or standalone agent name).
  const groups = new Map<string, { kind: "Fleet" | "Agent"; name: string }>();
  for (const a of state.desired ?? []) {
    const key = groupKey(a);
    groups.set(`${key.kind}:${key.name}`, key);
  }

  const recommendations: ScaleRecommendation[] = [];

  for (const key of groups.values()) {
    const agentNames = agentsInGroup(state, key);
    let pending = 0;
    let idle = 0;
    let running = 0;
    for (const name of agentNames) {
      pending += pendingFor(state, name);
      const live = liveWorkers(state, name);
      idle += live.filter((w) => w.status === "idle" || w.status === "pending").length;
      running += live.filter((w) => w.status === "running").length;
    }
    const current = currentReplicasFor(state, key);
    if (current === 0 && pending === 0) continue;

    let recommended = current;
    let reason = "steady";

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
      delta: recommended - current,
      reason,
      cappedByPolicy,
      pending,
      idle,
      running,
    });
  }

  const yaml = recommendations.map((r) => fleetOrAgentYaml(r.kind, r.name, r.recommendedReplicas)).join("---\n");

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
