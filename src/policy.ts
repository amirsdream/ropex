/**
 * Policy dry-run — report admission decisions without mutating cluster state.
 */

import { admitCalls, admitTask, effectivePermissions } from "./admission.js";
import { createHermes } from "./hermes.js";
import type { ClusterState, Task } from "./types.js";

export type PolicyDryRunReport = {
  task: Task;
  taskAdmission: ReturnType<typeof admitTask>;
  permissions: ReturnType<typeof effectivePermissions>;
  plannedCalls: Array<{ name: string }>;
  callAdmission: ReturnType<typeof admitCalls>;
};

/**
 * Plan with Hermes (read-only memory snapshot) and admit without enqueue/execute.
 */
export function policyDryRun(state: ClusterState, task: Task): PolicyDryRunReport {
  const agent = state.desired.find((a) => a.metadata.name === task.agent);
  if (!agent) {
    throw new Error(`desired agent missing: ${task.agent}`);
  }
  const hermes = createHermes(agent.spec, {
    worker: { id: `${task.agent}:dry-run`, agent: task.agent },
    skills: [...agent.spec.hermes.skills],
  });
  const planned = hermes.plan(task);
  const taskAdmission = admitTask(state, task);
  const callAdmission = admitCalls(state.policies, planned.calls, state, {
    taskId: task.id,
    agent: task.agent,
  });
  return {
    task,
    taskAdmission,
    permissions: effectivePermissions(state.policies),
    plannedCalls: planned.calls.map((c) => ({ name: c.name })),
    callAdmission,
  };
}
