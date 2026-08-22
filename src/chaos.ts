/**
 * Chaos / stress helpers — rapid reconcile scale and digest rolls.
 * Proves the control plane stays consistent under churn (network-free).
 */

import { planReconcile, emptyState } from "./controller.js";
import { parseManifests } from "./spec.js";
import type { ClusterState, ReconcilePlan } from "./types.js";

export type ChaosStep = {
  name: string;
  replicas: number;
  skill: string;
  plan: ReconcilePlan;
  live: number;
  retired: number;
};

function agentYaml(replicas: number, skill: string): string {
  return `apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: chaos
spec:
  replicas: ${replicas}
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: [${skill}]
`;
}

/**
 * Run a scripted churn: scale up, change skills (digest roll), scale down, scale up again.
 */
export function runReconcileChaos(
  root: string,
  opts: { maxReplicas?: number } = {},
): { steps: ChaosStep[]; final: ClusterState } {
  const max = opts.maxReplicas ?? 8;
  let state = emptyState("chaos");
  const steps: ChaosStep[] = [];

  const script: Array<{ name: string; replicas: number; skill: string }> = [
    { name: "boot-2", replicas: 2, skill: "s1" },
    { name: "scale-up", replicas: max, skill: "s1" },
    { name: "digest-roll", replicas: max, skill: "s1, s2" },
    { name: "scale-down", replicas: 1, skill: "s1, s2" },
    { name: "scale-up-again", replicas: Math.ceil(max / 2), skill: "s1, s2" },
    { name: "digest-roll-2", replicas: Math.ceil(max / 2), skill: "s3" },
  ];

  for (const s of script) {
    const { next, plan } = planReconcile(
      state,
      parseManifests(agentYaml(s.replicas, s.skill)),
      "chaos/",
      { root },
    );
    state = next;
    const live = state.workers.filter((w) => w.status !== "retired").length;
    const retired = state.workers.filter((w) => w.status === "retired").length;
    steps.push({
      name: s.name,
      replicas: s.replicas,
      skill: s.skill,
      plan,
      live,
      retired,
    });
  }

  return { steps, final: state };
}

/** Invariants that must hold after chaos. */
export function assertChaosInvariants(state: ClusterState): string[] {
  const errors: string[] = [];
  const live = state.workers.filter((w) => w.status !== "retired");
  const ids = new Set<string>();
  for (const w of live) {
    if (ids.has(w.id)) errors.push(`duplicate live worker id ${w.id}`);
    ids.add(w.id);
    if (!w.imageDigest) errors.push(`missing digest on ${w.id}`);
  }
  // At most one live worker per slot id
  const bySlot = new Map<string, number>();
  for (const w of live) {
    bySlot.set(w.id, (bySlot.get(w.id) ?? 0) + 1);
  }
  for (const [id, n] of bySlot) {
    if (n > 1) errors.push(`slot ${id} has ${n} live workers`);
  }
  return errors;
}
