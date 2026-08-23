/**
 * Trajectory store — persist Hermes plans + DeepSeek steps for export/learning.
 */

import { createHermes } from "./hermes.js";
import { registerSkill } from "./skills.js";
import type { ClusterState, LearnedSkill, RunResult, SkillRecord, TrajectoryRecord } from "./types.js";

export function ensureTrajectories(state: ClusterState): void {
  if (!state.trajectories) state.trajectories = [];
}

export function recordTrajectory(state: ClusterState, result: RunResult): TrajectoryRecord {
  ensureTrajectories(state);
  const stages = result.workflow.map((s) => s.id) as TrajectoryRecord["stages"];
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
    stages,
  };
  state.trajectories.push(rec);
  if (state.trajectories.length > 500) {
    state.trajectories = state.trajectories.slice(-500);
  }
  return rec;
}

/** Count how often each workflow stage appears on stored trajectories. */
export function workflowStageCounts(state: ClusterState): Record<string, number> {
  ensureTrajectories(state);
  const counts: Record<string, number> = {
    compose: 0,
    plan: 0,
    execute: 0,
    deliver: 0,
    learn: 0,
  };
  for (const t of state.trajectories) {
    const stages = t.stages?.length
      ? t.stages
      : inferStagesFromTrajectory(t);
    for (const s of stages) counts[s] = (counts[s] ?? 0) + 1;
  }
  return counts;
}

function inferStagesFromTrajectory(t: TrajectoryRecord): string[] {
  const out: string[] = ["compose"];
  if (t.plan?.length) out.push("plan");
  if (t.steps?.length) out.push("execute");
  if (t.output) out.push("deliver");
  return out;
}

export function getTrajectory(state: ClusterState, id: string): TrajectoryRecord | undefined {
  ensureTrajectories(state);
  return state.trajectories.find((t) => t.id === id);
}

export function trajectoriesFor(
  state: ClusterState,
  filter: { agent?: string; taskId?: string; id?: string; limit?: number } = {},
): TrajectoryRecord[] {
  ensureTrajectories(state);
  if (filter.id) {
    const one = getTrajectory(state, filter.id);
    return one ? [one] : [];
  }
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

/**
 * Replay a stored trajectory through Hermes learn() and register the skill.
 * Distills skills from past runs without re-executing tools.
 */
export function learnFromTrajectory(
  state: ClusterState,
  trajectoryId: string,
): { learned?: LearnedSkill; skill?: SkillRecord; reason?: string } {
  ensureTrajectories(state);
  const traj = state.trajectories.find((t) => t.id === trajectoryId);
  if (!traj) return { reason: `trajectory not found: ${trajectoryId}` };

  const agent = state.desired.find((a) => a.metadata.name === traj.agent);
  if (!agent) return { reason: `desired agent missing: ${traj.agent}` };
  if (!agent.spec.hermes.learning) return { reason: "learning disabled for agent" };

  const hermes = createHermes(agent.spec, {
    worker: { id: traj.workerId, agent: traj.agent },
    skills: [
      ...agent.spec.hermes.skills,
      ...state.skills.filter((s) => s.agent === traj.agent).map((s) => s.name),
    ],
  });

  const prompt =
    traj.plan.find((p) => p.startsWith("task:"))?.replace(/^task:\s*/, "") ?? traj.output;
  const learned = hermes.learn({ id: traj.taskId, agent: traj.agent, prompt }, traj.steps);
  if (!learned) return { reason: "no new skill extracted (already known or too short)" };

  state.skills.push(learned);
  const skill = registerSkill(state, learned, `replayed from ${traj.id}`);
  const worker = state.workers.find((w) => w.id === traj.workerId && w.status !== "retired");
  if (worker) {
    worker.skills = [...new Set([...worker.skills, learned.name])];
  }
  return { learned, skill };
}
