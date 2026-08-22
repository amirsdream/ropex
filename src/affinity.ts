/**
 * Sticky worker affinity — prefer the last successful worker for a key (agent/repo)
 * until TTL expires. Soft preference only; placement/digest/cordon still gate claims.
 */

import type { AffinityBinding, ClusterState, Task } from "./types.js";

export const DEFAULT_AFFINITY_TTL_MS = 30 * 60_000;
export const AFFINITY_MAX = 2_000;

export function ensureAffinity(state: ClusterState): void {
  if (!state.affinity) state.affinity = [];
}

export function affinityKey(task: Task): string {
  const repo = task.event?.repo ?? "";
  return `${task.agent}:${repo || "_"}`;
}

export function pruneAffinity(state: ClusterState, now = Date.now()): number {
  ensureAffinity(state);
  const before = state.affinity!.length;
  state.affinity = state.affinity!.filter((a) => Date.parse(a.expiresAt) > now);
  if (state.affinity.length > AFFINITY_MAX) {
    state.affinity = state.affinity.slice(-AFFINITY_MAX);
  }
  return before - state.affinity.length;
}

export function lookupAffinity(
  state: ClusterState,
  task: Task,
  now = Date.now(),
): AffinityBinding | undefined {
  ensureAffinity(state);
  pruneAffinity(state, now);
  const key = affinityKey(task);
  return state.affinity!.find((a) => a.key === key && Date.parse(a.expiresAt) > now);
}

export function rememberAffinity(
  state: ClusterState,
  task: Task,
  workerId: string,
  opts: { now?: number; ttlMs?: number } = {},
): AffinityBinding {
  ensureAffinity(state);
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_AFFINITY_TTL_MS;
  pruneAffinity(state, now);
  const key = affinityKey(task);
  const binding: AffinityBinding = {
    key,
    workerId,
    agent: task.agent,
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  const idx = state.affinity!.findIndex((a) => a.key === key);
  if (idx >= 0) state.affinity![idx] = binding;
  else state.affinity!.push(binding);
  return binding;
}
