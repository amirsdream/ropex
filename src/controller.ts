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
import { expandWorkers } from "./runtime.js";
import { buildAgentImage } from "./image.js";
import { normalizeFact } from "./memory.js";
import { ensureAudit, recordAudit } from "./audit.js";
import { emptyMetrics, ensureQueue } from "./queue.js";
import { ensureJournal } from "./journal.js";
import { ensureOutbound } from "./deliver.js";
import { ensureSkillRegistry } from "./skills.js";
import { ensureTrajectories } from "./trajectory.js";
import { ensureRateLimits } from "./ratelimit.js";
import { ensureApprovals } from "./approval.js";
import { ensureBudgets } from "./budget.js";
import { applyWorktrees } from "./worktree.js";
import { selectCanaryRolls, type RolloutOptions } from "./canary.js";
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
    outbound: [],
    trajectories: [],
    rateLimits: [],
    approvals: [],
    queue: [],
    metrics: emptyMetrics(),
    audit: [],
    gitRepoStatus: [],
    budgets: [],
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
    ensureOutbound(state);
    ensureSkillRegistry(state);
    ensureTrajectories(state);
    ensureRateLimits(state);
    ensureApprovals(state);
    ensureAudit(state);
    if (!state.pipelines) state.pipelines = [];
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
 * GitOps reconcile of agent definitions + standing (static) workers.
 * On-demand agents do not create warm idle inventory — spawn happens at claim.
 * Digest change retires standing workers (canary optional); ephemeral runners
 * with stale digests are cordoned while running, retired when idle.
 */
export function planReconcile(
  current: ClusterState,
  manifests: Manifest[],
  source: string,
  opts: { root?: string; rollout?: RolloutOptions } = {},
): {
  next: ClusterState;
  plan: ReconcilePlan;
  canaryHeld: number;
} {
  const policies = collectPolicies(manifests);
  const gitRepos = collectGitRepos(manifests);
  const expanded = expandDesired(manifests);
  const cap = maxReplicas(policies);
  const { agents, capped } = applyReplicaCap(expanded, cap);

  const desiredWorkers = agents.flatMap((a) => expandWorkers(a, opts));
  const desiredIds = new Set(desiredWorkers.map((w) => w.id));
  const desiredByName = new Map(agents.map((a) => [a.metadata.name, a]));
  const currentById = new Map(
    current.workers.filter((w) => w.status !== "retired").map((w) => [w.id, w]),
  );

  const create: Worker[] = [];
  const update: Worker[] = [];
  const retire: Worker[] = [];
  const mismatches: Array<{ prev: Worker; next: Worker }> = [];

  for (const next of desiredWorkers) {
    const prev = currentById.get(next.id);
    if (!prev) {
      create.push({ ...next, status: "idle" });
      continue;
    }
    if (prev.imageDigest !== next.imageDigest) {
      mismatches.push({ prev, next });
      continue;
    }
    update.push({
      ...prev,
      status:
        prev.status === "failed"
          ? "failed"
          : prev.status === "running"
            ? "running"
            : "idle",
      skills: [...new Set([...prev.skills, ...next.skills])],
      worktree: prev.worktree,
      lastTaskAt: prev.lastTaskAt,
      labels: next.labels ? { ...next.labels } : prev.labels,
      taints: next.taints ? next.taints.map((t) => ({ ...t })) : prev.taints,
      cordoned: prev.cordoned,
    });
  }

  const { roll, hold } = selectCanaryRolls(mismatches, opts.rollout);
  for (const m of roll) {
    retire.push({ ...m.prev, status: "retired" });
    create.push({
      ...m.next,
      status: "idle",
      skills: [...new Set([...m.next.skills, ...m.prev.skills])],
    });
  }
  for (const m of hold) {
    update.push({
      ...m.prev,
      skills: [...new Set([...m.prev.skills, ...m.next.skills])],
      worktree: m.prev.worktree,
      lastTaskAt: m.prev.lastTaskAt,
    });
  }

  const handled = new Set([...desiredIds, ...update.map((w) => w.id), ...create.map((w) => w.id)]);

  for (const prev of current.workers) {
    if (prev.status === "retired") continue;
    if (desiredIds.has(prev.id) || handled.has(prev.id)) continue;

    const agent = desiredByName.get(prev.agent);
    if (agent?.spec.scale === "onDemand") {
      const digest = buildAgentImage(agent, opts).digest;
      if (prev.imageDigest !== digest) {
        if (prev.status === "running") {
          update.push({ ...prev, cordoned: true });
          handled.add(prev.id);
        } else {
          retire.push({ ...prev, status: "retired" });
        }
        continue;
      }
      update.push({
        ...prev,
        skills: [...new Set([...prev.skills, ...agent.spec.hermes.skills])],
        labels: agent.metadata.labels ? { ...agent.metadata.labels } : prev.labels,
      });
      handled.add(prev.id);
      continue;
    }

    retire.push({ ...prev, status: "retired" });
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
    outbound: current.outbound ?? [],
    trajectories: current.trajectories ?? [],
    rateLimits: current.rateLimits ?? [],
    approvals: current.approvals ?? [],
    audit: current.audit ?? [],
    gitRepoStatus: current.gitRepoStatus ?? [],
    budgets: current.budgets ?? [],
    lastReconcile: new Date().toISOString(),
  };

  recordAudit(next, {
    kind: "reconcile",
    message: `create=${create.length} retire=${retire.length} update=${update.length} capped=${capped.length} canaryHeld=${hold.length}`,
    meta: {
      create: create.length,
      retire: retire.length,
      update: update.length,
      capped: capped.length,
      canaryHeld: hold.length,
      strategy: opts.rollout?.strategy ?? "recreate",
      source,
      onDemand: agents.filter((a) => a.spec.scale === "onDemand").length,
      static: agents.filter((a) => a.spec.scale !== "onDemand").length,
    },
  });

  return { next, plan, canaryHeld: hold.length };
}

export function applyManifestText(
  root: string,
  raw: string,
  source: string,
  opts: { rollout?: RolloutOptions } = {},
): {
  state: ClusterState;
  plan: ReconcilePlan;
  canaryHeld: number;
} {
  const manifests = parseManifests(raw);
  const current = loadState(root);
  const { next, plan, canaryHeld } = planReconcile(current, manifests, source, {
    root,
    rollout: opts.rollout,
  });
  saveState(root, next);
  return { state: next, plan, canaryHeld };
}
