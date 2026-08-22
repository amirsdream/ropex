/**
 * Queue latency + scheduling fairness — derived from queue timestamps and
 * worker lastTaskAt (LRU). Network-free; pure ClusterState reads.
 */

import { ensureQueue } from "./queue.js";
import type { ClusterState, QueuedTask, Worker } from "./types.js";

export type LatencyStats = {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
};

export type WorkerFairness = {
  workerId: string;
  agent: string;
  claims: number;
  lastTaskAt?: string;
  idleSkewMs: number;
};

export type FairnessReport = {
  at: string;
  claimWait: LatencyStats;
  runDuration: LatencyStats;
  /** Max lastTaskAt age gap among idle workers of the busiest agent (0 = even). */
  maxIdleSkewMs: number;
  /** Coefficient of variation of claim counts across live workers (0 = even). */
  claimCountCv: number;
  workers: WorkerFairness[];
  pendingByAgent: Record<string, number>;
};

function parseMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : undefined;
}

/** Inclusive percentile on a sorted copy (nearest-rank). */
export function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = Math.ceil((p / 100) * sortedAsc.length) - 1;
  const i = Math.min(sortedAsc.length - 1, Math.max(0, rank));
  return sortedAsc[i];
}

export function latencyStats(samples: number[]): LatencyStats {
  if (!samples.length) {
    return { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, meanMs: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1],
    meanMs: Math.round(sum / sorted.length),
  };
}

export function claimWaitSamples(queue: QueuedTask[]): number[] {
  const out: number[] = [];
  for (const q of queue) {
    const enq = parseMs(q.enqueuedAt);
    const claim = parseMs(q.claimedAt);
    if (enq === undefined || claim === undefined) continue;
    const d = claim - enq;
    if (d >= 0) out.push(d);
  }
  return out;
}

export function runDurationSamples(queue: QueuedTask[]): number[] {
  const out: number[] = [];
  for (const q of queue) {
    if (q.status !== "done" && q.status !== "dead" && q.status !== "failed") continue;
    const claim = parseMs(q.claimedAt);
    const fin = parseMs(q.finishedAt);
    if (claim === undefined || fin === undefined) continue;
    const d = fin - claim;
    if (d >= 0) out.push(d);
  }
  return out;
}

function coeffOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.round((Math.sqrt(variance) / mean) * 1000) / 1000;
}

/**
 * Fairness + latency report. `now` fixes idle skew calculation for tests.
 */
export function fairnessReport(
  state: ClusterState,
  opts: { now?: number } = {},
): FairnessReport {
  ensureQueue(state);
  const now = opts.now ?? Date.now();
  const queue = state.queue ?? [];
  const live = state.workers.filter((w) => w.status !== "retired");

  const claimsByWorker = new Map<string, number>();
  for (const q of queue) {
    if (!q.workerId) continue;
    if (q.status === "claimed" || q.status === "done" || q.claimedAt) {
      claimsByWorker.set(q.workerId, (claimsByWorker.get(q.workerId) ?? 0) + 1);
    }
  }

  const byAgent = new Map<string, Worker[]>();
  for (const w of live) {
    const list = byAgent.get(w.agent) ?? [];
    list.push(w);
    byAgent.set(w.agent, list);
  }

  let maxIdleSkewMs = 0;
  const workers: WorkerFairness[] = live.map((w) => {
    const peers = byAgent.get(w.agent) ?? [w];
    const ages = peers.map((p) => {
      const t = parseMs(p.lastTaskAt);
      return t === undefined ? now : now - t;
    });
    const skew = ages.length ? Math.max(...ages) - Math.min(...ages) : 0;
    if (skew > maxIdleSkewMs) maxIdleSkewMs = skew;
    const last = parseMs(w.lastTaskAt);
    return {
      workerId: w.id,
      agent: w.agent,
      claims: claimsByWorker.get(w.id) ?? 0,
      lastTaskAt: w.lastTaskAt,
      idleSkewMs: last === undefined ? 0 : now - last,
    };
  });

  const pendingByAgent: Record<string, number> = {};
  for (const q of queue) {
    if (q.status !== "pending") continue;
    const a = q.task.agent;
    pendingByAgent[a] = (pendingByAgent[a] ?? 0) + 1;
  }

  const claimCounts = live.map((w) => claimsByWorker.get(w.id) ?? 0);

  return {
    at: new Date(now).toISOString(),
    claimWait: latencyStats(claimWaitSamples(queue)),
    runDuration: latencyStats(runDurationSamples(queue)),
    maxIdleSkewMs,
    claimCountCv: coeffOfVariation(claimCounts),
    workers: workers.sort((a, b) => b.claims - a.claims || a.workerId.localeCompare(b.workerId)),
    pendingByAgent,
  };
}

export function formatFairnessReport(report: FairnessReport): string {
  const lines: string[] = [];
  const w = report.claimWait;
  const r = report.runDuration;
  lines.push(
    `fairness  claimWait p50=${w.p50Ms}ms p95=${w.p95Ms}ms max=${w.maxMs}ms n=${w.count}`,
  );
  lines.push(
    `  runDuration p50=${r.p50Ms}ms p95=${r.p95Ms}ms max=${r.maxMs}ms n=${r.count}`,
  );
  lines.push(`  maxIdleSkewMs=${report.maxIdleSkewMs}  claimCountCv=${report.claimCountCv}`);
  const pending = Object.entries(report.pendingByAgent);
  if (pending.length) {
    lines.push(
      `  pendingByAgent ${pending.map(([a, n]) => `${a}=${n}`).join(" ")}`,
    );
  }
  for (const row of report.workers.slice(0, 20)) {
    lines.push(
      `  ${row.workerId} claims=${row.claims} idleSkewMs=${row.idleSkewMs}`,
    );
  }
  if (report.workers.length > 20) {
    lines.push(`  … ${report.workers.length - 20} more workers`);
  }
  return lines.join("\n");
}
