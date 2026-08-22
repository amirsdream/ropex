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
} from "./types.js";
import { API_VERSION } from "./types.js";

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
  if (kind !== "Agent" && kind !== "Fleet" && kind !== "GitRepo" && kind !== "Policy") {
    throw new Error(`unsupported kind: ${String(kind)}`);
  }
  const metadata = m.metadata as { name?: string } | undefined;
  if (!metadata?.name) {
    throw new Error(`${kind} is missing metadata.name`);
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

export function expandDesired(manifests: Manifest[]): DesiredAgent[] {
  const agents: DesiredAgent[] = [];
  for (const m of manifests) {
    if (m.kind === "Agent") {
      agents.push({ ...m, spec: { ...m.spec, replicas: Math.max(1, m.spec.replicas) } });
    }
  }
  for (const m of manifests) {
    if (m.kind !== "Fleet") continue;
    const replicas = Math.max(0, m.spec.replicas);
    for (let i = 0; i < replicas; i++) {
      const tpl = m.spec.template.spec;
      const spec: AgentSpec = {
        ...tpl,
        replicas: 1,
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

export function collectFleets(manifests: Manifest[]): Fleet[] {
  return manifests.filter((m): m is Fleet => m.kind === "Fleet");
}

export function maxReplicas(policies: Policy[]): number {
  if (!policies.length) return Number.POSITIVE_INFINITY;
  return Math.min(...policies.map((p) => p.spec.maxReplicas));
}

export function applyReplicaCap(
  desired: DesiredAgent[],
  cap: number,
): { agents: DesiredAgent[]; capped: Array<{ agent: string; requested: number; allowed: number }> } {
  const capped: Array<{ agent: string; requested: number; allowed: number }> = [];
  let remaining = cap;
  const agents: DesiredAgent[] = [];
  for (const agent of desired) {
    const requested = agent.derivedFrom ? 1 : agent.spec.replicas;
    const allowed = Math.min(requested, Math.max(0, remaining));
    if (allowed < requested) {
      capped.push({ agent: agent.metadata.name, requested, allowed });
    }
    remaining -= allowed;
    if (allowed <= 0) continue;
    agents.push({ ...agent, spec: { ...agent.spec, replicas: allowed } });
  }
  return { agents, capped };
}
