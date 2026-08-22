import { admitCalls } from "./admission.js";
import { requestApprovals } from "./approval.js";
import { bootDsh } from "./dsh.js";
import { createHermes } from "./hermes.js";
import { buildAgentImage, type ImageResolveOptions } from "./image.js";
import { recordDelivery } from "./journal.js";
import { SharedMemoryStore } from "./memory.js";
import { registerSkill, skillsForAgent } from "./skills.js";
import { recordTrajectory } from "./trajectory.js";
import { composeWorkflow } from "./workflow.js";
import { ensureWorktree } from "./worktree.js";
import type {
  ClusterState,
  DesiredAgent,
  Policy,
  RunResult,
  Task,
  TrajectoryStep,
  Worker,
} from "./types.js";

export type RunTaskOptions = ImageResolveOptions & {
  /** Override worktree root (defaults to opts.root or cwd). */
  worktreeRoot?: string;
};

export async function runTask(
  state: ClusterState,
  worker: Worker,
  task: Task,
  opts: RunTaskOptions = {},
): Promise<RunResult> {
  const agent = state.desired.find((a) => a.metadata.name === worker.agent);
  if (!agent) {
    throw new Error(`desired agent missing: ${worker.agent}`);
  }

  const workflow = composeWorkflow(agent, opts);
  if (workflow.imageDigest !== worker.imageDigest) {
    throw new Error(
      `worker ${worker.id} image ${worker.imageDigest} drift from desired ${workflow.imageDigest}; reconcile first`,
    );
  }

  const root = opts.worktreeRoot ?? opts.root ?? process.cwd();
  const worktree = worker.worktree ?? ensureWorktree(root, worker);
  worker.worktree = worktree;

  const policy = effectivePolicy(state.policies);
  const store = SharedMemoryStore.fromState(state);
  const registrySkills = skillsForAgent(state, worker.agent).map((s) => s.name);
  const hermes = createHermes(agent.spec, {
    store,
    worker,
    skills: [
      ...workflow.brain.skills,
      ...worker.skills,
      ...registrySkills,
      ...state.skills.filter((s) => s.agent === worker.agent).map((s) => s.name),
    ],
  });

  // DeepSeek adapter (simulated profile pack; live stub until @deepseek-ai/dsh)
  const dsh = await bootDsh(agent.spec, {
    ...policy,
    hermes,
    memory: hermes.port,
    cwd: worktree,
    backend: "simulated",
  });

  // compose + plan (Hermes)
  const planned = hermes.plan(task);

  // policy admission — deny fails closed; approval-gated tools pause for approve/reject
  const admission = admitCalls(state.policies, planned.calls, state, {
    taskId: task.id,
    agent: worker.agent,
  });
  if (admission.needsApproval.length) {
    requestApprovals(state, {
      taskId: task.id,
      agent: worker.agent,
      workerId: worker.id,
      tools: admission.needsApproval.map((n) => ({
        name: n.name,
        reason: n.reason,
        input: n.input,
      })),
    });
  }
  const { steps: execSteps } = await dsh.execute({
    thoughts: planned.thoughts,
    calls: admission.allowed,
  });

  const gatedSteps: TrajectoryStep[] = [
    ...admission.denied.map((d) => ({
      thought: "policy admission",
      calls: [{ plugin: "admission", name: d.name, input: { status: "deny" } }],
      observation: d.reason,
    })),
    ...admission.needsApproval.map((d) => ({
      thought: "policy admission",
      calls: [{ plugin: "admission", name: d.name, input: { status: "approval" } }],
      observation: d.reason,
    })),
    ...execSteps,
  ];
  const steps = gatedSteps;

  // deliver (DeepSeek)
  let delivery: RunResult["delivery"];
  try {
    const d = dsh.kernel.context().get<{
      kind: "comment" | "pull_request" | "check";
      send: (body: string) => { kind: "comment" | "pull_request" | "check"; body: string };
    }>("delivery");
    delivery = d.send(summarize(task, steps));
  } catch {
    delivery = undefined;
  }

  // learn (Hermes) — runtime volume; does not mutate the image digest
  const learned = hermes.learn(task, steps);
  if (learned) {
    state.skills.push(learned);
    worker.skills = [...new Set([...worker.skills, learned.name])];
    registerSkill(state, learned, `via ${dsh.pack.profile} pack`);
  }
  hermes.remember({
    id: `${task.id}-done`,
    agent: worker.agent,
    text: task.prompt,
    at: new Date().toISOString(),
    scope: hermes.port.context.policy.write,
    sourceWorker: worker.id,
    fleet: worker.fleet,
    tags: ["task-complete"],
  });

  const result: RunResult = {
    task,
    worker,
    imageDigest: worker.imageDigest,
    workflow: workflow.stages.map((s) => ({ id: s.id, owner: s.owner })),
    plan: planned.thoughts,
    steps,
    delivery,
    learned,
    output: summarize(task, steps),
    worktree,
  };
  recordDelivery(state, result);
  recordTrajectory(state, result);

  worker.status = "idle";
  worker.lastTaskAt = new Date().toISOString();
  return result;
}

export function workerFromDesired(
  agent: DesiredAgent,
  replica: number,
  opts: ImageResolveOptions = {},
): Worker {
  const image = buildAgentImage(agent, opts);
  return {
    id: `${agent.metadata.name}:${replica}`,
    agent: agent.metadata.name,
    fleet: agent.derivedFrom?.fleet,
    replica,
    status: "pending",
    imageDigest: image.digest,
    harness: image.harness.profile,
    plugins: [...image.harness.plugins],
    skills: [...image.hermes.skills],
    model: image.harness.model ?? "deepseek-v4-flash",
  };
}

export function expandWorkers(agent: DesiredAgent, opts: ImageResolveOptions = {}): Worker[] {
  const n = agent.derivedFrom ? 1 : agent.spec.replicas;
  return Array.from({ length: n }, (_, i) => workerFromDesired(agent, i, opts));
}

function effectivePolicy(policies: Policy[]): { deny: string[]; requireApproval: string[] } {
  const deny = new Set<string>();
  const requireApproval = new Set<string>();
  for (const p of policies) {
    for (const d of p.spec.permissions.deny) deny.add(d);
    for (const r of p.spec.permissions.requireApproval) requireApproval.add(r);
  }
  return { deny: [...deny], requireApproval: [...requireApproval] };
}

function summarize(task: Task, steps: TrajectoryStep[]): string {
  const tools = steps.flatMap((s) => s.calls.map((c) => c.name)).join(" → ");
  return `Ropex finished "${task.prompt}" via ${tools || "no-op"}.`;
}
