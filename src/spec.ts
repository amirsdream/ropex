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
import { cliRuntime, isHttpsBaseUrl, type CliRuntimeKind } from "./cli-runtimes/index.js";
import {
  API_VERSION,
  HARNESS_PROFILES,
  RUNTIME_AUTH_METHODS,
  SANDBOX_PROVIDER_KINDS_LIST,
  WORKER_RUNTIME_KINDS_LIST,
  type RuntimeAuthMethod,
} from "./types.js";
import { resolveMaxConcurrent, resolveScaleMode } from "./scale.js";
import { cloneSandboxSpec, validateSandboxSpec } from "./sandbox/spec.js";

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
  if (kind === "Agent" || kind === "Fleet") {
    const spec = m.spec as Record<string, unknown> | undefined;
    const agentSpec = (kind === "Fleet"
      ? (spec?.template as { spec?: Record<string, unknown> } | undefined)?.spec
      : spec) as Record<string, unknown> | undefined;
    validateAgentSpec(agentSpec, `${kind} ${metadata.name}`);
  }
  if (kind === "Policy") {
    const sandbox = (m.spec as { sandbox?: { allowProviders?: unknown } } | undefined)?.sandbox;
    const allowed = sandbox?.allowProviders;
    if (allowed !== undefined) {
      if (!Array.isArray(allowed) || allowed.some((p) => !SANDBOX_PROVIDER_KINDS_LIST.includes(p as never))) {
        throw new Error(
          `Policy ${metadata.name}: sandbox.allowProviders must be a list of ${SANDBOX_PROVIDER_KINDS_LIST.join(" | ")}`,
        );
      }
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

/** Structural checks the `as Manifest` cast cannot make. */
function validateAgentSpec(spec: Record<string, unknown> | undefined, where: string): void {
  const harness = spec?.harness as { profile?: unknown } | undefined;
  if (harness?.profile !== undefined && !HARNESS_PROFILES.includes(harness.profile as never)) {
    throw new Error(
      `${where}: unsupported harness.profile "${String(harness.profile)}" (expected ${HARNESS_PROFILES.join(" | ")})`,
    );
  }
  validateSandboxSpec(spec?.sandbox, where);
  const runtime = spec?.runtime as
    | {
        kind?: unknown;
        command?: unknown;
        commandArgs?: unknown;
        auth?: unknown;
        baseUrl?: unknown;
      }
    | undefined;
  if (runtime === undefined) return;
  if (!WORKER_RUNTIME_KINDS_LIST.includes(runtime.kind as never)) {
    throw new Error(
      `${where}: unsupported runtime.kind "${String(runtime.kind)}" (expected ${WORKER_RUNTIME_KINDS_LIST.join(" | ")})`,
    );
  }
  if (runtime.commandArgs !== undefined && runtime.command === undefined) {
    throw new Error(`${where}: runtime.commandArgs requires runtime.command`);
  }
  if (runtime.auth !== undefined && !RUNTIME_AUTH_METHODS.includes(runtime.auth as RuntimeAuthMethod)) {
    throw new Error(
      `${where}: unsupported runtime.auth "${String(runtime.auth)}" (expected ${RUNTIME_AUTH_METHODS.join(" | ")})`,
    );
  }
  if (runtime.kind === "dsh" && runtime.auth !== undefined) {
    throw new Error(`${where}: runtime.auth does not apply to dsh`);
  }
  if (runtime.kind !== "dsh" && runtime.auth !== undefined) {
    const methods = cliRuntime(runtime.kind as CliRuntimeKind).auth.map((item) => item.method);
    if (!methods.includes(runtime.auth as RuntimeAuthMethod)) {
      throw new Error(
        `${where}: runtime.auth "${String(runtime.auth)}" is not supported by ${String(runtime.kind)} (expected ${methods.join(" | ")})`,
      );
    }
  }
  if (runtime.baseUrl !== undefined) {
    if (typeof runtime.baseUrl !== "string" || !isHttpsBaseUrl(runtime.baseUrl)) {
      throw new Error(`${where}: runtime.baseUrl must be an https URL without embedded credentials`);
    }
    if (runtime.kind !== "codex" || (runtime.auth !== undefined && runtime.auth !== "api-key")) {
      throw new Error(`${where}: runtime.baseUrl applies to codex auth api-key`);
    }
  }
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
    runtime: tpl.runtime
      ? {
          ...tpl.runtime,
          commandArgs: tpl.runtime.commandArgs ? [...tpl.runtime.commandArgs] : undefined,
          requireEnv: tpl.runtime.requireEnv ? [...tpl.runtime.requireEnv] : undefined,
        }
      : undefined,
    sandbox: tpl.sandbox ? cloneSandboxSpec(tpl.sandbox) : undefined,
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
