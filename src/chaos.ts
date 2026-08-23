/**
 * Chaos / stress helpers — rapid reconcile scale and digest rolls.
 * Proves the control plane stays consistent under churn (network-free).
 */

import { buildAgentImage } from "./image.js";
import { planReconcile, emptyState } from "./controller.js";
import { detectDrift } from "./drift.js";
import { parseManifests } from "./spec.js";
import type { ClusterState, ReconcilePlan } from "./types.js";

export type ChaosStep = {
  name: string;
  replicas: number;
  skill: string;
  plan: ReconcilePlan;
  live: number;
  retired: number;
  canaryHeld?: number;
};

function agentYaml(replicas: number, skill: string, extras = ""): string {
  return `apiVersion: ropex.dev/v1
kind: Policy
metadata:
  name: chaos-cap
spec:
  maxReplicas: 100
  permissions:
    deny: [exfiltrate]
    requireApproval: []
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: chaos
  labels:
    role: chaos
    zone: test
spec:
  scale: static
  replicas: ${replicas}
  placement:
    require:
      role: chaos
    prefer:
      zone: test
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: [${skill}]
${extras}`;
}

/**
 * Run a scripted churn: scale up, change skills (digest roll), scale down,
 * optional canary roll, scale up again.
 */
export function runReconcileChaos(
  root: string,
  opts: { maxReplicas?: number; canary?: boolean } = {},
): { steps: ChaosStep[]; final: ClusterState } {
  const max = opts.maxReplicas ?? 8;
  let state = emptyState("chaos");
  const steps: ChaosStep[] = [];

  const script: Array<{
    name: string;
    replicas: number;
    skill: string;
    canary?: boolean;
  }> = [
    { name: "boot-2", replicas: 2, skill: "s1" },
    { name: "scale-up", replicas: max, skill: "s1" },
    { name: "digest-roll", replicas: max, skill: "s1, s2", canary: opts.canary },
    { name: "scale-down", replicas: 1, skill: "s1, s2" },
    { name: "scale-up-again", replicas: Math.ceil(max / 2), skill: "s1, s2" },
    { name: "digest-roll-2", replicas: Math.ceil(max / 2), skill: "s3", canary: opts.canary },
    { name: "placement-stable", replicas: Math.ceil(max / 2), skill: "s3" },
  ];

  for (const s of script) {
    const { next, plan, canaryHeld } = planReconcile(
      state,
      parseManifests(agentYaml(s.replicas, s.skill)),
      "chaos/",
      {
        root,
        rollout: s.canary ? { strategy: "canary", canaryCount: 1 } : undefined,
      },
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
      canaryHeld,
    });
  }

  return { steps, final: state };
}

export type ChaosInvariantOptions = {
  /** When true, allow digest mismatches (canary holdouts). Default false. */
  allowDigestMismatch?: boolean;
};

/** Invariants that must hold after chaos. */
export function assertChaosInvariants(
  state: ClusterState,
  opts: ChaosInvariantOptions = {},
): string[] {
  const errors: string[] = [];
  const live = state.workers.filter((w) => w.status !== "retired");
  const ids = new Set<string>();
  for (const w of live) {
    if (ids.has(w.id)) errors.push(`duplicate live worker id ${w.id}`);
    ids.add(w.id);
    if (!w.imageDigest) errors.push(`missing digest on ${w.id}`);
    if (w.status === "retired") errors.push(`retired status in live set ${w.id}`);
  }
  const bySlot = new Map<string, number>();
  for (const w of live) {
    bySlot.set(w.id, (bySlot.get(w.id) ?? 0) + 1);
  }
  for (const [id, n] of bySlot) {
    if (n > 1) errors.push(`slot ${id} has ${n} live workers`);
  }

  // Desired capacity vs live count (static pools only; on-demand live ≤ maxConcurrent)
  let desiredSlots = 0;
  for (const a of state.desired) {
    if (a.spec.scale === "onDemand") {
      // On-demand: live workers may be 0..maxConcurrent; do not require equality.
      continue;
    }
    desiredSlots += a.derivedFrom ? 1 : a.spec.replicas;
  }
  const staticLive = live.filter((w) => {
    const a = state.desired.find((d) => d.metadata.name === w.agent);
    return a?.spec.scale !== "onDemand";
  });
  if (staticLive.length !== desiredSlots) {
    errors.push(`live=${staticLive.length} desiredSlots=${desiredSlots}`);
  }
  for (const a of state.desired) {
    if (a.spec.scale !== "onDemand") continue;
    const n = live.filter((w) => w.agent === a.metadata.name).length;
    const cap = a.spec.maxConcurrent ?? a.spec.replicas ?? 1;
    if (n > cap) errors.push(`onDemand ${a.metadata.name} live=${n} > maxConcurrent=${cap}`);
  }

  // Digest + label alignment (unless canary holdouts allowed)
  for (const w of live) {
    const agent = state.desired.find((a) => a.metadata.name === w.agent);
    if (!agent) {
      errors.push(`live worker ${w.id} has no desired agent`);
      continue;
    }
    const want = buildAgentImage(agent).digest;
    if (!opts.allowDigestMismatch && w.imageDigest !== want) {
      errors.push(`digest mismatch ${w.id}: ${w.imageDigest.slice(0, 8)}≠${want.slice(0, 8)}`);
    }
    if (agent.metadata.labels) {
      for (const [k, v] of Object.entries(agent.metadata.labels)) {
        if (w.labels?.[k] !== v && w.imageDigest === want) {
          errors.push(`label ${k} missing/wrong on ${w.id}`);
        }
      }
    }
    if (agent.spec.placement?.require && w.imageDigest === want) {
      for (const [k, v] of Object.entries(agent.spec.placement.require)) {
        if (w.labels?.[k] !== v) {
          errors.push(`placement require ${k}=${v} unmet on ${w.id}`);
        }
      }
    }
  }

  // Drift report must agree on replica/missing/extra when digests aligned
  if (!opts.allowDigestMismatch) {
    const drift = detectDrift(state);
    if (drift.summary.missing || drift.summary.extra || drift.summary.replica) {
      errors.push(
        `drift structural missing=${drift.summary.missing} extra=${drift.summary.extra} replica=${drift.summary.replica}`,
      );
    }
  }

  return errors;
}
