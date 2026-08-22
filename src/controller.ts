import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  applyReplicaCap,
  collectGitRepos,
  collectPolicies,
  expandDesired,
  maxReplicas,
  parseManifests,
} from "./spec.js";
import { expandWorkers, runTask } from "./runtime.js";
import { normalizeFact } from "./memory.js";
import { ensureAudit, recordAudit } from "./audit.js";
import { emptyMetrics, ensureQueue } from "./queue.js";
import { ensureJournal } from "./journal.js";
import { ensureSkillRegistry } from "./skills.js";
import { ensureTrajectories } from "./trajectory.js";
import { ensureRateLimits } from "./ratelimit.js";
import { ensureApprovals } from "./approval.js";
import { applyWorktrees } from "./worktree.js";
import type { ClusterState, Manifest, ReconcilePlan, SharedMemoryFact, Worker } from "./types.js";

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
    skillRegistry: [],
    deliveries: [],
    trajectories: [],
    rateLimits: [],
    approvals: [],
    queue: [],
    metrics: emptyMetrics(),
    audit: [],
  };
}

export function loadState(root: string): ClusterState {
  try {
    const raw = readFileSync(join(root, STATE_FILE), "utf8");
    const state = JSON.parse(raw) as ClusterState;
    state.memory = (state.memory ?? []).map((f) =>
      normalizeFact(f as SharedMemoryFact),
    );
    ensureQueue(state);
    ensureJournal(state);
    ensureSkillRegistry(state);
    ensureTrajectories(state);
    ensureRateLimits(state);
    ensureApprovals(state);
    ensureAudit(state);
    return state;
  } catch {
    return emptyState();
  }
}

export function saveState(root: string, state: ClusterState): void {
  const path = join(root, STATE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Kubernetes-style reconcile: workers are immutable for a given agent image digest.
 * Spec/code change → new digest → retire old worker + create replacement (no in-place mutate).
 */
export function planReconcile(
  current: ClusterState,
  manifests: Manifest[],
  source: string,
  opts: { root?: string } = {},
): {
  next: ClusterState;
  plan: ReconcilePlan;
} {
  const policies = collectPolicies(manifests);
  const gitRepos = collectGitRepos(manifests);
  const expanded = expandDesired(manifests);
  const cap = maxReplicas(policies);
  const { agents, capped } = applyReplicaCap(expanded, cap);

  const desiredWorkers = agents.flatMap((a) => expandWorkers(a, opts));
  const desiredIds = new Set(desiredWorkers.map((w) => w.id));
  const currentById = new Map(
    current.workers.filter((w) => w.status !== "retired").map((w) => [w.id, w]),
  );

  const create: Worker[] = [];
  const update: Worker[] = [];
  const retire: Worker[] = [];

  for (const next of desiredWorkers) {
    const prev = currentById.get(next.id);
    if (!prev) {
      create.push({ ...next, status: "idle" });
      continue;
    }
    if (prev.imageDigest !== next.imageDigest) {
      // Immutable roll: old image retires, new image boots under the same slot id.
      retire.push({ ...prev, status: "retired" });
      create.push({
        ...next,
        status: "idle",
        // Carry learned skills across rolls (volume), not image fields.
        skills: [...new Set([...next.skills, ...prev.skills])],
      });
      continue;
    }
    // Same image: keep identity; only lifecycle status may change.
    update.push({
      ...prev,
      status:
        prev.status === "failed"
          ? "failed"
          : prev.status === "running"
            ? "running"
            : prev.status === "idle"
              ? "idle"
              : "idle",
      skills: [...new Set([...prev.skills, ...next.skills])],
      worktree: prev.worktree,
      lastTaskAt: prev.lastTaskAt,
    });
  }
  for (const prev of current.workers) {
    if (prev.status === "retired") continue;
    if (!desiredIds.has(prev.id)) {
      retire.push({ ...prev, status: "retired" });
    }
  }

  const retiredHistory = current.workers.filter((w) => w.status === "retired");
  const workers = [...create, ...update, ...retiredHistory, ...retire];

  const plan: ReconcilePlan = { create, retire, update, capped };
  if (opts.root) {
    applyWorktrees(opts.root, plan);
  }

  const next: ClusterState = {
    ...current,
    revision: current.revision + 1,
    source,
    desired: agents,
    workers,
    gitRepos,
    policies,
    queue: current.queue ?? [],
    metrics: current.metrics ?? emptyMetrics(),
    skillRegistry: current.skillRegistry ?? [],
    deliveries: current.deliveries ?? [],
    trajectories: current.trajectories ?? [],
    rateLimits: current.rateLimits ?? [],
    approvals: current.approvals ?? [],
    audit: current.audit ?? [],
    lastReconcile: new Date().toISOString(),
  };

  recordAudit(next, {
    kind: "reconcile",
    message: `create=${create.length} retire=${retire.length} update=${update.length} capped=${capped.length}`,
    meta: {
      create: create.length,
      retire: retire.length,
      update: update.length,
      capped: capped.length,
      source,
    },
  });

  return { next, plan };
}

export function applyManifestText(
  root: string,
  raw: string,
  source: string,
): {
  state: ClusterState;
  plan: ReconcilePlan;
} {
  const manifests = parseManifests(raw);
  const current = loadState(root);
  const { next, plan } = planReconcile(current, manifests, source, { root });
  saveState(root, next);
  return { state: next, plan };
}
