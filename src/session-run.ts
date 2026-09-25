/**
 * Runs inside the session container. Hermes loads memory, DeepSeek Harness
 * executes each stage in the shared work directory, learn writes memory back,
 * and the result file is what the control plane keeps.
 */

import { emptyState } from "./controller.js";
import { drainPipelineStages } from "./executor.js";
import { expandWorkers } from "./runtime.js";
import type { SessionRequest, SessionResult } from "./session.js";

export async function executeSessionRequest(
  request: SessionRequest,
  root: string,
): Promise<SessionResult> {
  const state = emptyState("session");
  state.desired = request.desired;
  state.policies = request.policies ?? [];
  state.memory = request.memory ?? [];
  state.skills = request.skills ?? [];
  state.skillRegistry = request.skillRegistry ?? [];
  state.workers = request.desired.flatMap((agent) => expandWorkers(agent, { root }));
  state.pipelines = [request.pipeline];
  const pipeline = state.pipelines[0];

  await drainPipelineStages(state, pipeline, { root });

  const ok = pipeline.status === "done";
  return {
    ok,
    pipeline,
    memory: state.memory,
    skills: state.skills,
    skillRegistry: state.skillRegistry,
    trajectories: state.trajectories ?? [],
    error: ok ? undefined : pipeline.result?.error ?? pipeline.stages.find((s) => s.error)?.error,
  };
}
