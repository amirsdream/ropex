import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyReplicaCap, collectGitRepos, collectPolicies, expandDesired, maxReplicas, parseManifests } from "./spec.js";
import { expandWorkers } from "./runtime.js";
import type { ClusterState, Manifest, ReconcilePlan, Worker } from "./types.js";

export const STATE_FILE = ".ropex/state.json";

export function emptyState(source = ""): ClusterState {
  return {
    revision: 0,
    source,
    desired: [],
    workers: [],
    gitRepos: [],
    policies: [],
    memory: [],
    skills: [],
  };
}

export function loadState(root: string): ClusterState {
  try {
    const raw = readFileSync(join(root, STATE_FILE), "utf8");
    return JSON.parse(raw) as ClusterState;
  } catch {
    return emptyState();
  }
}

export function saveState(root: string, state: ClusterState): void {
  const path = join(root, STATE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function planReconcile(current: ClusterState, manifests: Manifest[], source: string): {
  next: ClusterState;
  plan: ReconcilePlan;
} {
  const policies = collectPolicies(manifests);
  const gitRepos = collectGitRepos(manifests);
  const expanded = expandDesired(manifests);
  const cap = maxReplicas(policies);
  const { agents, capped } = applyReplicaCap(expanded, cap);

  const desiredWorkers = agents.flatMap(expandWorkers);
  const desiredIds = new Set(desiredWorkers.map((w) => w.id));
  const currentById = new Map(current.workers.filter((w) => w.status !== "retired").map((w) => [w.id, w]));

  const create: Worker[] = [];
  const update: Worker[] = [];
  const retire: Worker[] = [];

  for (const next of desiredWorkers) {
    const prev = currentById.get(next.id);
    if (!prev) {
      create.push({ ...next, status: "running" });
      continue;
    }
    const merged: Worker = {
      ...prev,
      harness: next.harness,
      plugins: next.plugins,
      model: next.model,
      skills: [...new Set([...next.skills, ...prev.skills])],
      status: prev.status === "failed" ? "failed" : "running",
    };
    update.push(merged);
  }
  for (const prev of current.workers) {
    if (prev.status === "retired") continue;
    if (!desiredIds.has(prev.id)) {
      retire.push({ ...prev, status: "retired" });
    }
  }

  const workers = [
    ...create,
    ...update,
    ...current.workers.filter((w) => w.status === "retired"),
    ...retire,
  ];

  const next: ClusterState = {
    ...current,
    revision: current.revision + 1,
    source,
    desired: agents,
    workers,
    gitRepos,
    policies,
    lastReconcile: new Date().toISOString(),
  };

  return { next, plan: { create, retire, update, capped } };
}

export function applyManifestText(root: string, raw: string, source: string): {
  state: ClusterState;
  plan: ReconcilePlan;
} {
  const manifests = parseManifests(raw);
  const current = loadState(root);
  const { next, plan } = planReconcile(current, manifests, source);
  saveState(root, next);
  return { state: next, plan };
}
