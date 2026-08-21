/**
 * Delivery journal — append-only audit of comment / check / PR deliveries.
 * Keeps GitHub-shaped delivery native while giving the control plane a trail.
 */

import type { ClusterState, DeliveryRecord, GithubSpec, RunResult } from "./types.js";

export function ensureJournal(state: ClusterState): void {
  if (!state.deliveries) state.deliveries = [];
}

export function recordDelivery(
  state: ClusterState,
  result: Pick<RunResult, "task" | "worker" | "imageDigest" | "delivery">,
): DeliveryRecord | undefined {
  ensureJournal(state);
  if (!result.delivery) return undefined;
  const rec: DeliveryRecord = {
    id: `del-${result.task.id}-${Date.now()}`,
    at: new Date().toISOString(),
    kind: result.delivery.kind,
    body: result.delivery.body,
    workerId: result.worker.id,
    agent: result.worker.agent,
    taskId: result.task.id,
    imageDigest: result.imageDigest,
    repo: result.task.event?.repo,
    number: result.task.event?.number,
  };
  state.deliveries.push(rec);
  return rec;
}

export function deliveriesFor(
  state: ClusterState,
  filter: { agent?: string; repo?: string; kind?: GithubSpec["deliver"]; limit?: number } = {},
): DeliveryRecord[] {
  ensureJournal(state);
  let rows = [...state.deliveries];
  if (filter.agent) rows = rows.filter((d) => d.agent === filter.agent);
  if (filter.repo) rows = rows.filter((d) => d.repo === filter.repo);
  if (filter.kind) rows = rows.filter((d) => d.kind === filter.kind);
  rows.sort((a, b) => (a.at < b.at ? 1 : -1));
  if (filter.limit) rows = rows.slice(0, filter.limit);
  return rows;
}

/**
 * Replay a prior delivery into the journal (audit / re-notify without re-running the task).
 * Marks body with [replay] so git-native trails stay honest.
 */
export function replayDelivery(
  state: ClusterState,
  deliveryId: string,
): DeliveryRecord | undefined {
  ensureJournal(state);
  const orig = state.deliveries.find((d) => d.id === deliveryId);
  if (!orig) return undefined;
  const replay: DeliveryRecord = {
    ...orig,
    id: `replay-${orig.id}-${Date.now()}`,
    at: new Date().toISOString(),
    body: orig.body.includes("[replay]") ? orig.body : `${orig.body} [replay]`,
  };
  state.deliveries.push(replay);
  return replay;
}
