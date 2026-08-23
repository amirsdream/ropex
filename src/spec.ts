import { parseAllDocuments } from "yaml";
import type {
  Agent,
  AgentSpec,
  DesiredAgent,
  Fleet,
  GitRepo,
  LabelSelector,
  Manifest,
  Policy,
  ScaleMode,
  TaskManifest,
  MemoryManifest,
} from "./types.js";
import { API_VERSION } from "./types.js";
import { resolveMaxConcurrent, resolveScaleMode } from "./scale.js";

export function parseManifests(raw: string): Manifest[] {
  const docs = parseAllDocuments(raw);
  const out: Manifest[] = [];
  for (const doc of docs) {
    if (doc.errors.length) {
      throw new Error(doc.errors.map((e) => e.message).join("; "));
    }
    const data = doc.toJSON();
    if (!data) continue;
    out.push(validateManifest(data));
  }
  return out;
}

function validateManifest(data: unknown): Manifest {
  if (!data || typeof data !== "object") {
    throw new Error("manifest must be an object");
  }
  const m = data as Record<string, unknown>;
  if (m.apiVersion !== API_VERSION) {
    throw new Error(`unsupported apiVersion: ${String(m.apiVersion)}`);
  }
  const kind = m.kind;
  if (kind !== "Agent" && kind !== "Fleet" && kind !== "GitRepo" && kind !== "Policy" && kind !== "Task" && kind !== "Memory") {
    throw new Error(`unsupported kind: ${String(kind)}`);
  }
  const metadata = m.metadata as { name?: string } | undefined;
  if (!metadata?.name) {
    throw new Error(`${kind} is missing metadata.name`);
  }
  if (kind === "Task") {
    const spec = m.spec as { agent?: string; prompt?: string } | undefined;
    if (!spec?.agent || !spec?.prompt) {
      throw new Error("Task is missing spec.agent or spec.prompt");
    }
  }
  if (kind === "Memory") {
    const spec = m.spec as { agent?: string; text?: string } | undefined;
    if (!spec?.agent || !spec?.text) {
      throw new Error("Memory is missing spec.agent or spec.text");
    }
  }
  return data as Manifest;
}

export function labelsMatch(
  labels: Record<string, string> | undefined,
  selector?: LabelSelector,
): boolean {
  if (!selector?.matchLabels) return true;
  const have = labels ?? {};
  for (const [key, value] of Object.entries(selector.matchLabels)) {
    if (value === "*") {
      if (!(key in have) && key !== "repo" && key !== "org") return false;
      continue;
    }
    if (have[key] !== value) return false;
  }
  return true;
}

function cloneAgentSpec(tpl: Omit<AgentSpec, "replicas"> & { replicas?: number }, overrides: {
  replicas: number;
  scale?: ScaleMode;
  maxConcurrent?: number;
  idleTTLMs?: number;
}): AgentSpec {
  return {
    ...tpl,
    replicas: overrides.replicas,
    scale: overrides.scale ?? tpl.scale,
    maxConcurrent: overrides.maxConcurrent ?? tpl.maxConcurrent,
    idleTTLMs: overrides.idleTTLMs ?? tpl.idleTTLMs,
    harness: { ...tpl.harness },
    hermes: {
      ...tpl.hermes,
      skills: [...tpl.hermes.skills],
    },
    github: tpl.github
      ? { ...tpl.github, events: [...tpl.github.events] }
      : undefined,
    selector: tpl.selector,
    placement: tpl.placement
      ? {
          require: tpl.placement.require ? { ...tpl.placement.require } : undefined,
          prefer: tpl.placement.prefer ? { ...tpl.placement.prefer } : undefined,
          taints: tpl.placement.taints?.map((t) => ({ ...t })),
          tolerations: tpl.placement.tolerations?.map((t) => ({ ...t })),
        }
      : undefined,
  };
}

function normalizeAgentSpec(spec: AgentSpec): AgentSpec {
  const scale = resolveScaleMode(spec);
  const maxConcurrent = resolveMaxConcurrent({ ...spec, scale });
  if (scale === "onDemand") {
    return {
      ...spec,
      scale,
      maxConcurrent,
      // Keep replicas as a non-zero hint for tooling; standing expand uses scale.
      replicas: Math.max(1, spec.replicas ?? maxConcurrent),
    };
  }
  return {
    ...spec,
    scale: "static",
    replicas: Math.max(1, spec.replicas ?? 1),
    maxConcurrent: undefined,
  };
}

/**
 * Expand Git desired state into agent *definitions*.
 * - Agent: one definition (static or onDemand).
 * - Fleet static: N derived agents (legacy warm inventory).
 * - Fleet onDemand: one definition named after the fleet; replicas/maxConcurrent = concurrency cap.
 */
export function expandDesired(manifests: Manifest[]): DesiredAgent[] {
  const agents: DesiredAgent[] = [];
  for (const m of manifests) {
    if (m.kind === "Agent") {
      agents.push({ ...m, spec: normalizeAgentSpec({ ...m.spec, replicas: Math.max(0, m.spec.replicas ?? 1) }) });
    }
  }
  for (const m of manifests) {
    if (m.kind !== "Fleet") continue;
    const fleetScale = resolveScaleMode({
      scale: m.spec.scale ?? m.spec.template.spec.scale,
      replicas: m.spec.replicas,
      maxConcurrent: m.spec.maxConcurrent ?? m.spec.template.spec.maxConcurrent,
    });
    const concurrency = resolveMaxConcurrent({
      scale: fleetScale,
      replicas: m.spec.replicas,
      maxConcurrent: m.spec.maxConcurrent ?? m.spec.template.spec.maxConcurrent,
    });
    const idleTTLMs = m.spec.idleTTLMs ?? m.spec.template.spec.idleTTLMs;

    if (fleetScale === "onDemand") {
      const spec = normalizeAgentSpec(
        cloneAgentSpec(m.spec.template.spec, {
          replicas: concurrency,
          scale: "onDemand",
          maxConcurrent: concurrency,
          idleTTLMs,
        }),
      );
      agents.push({
        apiVersion: API_VERSION,
        kind: "Agent",
        metadata: {
          name: m.metadata.name,
          labels: {
            ...(m.metadata.labels ?? {}),
            ...(m.spec.template.metadata?.labels ?? {}),
            fleet: m.metadata.name,
          },
        },
        spec,
        derivedFrom: { fleet: m.metadata.name, replica: 0 },
      });
      continue;
    }

    const replicas = Math.max(0, m.spec.replicas);
    for (let i = 0; i < replicas; i++) {
      const spec = normalizeAgentSpec(
        cloneAgentSpec(m.spec.template.spec, {
          replicas: 1,
          scale: "static",
          idleTTLMs,
        }),
      );
      agents.push({
        apiVersion: API_VERSION,
        kind: "Agent",
        metadata: {
          name: `${m.metadata.name}-${i}`,
          labels: {
            ...(m.metadata.labels ?? {}),
            ...(m.spec.template.metadata?.labels ?? {}),
            fleet: m.metadata.name,
          },
        },
        spec,
        derivedFrom: { fleet: m.metadata.name, replica: i },
      });
    }
  }
  return agents;
}

export function collectPolicies(manifests: Manifest[]): Policy[] {
  return manifests.filter((m): m is Policy => m.kind === "Policy");
}

export function collectGitRepos(manifests: Manifest[]): GitRepo[] {
  return manifests.filter((m): m is GitRepo => m.kind === "GitRepo");
}

export function collectTasks(manifests: Manifest[]): TaskManifest[] {
  return manifests.filter((m): m is TaskManifest => m.kind === "Task");
}

export function collectMemory(manifests: Manifest[]): MemoryManifest[] {
  return manifests.filter((m): m is MemoryManifest => m.kind === "Memory");
}

export function collectFleets(manifests: Manifest[]): Fleet[] {
  return manifests.filter((m): m is Fleet => m.kind === "Fleet");
}

export function maxReplicas(policies: Policy[]): number {
  if (!policies.length) return Number.POSITIVE_INFINITY;
  return Math.min(...policies.map((p) => p.spec.maxReplicas));
}

/**
 * Cap capacity across desired agents.
 * Static: caps standing replicas.
 * OnDemand: caps maxConcurrent (definitions stay; spawn honors the capped value).
 */
export function applyReplicaCap(
  desired: DesiredAgent[],
  cap: number,
): { agents: DesiredAgent[]; capped: Array<{ agent: string; requested: number; allowed: number }> } {
  const capped: Array<{ agent: string; requested: number; allowed: number }> = [];
  let remaining = cap;
  const agents: DesiredAgent[] = [];
  for (const agent of desired) {
    const mode = resolveScaleMode(agent.spec);
    if (mode === "onDemand") {
      const requested = resolveMaxConcurrent(agent.spec);
      const allowed = Math.min(requested, Math.max(0, remaining));
      if (allowed < requested) {
        capped.push({ agent: agent.metadata.name, requested, allowed });
      }
      remaining -= allowed;
      if (allowed <= 0) continue;
      agents.push({
        ...agent,
        spec: {
          ...agent.spec,
          scale: "onDemand",
          maxConcurrent: allowed,
          replicas: Math.max(1, allowed),
        },
      });
      continue;
    }
    const requested = agent.derivedFrom ? 1 : agent.spec.replicas;
    const allowed = Math.min(requested, Math.max(0, remaining));
    if (allowed < requested) {
      capped.push({ agent: agent.metadata.name, requested, allowed });
    }
    remaining -= allowed;
    if (allowed <= 0) continue;
    agents.push({ ...agent, spec: { ...agent.spec, scale: "static", replicas: allowed } });
  }
  return { agents, capped };
}

/** @deprecated use resolveScaleMode from scale.js — re-export for convenience */
export { resolveScaleMode, resolveMaxConcurrent };
