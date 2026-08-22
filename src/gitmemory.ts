/**
 * Git-native memory — Memory YAML in the fleet repo.
 * Sync loads declarative facts into the cluster bus; export writes runtime facts back to git.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { stringify, parseDocument } from "yaml";
import { recordAudit } from "./audit.js";
import { resolveRepoLocalPath } from "./gitrepo.js";
import { normalizeFact } from "./memory.js";
import { parseManifests } from "./spec.js";
import type { ClusterState, MemoryManifest, MemoryScope, SharedMemoryFact } from "./types.js";

export const DEFAULT_MEMORY_DIR = "memory";

export function resolveMemoryDir(root: string, dir?: string): string {
  if (dir) return isAbsolute(dir) ? dir : resolve(root, dir);
  return resolve(root, DEFAULT_MEMORY_DIR);
}

export function findMemoryFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
    const full = join(dir, name);
    if (statSync(full).isFile()) out.push(full);
  }
  return out.sort();
}

export function readMemoryManifest(path: string): MemoryManifest {
  const raw = readFileSync(path, "utf8");
  const manifests = parseManifests(raw);
  const mem = manifests.find((m) => m.kind === "Memory");
  if (!mem || mem.kind !== "Memory") {
    throw new Error(`not a Memory manifest: ${path}`);
  }
  return mem;
}

export function factFromManifest(m: MemoryManifest, manifestPath: string): SharedMemoryFact {
  return normalizeFact({
    id: m.metadata.name,
    agent: m.spec.agent,
    text: m.spec.text,
    at: new Date().toISOString(),
    scope: m.spec.scope ?? "agent",
    fleet: m.spec.fleet,
    tags: m.spec.tags ? [...m.spec.tags] : undefined,
    manifestPath,
  });
}

export type MemorySyncResult = {
  synced: string[];
  skipped: string[];
  errors: Array<{ path: string; error: string }>;
  scanned: number;
};

function upsertGitFact(state: ClusterState, fact: SharedMemoryFact): "synced" | "skipped" {
  const idx = state.memory.findIndex((f) => f.id === fact.id);
  if (idx === -1) {
    state.memory.push(fact);
    return "synced";
  }
  const existing = state.memory[idx];
  if (
    existing.manifestPath &&
    existing.text === fact.text &&
    existing.scope === fact.scope &&
    existing.agent === fact.agent &&
    existing.fleet === fact.fleet &&
    JSON.stringify(existing.tags ?? []) === JSON.stringify(fact.tags ?? [])
  ) {
    return "skipped";
  }
  state.memory[idx] = { ...fact, at: existing.at };
  return "synced";
}

export function syncMemoryFromDir(
  state: ClusterState,
  root: string,
  dir?: string,
): MemorySyncResult {
  const memoryDir = resolveMemoryDir(root, dir);
  const result: MemorySyncResult = { synced: [], skipped: [], errors: [], scanned: 0 };
  for (const path of findMemoryFiles(memoryDir)) {
    result.scanned += 1;
    try {
      const m = readMemoryManifest(path);
      const fact = factFromManifest(m, path);
      const outcome = upsertGitFact(state, fact);
      if (outcome === "synced") {
        result.synced.push(fact.id);
        recordAudit(state, {
          kind: "memory",
          message: `git memory synced from ${path}`,
          agent: fact.agent,
          meta: { path, scope: fact.scope, source: "git" },
        });
      } else {
        result.skipped.push(fact.id);
      }
    } catch (err) {
      result.errors.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** Sync `memory/` (or memoryPath) under every declared GitRepo local path. */
export function syncMemoryFromGitRepos(state: ClusterState, root: string): MemorySyncResult {
  const merged: MemorySyncResult = { synced: [], skipped: [], errors: [], scanned: 0 };
  for (const repo of state.gitRepos ?? []) {
    const loc = resolveRepoLocalPath(root, repo);
    if (!loc.ok) {
      merged.errors.push({ path: loc.path, error: loc.reason ?? "repo path missing" });
      continue;
    }
    const memoryDir = join(loc.path, repo.spec.memoryPath ?? DEFAULT_MEMORY_DIR);
    const part = syncMemoryFromDir(state, root, memoryDir);
    merged.synced.push(...part.synced);
    merged.skipped.push(...part.skipped);
    merged.errors.push(...part.errors);
    merged.scanned += part.scanned;
  }
  return merged;
}

export function memoryManifestDoc(fact: SharedMemoryFact): string {
  const doc = {
    apiVersion: "ropex.dev/v1",
    kind: "Memory",
    metadata: { name: fact.id },
    spec: {
      agent: fact.agent,
      text: fact.text,
      scope: fact.scope,
      ...(fact.fleet ? { fleet: fact.fleet } : {}),
      ...(fact.tags?.length ? { tags: [...fact.tags] } : {}),
    },
  };
  return `${stringify(doc)}`;
}

export function defaultMemoryManifestPath(root: string, factId: string, dir?: string): string {
  const memoryDir = resolveMemoryDir(root, dir);
  const safe = factId.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return join(memoryDir, `${safe}.yaml`);
}

/** Write a cluster memory fact to a Memory YAML file (create or update). */
export function exportMemoryFactToGit(
  fact: SharedMemoryFact,
  opts: { root: string; path?: string; dir?: string } = { root: process.cwd() },
): string {
  const path = opts.path ?? defaultMemoryManifestPath(opts.root, fact.id, opts.dir);
  const dir = join(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, memoryManifestDoc({ ...fact, manifestPath: path }));
  return path;
}

export type MemoryExportResult = {
  exported: string[];
  skipped: string[];
  errors: Array<{ id: string; error: string }>;
};

export function exportMemoryFacts(
  state: ClusterState,
  root: string,
  opts: { ids?: string[]; all?: boolean; force?: boolean; dir?: string } = {},
): MemoryExportResult {
  const result: MemoryExportResult = { exported: [], skipped: [], errors: [] };
  const targets = opts.ids?.length
    ? state.memory.filter((f) => opts.ids!.includes(f.id))
    : opts.all
      ? state.memory
      : [];

  for (const raw of targets) {
    const fact = normalizeFact(raw as SharedMemoryFact);
    if (fact.manifestPath && !opts.force) {
      result.skipped.push(fact.id);
      continue;
    }
    try {
      const path = exportMemoryFactToGit(fact, { root, dir: opts.dir });
      const idx = state.memory.findIndex((f) => f.id === fact.id);
      if (idx !== -1) state.memory[idx] = { ...fact, manifestPath: path };
      result.exported.push(path);
      recordAudit(state, {
        kind: "memory",
        message: `memory exported to ${path}`,
        agent: fact.agent,
        meta: { path, scope: fact.scope, id: fact.id },
      });
    } catch (err) {
      result.errors.push({ id: fact.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

export function findMemoryFact(state: ClusterState, id: string): SharedMemoryFact | undefined {
  const fact = state.memory.find((f) => f.id === id);
  return fact ? normalizeFact(fact as SharedMemoryFact) : undefined;
}

/** When agent spec enables exportMemory, write the fact to memory/*.yaml. */
export function maybeExportRememberedFact(
  state: ClusterState,
  root: string,
  fact: SharedMemoryFact,
  exportMemory?: boolean,
): string | undefined {
  if (!exportMemory) return fact.manifestPath;
  const path = exportMemoryFactToGit(fact, { root });
  const idx = state.memory.findIndex((f) => f.id === fact.id);
  if (idx !== -1) state.memory[idx] = { ...fact, manifestPath: path };
  recordAudit(state, {
    kind: "memory",
    message: `auto-export memory ${fact.id} → ${path}`,
    agent: fact.agent,
    meta: { path, id: fact.id, scope: fact.scope },
  });
  return path;
}

export function memoryGitSummary(state: ClusterState): {
  gitBacked: number;
  runtimeOnly: number;
  total: number;
} {
  const gitBacked = state.memory.filter((f) => f.manifestPath).length;
  return {
    gitBacked,
    runtimeOnly: state.memory.length - gitBacked,
    total: state.memory.length,
  };
}

export function promoteAndExportMemory(
  state: ClusterState,
  root: string,
  id: string,
  scope: MemoryScope,
  promote: (state: ClusterState, id: string, scope: MemoryScope) => SharedMemoryFact | undefined,
  opts: { export?: boolean; dir?: string } = {},
): { fact?: SharedMemoryFact; path?: string } {
  const next = promote(state, id, scope);
  if (!next) return {};
  if (opts.export !== false) {
    const path = exportMemoryFactToGit(next, { root, dir: opts.dir });
    const idx = state.memory.findIndex((f) => f.id === next.id);
    if (idx !== -1) state.memory[idx] = { ...next, manifestPath: path };
    return { fact: next, path };
  }
  return { fact: next };
}
