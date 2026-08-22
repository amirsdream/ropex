/**
 * Canary / rolling digest rollout helpers.
 * Immutable workers still roll via retire+create; canary limits how many mismatch
 * slots advance per reconcile so a bad image cannot take the whole fleet at once.
 */

import { buildAgentImage } from "./image.js";
import type { ClusterState, ReconcilePlan, Worker } from "./types.js";

export type RolloutStrategy = "recreate" | "canary";

export type RolloutOptions = {
  /** Default recreate = roll all digest mismatches in one reconcile. */
  strategy?: RolloutStrategy;
  /** Max digest rolls per agent (or fleet) per reconcile when strategy=canary (default 1). */
  canaryCount?: number;
};

export type DigestMismatch = {
  prev: Worker;
  next: Worker;
};

/**
 * Partition digest mismatches into "roll now" vs "hold" under a canary budget.
 * Groups by agent name; within each group sorts by replica ascending.
 */
export function selectCanaryRolls(
  mismatches: DigestMismatch[],
  opts: RolloutOptions = {},
): { roll: DigestMismatch[]; hold: DigestMismatch[] } {
  const strategy = opts.strategy ?? "recreate";
  const canaryCount = Math.max(1, opts.canaryCount ?? 1);
  if (strategy !== "canary" || !mismatches.length) {
    return { roll: mismatches, hold: [] };
  }

  const byAgent = new Map<string, DigestMismatch[]>();
  for (const m of mismatches) {
    const list = byAgent.get(m.next.agent) ?? [];
    list.push(m);
    byAgent.set(m.next.agent, list);
  }

  const roll: DigestMismatch[] = [];
  const hold: DigestMismatch[] = [];
  for (const list of byAgent.values()) {
    list.sort((a, b) => a.next.replica - b.next.replica);
    roll.push(...list.slice(0, canaryCount));
    hold.push(...list.slice(canaryCount));
  }
  return { roll, hold };
}

export function summarizeRollout(plan: ReconcilePlan, held: number): string {
  return `create=${plan.create.length} retire=${plan.retire.length} held=${held}`;
}

export type CanaryAgentProgress = {
  agent: string;
  desiredDigest: string;
  matched: number;
  mismatched: number;
  total: number;
  pctMatched: number;
};

export type CanaryProgressReport = {
  ok: boolean;
  agents: CanaryAgentProgress[];
  matched: number;
  mismatched: number;
  total: number;
  pctMatched: number;
};

/**
 * Live vs desired digest coverage — how far a canary / roll has progressed.
 */
export function canaryProgress(state: ClusterState): CanaryProgressReport {
  const agents: CanaryAgentProgress[] = [];
  let matched = 0;
  let mismatched = 0;
  for (const desired of state.desired ?? []) {
    const dig = buildAgentImage(desired).digest;
    const live = (state.workers ?? []).filter(
      (w) => w.agent === desired.metadata.name && w.status !== "retired",
    );
    let m = 0;
    let mm = 0;
    for (const w of live) {
      if (w.imageDigest === dig) m += 1;
      else mm += 1;
    }
    matched += m;
    mismatched += mm;
    const total = m + mm;
    agents.push({
      agent: desired.metadata.name,
      desiredDigest: dig,
      matched: m,
      mismatched: mm,
      total,
      pctMatched: total ? Math.round((100 * m) / total) : 100,
    });
  }
  const total = matched + mismatched;
  return {
    ok: mismatched === 0,
    agents,
    matched,
    mismatched,
    total,
    pctMatched: total ? Math.round((100 * matched) / total) : 100,
  };
}
