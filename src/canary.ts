/**
 * Canary / rolling digest rollout helpers.
 * Immutable workers still roll via retire+create; canary limits how many mismatch
 * slots advance per reconcile so a bad image cannot take the whole fleet at once.
 */

import type { ReconcilePlan, Worker } from "./types.js";

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
