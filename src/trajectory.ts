/**
 * Trajectory store — persist Hermes plans + DeepSeek steps for export/learning.
 */

import type { ClusterState, RunResult, TrajectoryRecord } from "./types.js";

export function ensureTrajectories(state: ClusterState): void {
  if (!state.trajectories) state.trajectories = [];
}

export function recordTrajectory(state: ClusterState, result: RunResult): TrajectoryRecord {
  ensureTrajectories(state);
  const rec: TrajectoryRecord = {
    id: `traj-${result.task.id}-${Date.now()}`,
    at: new Date().toISOString(),
    taskId: result.task.id,
    agent: result.worker.agent,
    workerId: result.worker.id,
    imageDigest: result.imageDigest,
    plan: [...result.plan],
    steps: result.steps.map((s) => ({
      thought: s.thought,
      calls: s.calls.map((c) => ({ ...c, input: { ...c.input } })),
      observation: s.observation,
    })),
    output: result.output,
  };
  state.trajectories.push(rec);
  // Cap history so state.json stays bounded.
  if (state.trajectories.length > 500) {
    state.trajectories = state.trajectories.slice(-500);
  }
  return rec;
}

export function trajectoriesFor(
  state: ClusterState,
  filter: { agent?: string; taskId?: string; limit?: number } = {},
): TrajectoryRecord[] {
  ensureTrajectories(state);
  let rows = [...state.trajectories];
  if (filter.agent) rows = rows.filter((t) => t.agent === filter.agent);
  if (filter.taskId) rows = rows.filter((t) => t.taskId === filter.taskId);
  rows.sort((a, b) => (a.at < b.at ? 1 : -1));
  if (filter.limit) rows = rows.slice(0, filter.limit);
  return rows;
}

/** JSONL export — one trajectory per line. */
export function exportTrajectoriesJsonl(
  state: ClusterState,
  filter: { agent?: string; limit?: number } = {},
): string {
  return trajectoriesFor(state, filter)
    .map((t) => JSON.stringify(t))
    .join("\n");
}
