import { createHarness, type HarnessLoop } from "./harness.js";
import { createHermes } from "./hermes.js";
import { buildAgentImage, type ImageResolveOptions } from "./image.js";
import { SharedMemoryStore } from "./memory.js";
import { composeWorkflow } from "./workflow.js";
import type {
  ClusterState,
  DesiredAgent,
  Policy,
  RunResult,
  Task,
  TrajectoryStep,
  Worker,
} from "./types.js";

export async function runTask(
  state: ClusterState,
  worker: Worker,
  task: Task,
  opts: ImageResolveOptions = {},
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

  const policy = effectivePolicy(state.policies);
  const store = SharedMemoryStore.fromState(state);
  const hermes = createHermes(agent.spec, {
    store,
    worker,
    skills: [
      ...workflow.brain.skills,
      ...worker.skills,
      ...state.skills.filter((s) => s.agent === worker.agent).map((s) => s.name),
    ],
  });
  const kernel = await createHarness(agent.spec, {
    ...policy,
    hermes,
    memory: hermes.port,
  });

  // compose + plan (Hermes)
  const planned = hermes.plan(task);

  // execute (DeepSeek)
  const loop = kernel.context().get<HarnessLoop>("loop");
  const observations = await loop.run(planned.calls);

  const steps: TrajectoryStep[] = planned.calls.map((call, i) => ({
    thought: planned.thoughts[Math.min(i, planned.thoughts.length - 1)] ?? "",
    calls: [{ plugin: "tools", name: call.name, input: call.input }],
    observation: observations[i] ?? "",
  }));

  // deliver (DeepSeek)
  let delivery: RunResult["delivery"];
  try {
    const d = kernel.context().get<{
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

  worker.status = "idle";
  return {
    task,
    worker,
    imageDigest: worker.imageDigest,
    workflow: workflow.stages.map((s) => ({ id: s.id, owner: s.owner })),
    plan: planned.thoughts,
    steps,
    delivery,
    learned,
    output: summarize(task, steps),
  };
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
