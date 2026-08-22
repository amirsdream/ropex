/**
 * Cluster state snapshot / export — durable checkpoint for backup and replay fixtures.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ClusterState, SharedMemoryFact } from "./types.js";
import { emptyState } from "./controller.js";
import { ensureQueue, emptyMetrics } from "./queue.js";
import { ensureJournal } from "./journal.js";
import { ensureOutbound } from "./deliver.js";
import { ensureSkillRegistry } from "./skills.js";
import { ensureTrajectories } from "./trajectory.js";
import { ensureRateLimits } from "./ratelimit.js";
import { ensureApprovals } from "./approval.js";
import { ensureAudit } from "./audit.js";
import { ensureBudgets } from "./budget.js";
import { normalizeFact } from "./memory.js";

export type SnapshotMeta = {
  at: string;
  revision: number;
  source: string;
  workersLive: number;
  queuePending: number;
};

export type SnapshotDocument = {
  meta: SnapshotMeta;
  state: ClusterState;
};

export function snapshotMeta(state: ClusterState): SnapshotMeta {
  return {
    at: new Date().toISOString(),
    revision: state.revision,
    source: state.source,
    workersLive: state.workers.filter((w) => w.status !== "retired").length,
    queuePending: state.queue?.filter((q) => q.status === "pending").length ?? 0,
  };
}

/** Serialize cluster state (pretty JSON). */
export function exportSnapshot(state: ClusterState): string {
  return `${JSON.stringify({ meta: snapshotMeta(state), state }, null, 2)}\n`;
}

/** Write snapshot under `.ropex/snapshots/` (or custom path). */
export function writeSnapshot(
  root: string,
  state: ClusterState,
  opts: { path?: string } = {},
): { path: string; meta: SnapshotMeta } {
  const meta = snapshotMeta(state);
  const path =
    opts.path ??
    join(root, ".ropex", "snapshots", `rev-${state.revision}-${Date.now()}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, exportSnapshot(state));
  return { path, meta };
}

function hydrateState(raw: ClusterState): ClusterState {
  const base = emptyState(raw.source ?? "");
  const state: ClusterState = { ...base, ...raw };
  state.memory = (state.memory ?? []).map((f) =>
    normalizeFact(f as SharedMemoryFact),
  );
  ensureQueue(state);
  if (!state.metrics) state.metrics = emptyMetrics();
  ensureJournal(state);
  ensureOutbound(state);
  ensureSkillRegistry(state);
  ensureTrajectories(state);
  ensureRateLimits(state);
  ensureApprovals(state);
  ensureAudit(state);
  if (!state.gitRepoStatus) state.gitRepoStatus = [];
  ensureBudgets(state);
  if (!state.affinity) state.affinity = [];
  if (!state.webhookSeen) state.webhookSeen = [];
  return state;
}

/**
 * Parse a snapshot document (exportSnapshot format or bare ClusterState).
 */
export function parseSnapshot(text: string): SnapshotDocument {
  const parsed = JSON.parse(text) as SnapshotDocument | ClusterState;
  if (parsed && typeof parsed === "object" && "state" in parsed && (parsed as SnapshotDocument).state) {
    const doc = parsed as SnapshotDocument;
    const state = hydrateState(doc.state);
    const meta = doc.meta ?? snapshotMeta(state);
    return { meta, state };
  }
  const state = hydrateState(parsed as ClusterState);
  return { meta: snapshotMeta(state), state };
}

/** Load snapshot file from disk (absolute or root-relative). */
export function loadSnapshot(root: string, path: string): SnapshotDocument {
  const full = path.startsWith("/") ? path : resolve(root, path);
  return parseSnapshot(readFileSync(full, "utf8"));
}

/**
 * Restore cluster state from a snapshot file and optionally persist it.
 * Does not mutate workers' worktrees on disk — next apply/tick can heal.
 */
export function restoreSnapshot(
  root: string,
  path: string,
  opts: { save?: (root: string, state: ClusterState) => void } = {},
): SnapshotDocument {
  const doc = loadSnapshot(root, path);
  if (opts.save) opts.save(root, doc.state);
  return doc;
}
