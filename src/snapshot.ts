/**
 * Cluster state snapshot / export — durable checkpoint for backup and replay fixtures.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ClusterState } from "./types.js";

export type SnapshotMeta = {
  at: string;
  revision: number;
  source: string;
  workersLive: number;
  queuePending: number;
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
