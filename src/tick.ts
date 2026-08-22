/**
 * Control-plane tick — one scheduled heartbeat for the orchestrator.
 * Reclaim expired leases → due GitRepo sync → drain queue → autoscale recommend.
 * Network-free; suitable for cron / `ropex tick` / watch loops.
 */

import { planAutoscale, type AutoscalePlan } from "./autoscale.js";
import { recordAudit } from "./audit.js";
import { saveState } from "./controller.js";
import { syncDueGitRepos, type MultiRepoSyncResult } from "./gitrepo.js";
import { queueSummary, reclaimExpiredLeases } from "./queue.js";
import { drainQueue, type DrainOptions } from "./scheduler.js";
import type { ClusterState, QueuedTask, RunResult } from "./types.js";

export type TickOptions = DrainOptions & {
  /** Skip GitRepo due-sync (default false). */
  skipSync?: boolean;
  /** Skip drain (default false). */
  skipDrain?: boolean;
  /** Skip autoscale recommendation (default false). */
  skipAutoscale?: boolean;
  /** Persist state after tick (default true). */
  persist?: boolean;
  now?: number;
};

export type TickResult = {
  at: string;
  reclaimed: QueuedTask[];
  sync: MultiRepoSyncResult | null;
  drained: RunResult[];
  autoscale: AutoscalePlan | null;
  queue: ReturnType<typeof queueSummary>;
};

/**
 * Run one control-plane heartbeat against live cluster state.
 */
export async function controlPlaneTick(
  root: string,
  state: ClusterState,
  opts: TickOptions = {},
): Promise<TickResult> {
  const now = opts.now ?? Date.now();
  const at = new Date(now).toISOString();

  const { reclaimed } = reclaimExpiredLeases(state, {
    now,
    maxAttempts: opts.maxAttempts,
  });

  let sync: MultiRepoSyncResult | null = null;
  if (!opts.skipSync && (state.gitRepos?.length ?? 0) > 0) {
    sync = syncDueGitRepos(root, state, { now, persist: false });
    if (sync.synced) {
      // Adopt synced desired/workers into the live state object.
      Object.assign(state, {
        desired: sync.state.desired,
        workers: sync.state.workers,
        gitRepos: sync.state.gitRepos,
        policies: sync.state.policies,
        revision: sync.state.revision,
        source: sync.state.source,
        gitRepoStatus: sync.state.gitRepoStatus,
        lastReconcile: sync.state.lastReconcile,
        audit: sync.state.audit,
      });
    }
  }

  let drained: RunResult[] = [];
  if (!opts.skipDrain) {
    drained = await drainQueue(state, {
      root,
      limit: opts.limit,
      concurrency: opts.concurrency,
      maxAttempts: opts.maxAttempts,
      leaseMs: opts.leaseMs,
    });
  }

  const autoscale = opts.skipAutoscale ? null : planAutoscale(state, { now, audit: true });

  recordAudit(state, {
    kind: "info",
    message: `tick reclaim=${reclaimed.length} drain=${drained.length} sync=${sync?.synced ? 1 : 0}`,
    meta: {
      reclaimed: reclaimed.length,
      drained: drained.length,
      synced: Boolean(sync?.synced),
      autoscale: autoscale?.recommendations.length ?? 0,
    },
    at,
  });

  if (opts.persist !== false) saveState(root, state);

  return {
    at,
    reclaimed,
    sync,
    drained,
    autoscale,
    queue: queueSummary(state),
  };
}
