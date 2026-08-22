/**
 * Control-plane tick — one scheduled heartbeat for the orchestrator.
 * Reclaim → optional gc/age/clone → due GitRepo sync → drain → autoscale.
 * Network-free; suitable for cron / `ropex tick` / watch loops.
 */

import { planAutoscale, type AutoscalePlan } from "./autoscale.js";
import { recordAudit } from "./audit.js";
import { cloneAllGitRepos, type CloneResult } from "./clone.js";
import { saveState } from "./controller.js";
import { compactJournal, type CompactJournalResult } from "./journal.js";
import { syncDueGitRepos, type MultiRepoSyncResult } from "./gitrepo.js";
import { ageQueuePriorities, queueSummary, reclaimExpiredLeases } from "./queue.js";
import { drainQueue, type DrainOptions } from "./scheduler.js";
import { gcOrphanWorktrees, type WorktreeGcResult } from "./worktree.js";
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
  /** Run orphan worktree GC (default false). */
  gc?: boolean;
  /** Age pending priorities (default false). */
  age?: boolean;
  /** Run clone dry-run progress stamp (default false). */
  clone?: boolean;
  /** Compact delivery journal to newest N (omit to skip). */
  compactJournalKeep?: number;
};

export type TickResult = {
  at: string;
  reclaimed: QueuedTask[];
  sync: MultiRepoSyncResult | null;
  drained: RunResult[];
  autoscale: AutoscalePlan | null;
  queue: ReturnType<typeof queueSummary>;
  gc: WorktreeGcResult | null;
  aged: number;
  clones: CloneResult[] | null;
  journal: CompactJournalResult | null;
  paused: boolean;
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

  let gc: WorktreeGcResult | null = null;
  if (opts.gc) {
    gc = gcOrphanWorktrees(root, state);
  }

  let aged = 0;
  if (opts.age) {
    aged = ageQueuePriorities(state, { now });
  }

  let clones: CloneResult[] | null = null;
  if (opts.clone && (state.gitRepos?.length ?? 0) > 0) {
    clones = cloneAllGitRepos(root, state, { dryRun: true });
  }

  let journal: CompactJournalResult | null = null;
  if (opts.compactJournalKeep !== undefined) {
    journal = compactJournal(state, { keep: opts.compactJournalKeep });
  }

  let sync: MultiRepoSyncResult | null = null;
  if (!opts.skipSync && (state.gitRepos?.length ?? 0) > 0) {
    sync = syncDueGitRepos(root, state, { now, persist: false });
    if (sync.synced) {
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
  if (!opts.skipDrain && !state.queuePaused) {
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
    message: `tick reclaim=${reclaimed.length} drain=${drained.length} sync=${sync?.synced ? 1 : 0} gc=${gc?.removed.length ?? 0} age=${aged}`,
    meta: {
      reclaimed: reclaimed.length,
      drained: drained.length,
      synced: Boolean(sync?.synced),
      autoscale: autoscale?.recommendations.length ?? 0,
      gcRemoved: gc?.removed.length ?? 0,
      aged,
      paused: Boolean(state.queuePaused),
      journalRemoved: journal?.removed ?? 0,
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
    gc,
    aged,
    clones,
    journal,
    paused: Boolean(state.queuePaused),
  };
}
