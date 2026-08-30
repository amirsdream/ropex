/**
 * Config drift detector — compare live workers to desired digests / static slots /
 * on-demand concurrency caps. Complements `ropex diff` (plan) with a readable report.
 */

import { buildAgentImage, type ImageResolveOptions } from "./image.js";
import { expandWorkers } from "./runtime.js";
import { resolveMaxConcurrent } from "./scale.js";
import {
  applyReplicaCap,
  collectPolicies,
  expandDesired,
  maxReplicas,
  parseManifests,
} from "./spec.js";
import type { ClusterState, DesiredAgent, Manifest, Worker } from "./types.js";

export type DriftKind =
  | "missing"
  | "extra"
  | "digest"
  | "replica"
  | "label"
  | "taint"
  | "cordoned";

export type DriftFinding = {
  kind: DriftKind;
  agent?: string;
  workerId?: string;
  detail: string;
};

export type DriftReport = {
  ok: boolean;
  at: string;
  source: string;
  findings: DriftFinding[];
  summary: Record<DriftKind, number>;
  liveWorkers: number;
  desiredWorkers: number;
};

function emptySummary(): Record<DriftKind, number> {
  return {
    missing: 0,
    extra: 0,
    digest: 0,
    replica: 0,
    label: 0,
    taint: 0,
    cordoned: 0,
  };
}

function labelsEqual(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  const aa = a ?? {};
  const bb = b ?? {};
  const keys = new Set([...Object.keys(aa), ...Object.keys(bb)]);
  for (const k of keys) {
    if (aa[k] !== bb[k]) return false;
  }
  return true;
}

function taintsEqual(
  a: Worker["taints"] | undefined,
  b: Worker["taints"] | undefined,
): boolean {
  const aa = [...(a ?? [])].map((t) => `${t.key}:${t.effect}`).sort();
  const bb = [...(b ?? [])].map((t) => `${t.key}:${t.effect}`).sort();
  if (aa.length !== bb.length) return false;
  return aa.every((v, i) => v === bb[i]);
}

function desiredFromState(state: ClusterState, opts: ImageResolveOptions = {}): Worker[] {
  return state.desired.flatMap((a) => expandWorkers(a, opts));
}

function desiredFromManifests(
  manifests: Manifest[],
  opts: ImageResolveOptions = {},
): { workers: Worker[]; sourceNote: string } {
  const policies = collectPolicies(manifests);
  const expanded = expandDesired(manifests);
  const cap = maxReplicas(policies);
  const { agents } = applyReplicaCap(expanded, cap);
  return {
    workers: agents.flatMap((a) => expandWorkers(a, opts)),
    sourceNote: "manifests",
  };
}

/**
 * Detect drift between live cluster workers and desired (state.desired or manifests).
 * Does not mutate state.
 */
export function detectDrift(
  state: ClusterState,
  opts: {
    manifests?: Manifest[];
    manifestText?: string;
    root?: string;
  } = {},
): DriftReport {
  const imageOpts: ImageResolveOptions = { root: opts.root };
  let desiredWorkers: Worker[];
  let source = state.source || "(state.desired)";
  if (opts.manifests) {
    const d = desiredFromManifests(opts.manifests, imageOpts);
    desiredWorkers = d.workers;
    source = "manifests";
  } else if (opts.manifestText) {
    const d = desiredFromManifests(parseManifests(opts.manifestText), imageOpts);
    desiredWorkers = d.workers;
    source = "manifestText";
  } else {
    desiredWorkers = desiredFromState(state, imageOpts);
  }

  const findings: DriftFinding[] = [];
  const live = state.workers.filter((w) => w.status !== "retired");
  const desiredById = new Map(desiredWorkers.map((w) => [w.id, w]));
  const liveById = new Map(live.map((w) => [w.id, w]));

  for (const want of desiredWorkers) {
    const have = liveById.get(want.id);
    if (!have) {
      findings.push({
        kind: "missing",
        agent: want.agent,
        workerId: want.id,
        detail: `desired worker ${want.id} not live`,
      });
      continue;
    }
    if (have.imageDigest !== want.imageDigest) {
      findings.push({
        kind: "digest",
        agent: want.agent,
        workerId: want.id,
        detail: `digest ${have.imageDigest.slice(0, 8)}… ≠ desired ${want.imageDigest.slice(0, 8)}…`,
      });
    }
    if (!labelsEqual(have.labels, want.labels)) {
      findings.push({
        kind: "label",
        agent: want.agent,
        workerId: want.id,
        detail: `labels drifted on ${want.id}`,
      });
    }
    if (!taintsEqual(have.taints, want.taints)) {
      findings.push({
        kind: "taint",
        agent: want.agent,
        workerId: want.id,
        detail: `taints drifted on ${want.id}`,
      });
    }
  }

  for (const have of live) {
    const agent = state.desired.find((a) => a.metadata.name === have.agent);
    if (agent?.spec.scale === "onDemand") {
      // Ephemeral runners are expected; only flag digest drift vs definition.
      const wantDigest = buildAgentImage(agent, imageOpts).digest;
      if (have.imageDigest !== wantDigest) {
        findings.push({
          kind: "digest",
          agent: have.agent,
          workerId: have.id,
          detail: `onDemand ${have.id} digest ${have.imageDigest.slice(0, 8)}… ≠ desired ${wantDigest.slice(0, 8)}…`,
        });
      }
      if (have.cordoned) {
        findings.push({
          kind: "cordoned",
          agent: have.agent,
          workerId: have.id,
          detail: `${have.id} is cordoned`,
        });
      }
      continue;
    }
    if (!desiredById.has(have.id)) {
      findings.push({
        kind: "extra",
        agent: have.agent,
        workerId: have.id,
        detail: `live worker ${have.id} not in desired set`,
      });
    }
    if (have.cordoned) {
      findings.push({
        kind: "cordoned",
        agent: have.agent,
        workerId: have.id,
        detail: `${have.id} is cordoned`,
      });
    }
  }

  // On-demand concurrency: live must not exceed maxConcurrent
  const agentsForCap: DesiredAgent[] = state.desired ?? [];
  for (const agent of agentsForCap) {
    if (agent.spec.scale !== "onDemand") continue;
    const cap = resolveMaxConcurrent(agent.spec);
    const n = live.filter((w) => w.agent === agent.metadata.name).length;
    if (n > cap) {
      findings.push({
        kind: "replica",
        agent: agent.metadata.name,
        detail: `onDemand live=${n} exceeds maxConcurrent=${cap}`,
      });
    }
  }

  // Per-agent replica counts (static standing pools only)
  const wantCount = new Map<string, number>();
  const haveCount = new Map<string, number>();
  for (const w of desiredWorkers) wantCount.set(w.agent, (wantCount.get(w.agent) ?? 0) + 1);
  for (const w of live) {
    const agent = state.desired.find((a) => a.metadata.name === w.agent);
    if (agent?.spec.scale === "onDemand") continue;
    haveCount.set(w.agent, (haveCount.get(w.agent) ?? 0) + 1);
  }
  const agents = new Set([...wantCount.keys(), ...haveCount.keys()]);
  for (const agentName of agents) {
    const agent = state.desired.find((a) => a.metadata.name === agentName);
    if (agent?.spec.scale === "onDemand") continue;
    const w = wantCount.get(agentName) ?? 0;
    const h = haveCount.get(agentName) ?? 0;
    if (w !== h) {
      findings.push({
        kind: "replica",
        agent: agentName,
        detail: `agent ${agentName}: live=${h} desired=${w}`,
      });
    }
  }

  // Also flag desired agents with no live workers when digest-aware desired image exists
  for (const agent of state.desired) {
    const dig = buildAgentImage(agent, imageOpts).digest;
    const matching = live.filter((w) => w.agent === agent.metadata.name && w.imageDigest === dig);
    if (!matching.length && live.some((w) => w.agent === agent.metadata.name)) {
      // already covered by digest findings
    }
  }

  const summary = emptySummary();
  for (const f of findings) summary[f.kind] += 1;

  // ok when no structural drift (cordoned alone is informational — still ok=false if any finding)
  const structural =
    summary.missing + summary.extra + summary.digest + summary.replica + summary.label + summary.taint;
  return {
    ok: structural === 0,
    at: new Date().toISOString(),
    source,
    findings,
    summary,
    liveWorkers: live.length,
    desiredWorkers: desiredWorkers.length,
  };
}

export function formatDriftReport(report: DriftReport): string {
  const lines: string[] = [];
  lines.push(
    `drift ${report.ok ? "ok" : "DRIFT"}  live=${report.liveWorkers} desired=${report.desiredWorkers} source=${report.source}`,
  );
  const s = report.summary;
  lines.push(
    `  missing=${s.missing} extra=${s.extra} digest=${s.digest} replica=${s.replica} label=${s.label} taint=${s.taint} cordoned=${s.cordoned}`,
  );
  for (const f of report.findings.slice(0, 50)) {
    lines.push(`  [${f.kind}] ${f.detail}`);
  }
  if (report.findings.length > 50) {
    lines.push(`  … ${report.findings.length - 50} more`);
  }
  return lines.join("\n");
}
