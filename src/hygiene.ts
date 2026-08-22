/**
 * Ops hygiene — reclaim leases, GC worktrees, age priorities, and pool/queue views.
 */

import { fairnessReport } from "./fairness.js";
import {
  ageQueuePriorities,
  ensureQueue,
  queueSummary,
  reclaimExpiredLeases,
} from "./queue.js";
import type { ClusterState } from "./types.js";
import { WEBHOOK_SEEN_MAX } from "./webhook.js";
import { gcOrphanWorktrees, type WorktreeGcResult } from "./worktree.js";

export type PoolCell = {
  agent: string;
  idle: number;
  running: number;
  failed: number;
  cordoned: number;
  total: number;
};

export type QueueDepthBar = {
  key: string;
  count: number;
  kind: "agent" | "lane";
};

export type HygieneReport = {
  pool: PoolCell[];
  queueDepth: QueueDepthBar[];
  webhook: {
    seen: number;
    duplicates: number;
    cap: number;
  };
  leasesReclaimedTotal: number;
  summary: {
    pending: number;
    claimed: number;
    dead: number;
    waitingRetry: number;
  };
};

export function poolHeatmap(state: ClusterState): PoolCell[] {
  const byAgent = new Map<string, PoolCell>();
  for (const w of state.workers) {
    if (w.status === "retired") continue;
    const cur = byAgent.get(w.agent) ?? {
      agent: w.agent,
      idle: 0,
      running: 0,
      failed: 0,
      cordoned: 0,
      total: 0,
    };
    cur.total += 1;
    if (w.cordoned) cur.cordoned += 1;
    if (w.status === "idle") cur.idle += 1;
    else if (w.status === "running") cur.running += 1;
    else if (w.status === "failed") cur.failed += 1;
    byAgent.set(w.agent, cur);
  }
  return [...byAgent.values()].sort((a, b) => a.agent.localeCompare(b.agent));
}

export function queueDepthBars(state: ClusterState): QueueDepthBar[] {
  ensureQueue(state);
  const q = queueSummary(state);
  const fair = fairnessReport(state);
  const lanes: QueueDepthBar[] = [
    { key: "pending", count: q.pending, kind: "lane" },
    { key: "claimed", count: q.claimed, kind: "lane" },
    { key: "dead", count: q.dead, kind: "lane" },
    { key: "retry", count: q.waitingRetry, kind: "lane" },
  ];
  const agents = Object.entries(fair.pendingByAgent)
    .map(([key, count]) => ({ key, count, kind: "agent" as const }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
  return [...lanes, ...agents];
}

export function hygieneReport(state: ClusterState): HygieneReport {
  ensureQueue(state);
  if (!state.webhookSeen) state.webhookSeen = [];
  const q = queueSummary(state);
  return {
    pool: poolHeatmap(state),
    queueDepth: queueDepthBars(state),
    webhook: {
      seen: state.webhookSeen.length,
      duplicates: state.metrics?.webhookDuplicates ?? 0,
      cap: WEBHOOK_SEEN_MAX,
    },
    leasesReclaimedTotal: state.metrics?.leasesReclaimed ?? 0,
    summary: {
      pending: q.pending,
      claimed: q.claimed,
      dead: q.dead,
      waitingRetry: q.waitingRetry,
    },
  };
}

export type HygieneAction = "reclaim" | "gc" | "age" | "all";

export type HygieneRunResult = {
  action: HygieneAction;
  reclaimed: number;
  aged: number;
  gc?: WorktreeGcResult;
  report: HygieneReport;
};

/**
 * Run one or all hygiene hooks. GC requires a root path.
 */
export function runHygiene(
  state: ClusterState,
  action: HygieneAction,
  opts: { root?: string } = {},
): HygieneRunResult {
  let reclaimed = 0;
  let aged = 0;
  let gc: WorktreeGcResult | undefined;

  const doReclaim = action === "reclaim" || action === "all";
  const doAge = action === "age" || action === "all";
  const doGc = action === "gc" || action === "all";

  if (doReclaim) {
    reclaimed = reclaimExpiredLeases(state).reclaimed.length;
  }
  if (doAge) {
    aged = ageQueuePriorities(state);
  }
  if (doGc) {
    if (!opts.root) {
      throw new Error("gc requires root");
    }
    gc = gcOrphanWorktrees(opts.root, state);
  }

  return {
    action,
    reclaimed,
    aged,
    gc,
    report: hygieneReport(state),
  };
}
