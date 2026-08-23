/**
 * Ropex executor API — engine-neutral pipeline runs for external UIs (Magentic, etc.).
 * Repos stay independent: contract is HTTP + SSE documented in docs/executor-api.md.
 */

import { randomUUID } from "node:crypto";
import { recordAudit } from "./audit.js";
import { SharedMemoryStore, memoryContextFor } from "./memory.js";
import { enqueueTask } from "./queue.js";
import { drainQueue, type DrainOptions } from "./scheduler.js";
import { planPipeline, type PipelineStagePlan } from "./pipeline.js";
import type { TaskProgress } from "./runtime.js";
import type { ClusterState, PipelineRun, PipelineStageRun, Task } from "./types.js";

export type ExecutorEventKind =
  | "pipeline.start"
  | "pipeline.plan"
  | "stage.start"
  | "stage.log"
  | "stage.complete"
  | "stage.failed"
  | "pipeline.complete"
  | "pipeline.error"
  | "pipeline.end";

export type ExecutorEvent = {
  pipelineId: string;
  at: string;
  kind: ExecutorEventKind;
  stageId?: string;
  agent?: string;
  taskId?: string;
  workerId?: string;
  message?: string;
  artifact?: string;
  meta?: Record<string, string | number | boolean | null>;
};

export type SubmitPipelineOptions = {
  prompt?: string;
  /** Drain an existing pipeline (async mode). */
  pipelineId?: string;
  action?: "submit" | "drain";
  stages?: PipelineStagePlan[];
  agents?: string[];
  drain?: boolean;
  concurrency?: number;
  root?: string;
};

export type SubmitPipelineResult = {
  pipeline: PipelineRun;
  drained?: number;
};

const MAX_EVENT_BUFFER = 400;
const MAX_PIPELINE_EVENTS = 120;
const MAX_PIPELINE_RUNS = 64;
const eventBuffer = new Map<string, ExecutorEvent[]>();

type SseSubscriber = {
  pipelineId: string;
  write: (chunk: string) => void;
  close: () => void;
};

const subscribers = new Set<SseSubscriber>();

function nowIso(): string {
  return new Date().toISOString();
}

function planAgentsMeta(stages: PipelineStageRun[]): Record<string, string | number | boolean | null>[] {
  return stages.map((s, i) => ({
    agent_id: s.taskId,
    role: s.role ?? s.id,
    agent: s.agent,
    stage_id: s.id,
    layer: i + 1,
    task: (s.basePrompt ?? s.prompt).slice(0, 300),
  }));
}

function persistEvent(state: ClusterState | undefined, event: ExecutorEvent): void {
  if (!state?.pipelines) return;
  const run = state.pipelines.find((p) => p.id === event.pipelineId);
  if (!run) return;
  if (!run.events) run.events = [];
  run.events.push(event);
  while (run.events.length > MAX_PIPELINE_EVENTS) run.events.shift();
}

function closePipelineSubscribers(pipelineId: string): void {
  for (const sub of [...subscribers]) {
    if (sub.pipelineId !== pipelineId && sub.pipelineId !== "*") continue;
    try {
      sub.write(`data: ${JSON.stringify({ type: "stream_end", data: { pipeline_id: pipelineId } })}\n\n`);
      sub.close();
    } catch {
      /* closed */
    }
    subscribers.delete(sub);
  }
}

export function emitExecutorEvent(event: ExecutorEvent, state?: ClusterState): void {
  const buf = eventBuffer.get(event.pipelineId) ?? [];
  buf.push(event);
  while (buf.length > MAX_EVENT_BUFFER) buf.shift();
  eventBuffer.set(event.pipelineId, buf);
  persistEvent(state, event);

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const sub of subscribers) {
    if (sub.pipelineId === event.pipelineId || sub.pipelineId === "*") {
      try {
        sub.write(payload);
      } catch {
        subscribers.delete(sub);
      }
    }
  }

  if (event.kind === "pipeline.end") {
    closePipelineSubscribers(event.pipelineId);
  }
}

export function getExecutorEvents(pipelineId: string, state?: ClusterState): ExecutorEvent[] {
  const live = eventBuffer.get(pipelineId);
  if (live?.length) return [...live];
  const persisted = state?.pipelines?.find((p) => p.id === pipelineId)?.events;
  if (persisted?.length) {
    return persisted.map((e) => ({
      pipelineId: e.pipelineId,
      at: e.at,
      kind: e.kind as ExecutorEventKind,
      stageId: e.stageId,
      agent: e.agent,
      taskId: e.taskId,
      workerId: e.workerId,
      message: e.message,
      artifact: e.artifact,
      meta: e.meta,
    }));
  }
  return [];
}

/** Register SSE subscriber; returns unsubscribe. Seeds from live buffer or persisted events. */
export function subscribeExecutorEvents(
  pipelineId: string,
  write: (chunk: string) => void,
  close: () => void,
  state?: ClusterState,
): () => void {
  const sub: SseSubscriber = { pipelineId, write, close };
  subscribers.add(sub);
  for (const e of getExecutorEvents(pipelineId, state)) {
    write(`data: ${JSON.stringify(e)}\n\n`);
  }
  return () => {
    subscribers.delete(sub);
  };
}

function ensurePipelines(state: ClusterState): PipelineRun[] {
  if (!state.pipelines) state.pipelines = [];
  while (state.pipelines.length > MAX_PIPELINE_RUNS) {
    const dropped = state.pipelines.shift();
    if (dropped) eventBuffer.delete(dropped.id);
  }
  return state.pipelines;
}

export function getPipeline(state: ClusterState, id: string): PipelineRun | undefined {
  return ensurePipelines(state).find((p) => p.id === id);
}

/** Parse `<pipelineId>:<stageId>` task ids from executor pipelines. */
export function parsePipelineTaskId(taskId: string): { pipelineId?: string; stageId?: string } {
  const i = taskId.indexOf(":");
  if (i <= 0) return {};
  return { pipelineId: taskId.slice(0, i), stageId: taskId.slice(i + 1) };
}

function pipelineProgressHook(
  state: ClusterState,
  pipeline: PipelineRun,
  prefix: string,
): (progress: TaskProgress) => void {
  return (progress) => {
    if (!progress.taskId.startsWith(prefix)) return;
    const { stageId } = parsePipelineTaskId(progress.taskId);
    const stage = pipeline.stages.find((s) => s.id === stageId);
    emitExecutorEvent(
      {
        pipelineId: pipeline.id,
        at: nowIso(),
        kind: "stage.log",
        stageId: stage?.id ?? stageId,
        taskId: progress.taskId,
        agent: progress.agent,
        message: progress.message.slice(0, 800),
        meta: { log_type: progress.kind, role: stage?.role ?? stageId },
      },
      state,
    );
  };
}

/** Validate stage agents exist in desired fleet. */
export function validatePipelineAgents(
  state: ClusterState,
  stages: PipelineStagePlan[],
): { ok: true } | { ok: false; missing: string[] } {
  const known = new Set(state.desired.map((a) => a.metadata.name));
  const missing = [...new Set(stages.map((s) => s.agent).filter((a) => !known.has(a)))];
  if (missing.length) return { ok: false, missing };
  return { ok: true };
}

function syncPipelineFromQueue(state: ClusterState, pipeline: PipelineRun): void {
  for (const stage of pipeline.stages) {
    const items = state.queue.filter((q) => q.id === stage.taskId);
    const latest = items[items.length - 1];
    if (!latest) continue;
    if (latest.status === "claimed" || latest.status === "pending") stage.status = "running";
    if (latest.status === "done") {
      stage.status = "done";
      stage.workerId = latest.workerId;
    }
    if (latest.status === "dead" || latest.status === "failed") {
      stage.status = "failed";
      stage.error = latest.error ?? "enqueue denied";
      stage.workerId = latest.workerId;
    }
  }

  const allDone = pipeline.stages.every((s) => s.status === "done");
  const anyFailed = pipeline.stages.some((s) => s.status === "failed");
  if (anyFailed) pipeline.status = "failed";
  else if (allDone) pipeline.status = "done";
  else if (pipeline.stages.some((s) => s.status === "running")) pipeline.status = "running";
  else if (pipeline.stages.some((s) => s.status === "pending")) pipeline.status = "running";
  pipeline.updatedAt = nowIso();

  if (pipeline.status === "done") {
    pipeline.output = pipeline.stages
      .filter((s) => s.output)
      .map((s) => `[${s.id}] ${s.output}`)
      .join("\n\n");
  }
}

function priorStageContext(stages: PipelineStageRun[], uptoIndex: number): string {
  return stages
    .slice(0, uptoIndex)
    .filter((s) => s.output)
    .map((s) => `[${s.id}/${s.role ?? s.agent}]\n${s.output}`)
    .join("\n\n");
}

function stagePrompt(base: string, prior: string): string {
  if (!prior.trim()) return base;
  return `${base}\n\n--- Prior stage outputs ---\n${prior.slice(0, 8000)}`;
}

function rememberStageOutput(state: ClusterState, pipeline: PipelineRun, stage: PipelineStageRun): void {
  if (!stage.output?.trim()) return;
  const agent = state.desired.find((a) => a.metadata.name === stage.agent);
  if (!agent || agent.spec.hermes.memory === "none") return;
  try {
    const store = SharedMemoryStore.fromState(state);
    const worker = state.workers.find((w) => w.id === stage.workerId) ?? {
      id: `${stage.agent}:0`,
      agent: stage.agent,
      fleet: agent.derivedFrom?.fleet,
    };
    const ctx = memoryContextFor(worker, agent.spec.hermes);
    store.remember(ctx, stage.output.slice(0, 4000), {
      id: `${pipeline.id}:${stage.id}:out`,
      tags: ["pipeline", pipeline.id, stage.id, stage.role ?? stage.id],
    });
  } catch {
    /* memory write optional — don't fail the pipeline */
  }
}

function emitStageComplete(
  state: ClusterState,
  pipelineId: string,
  stage: PipelineStageRun,
  workerId: string | undefined,
  output: string | undefined,
  failed: boolean,
  error?: string,
): void {
  const kind = failed ? "stage.failed" : "stage.complete";
  emitExecutorEvent(
    {
      pipelineId,
      at: nowIso(),
      kind,
      stageId: stage.id,
      agent: stage.agent,
      taskId: stage.taskId,
      workerId,
      artifact: output?.slice(0, 4000),
      message: failed ? (error ?? "stage failed") : "stage complete",
      meta: { role: stage.role ?? stage.id, error: failed },
    },
    state,
  );
}

function queueItemForTask(state: ClusterState, taskId: string) {
  const items = state.queue.filter((q) => q.id === taskId);
  return items[items.length - 1];
}

function emitTerminalIfDone(state: ClusterState, pipeline: PipelineRun): void {
  const terminal =
    pipeline.status === "failed"
      ? ("pipeline.error" as const)
      : pipeline.status === "done"
        ? ("pipeline.complete" as const)
        : null;
  if (!terminal) return;
  emitExecutorEvent(
    {
      pipelineId: pipeline.id,
      at: nowIso(),
      kind: terminal,
      artifact: pipeline.output?.slice(0, 4000),
      message: pipeline.status,
    },
    state,
  );
  emitExecutorEvent({ pipelineId: pipeline.id, at: nowIso(), kind: "pipeline.end", message: "closed" }, state);
}

/** Run pending stages sequentially; optional prefix scopes drain to this pipeline. */
export async function drainPipelineStages(
  state: ClusterState,
  pipeline: PipelineRun,
  opts: DrainOptions & { root?: string } = {},
): Promise<number> {
  const prefix = `${pipeline.id}:`;
  let drained = 0;
  let failed = false;

  for (let i = 0; i < pipeline.stages.length; i++) {
    const stage = pipeline.stages[i];
    if (stage.status === "done") continue;
    if (stage.status === "failed") {
      failed = true;
      break;
    }

    if (!stage.basePrompt) stage.basePrompt = stage.prompt;
    const prior = priorStageContext(pipeline.stages, i);
    stage.prompt = stagePrompt(stage.basePrompt, prior);

    const task: Task = {
      id: stage.taskId,
      agent: stage.agent,
      prompt: stage.prompt,
    };

    const existing = queueItemForTask(state, stage.taskId);
    if (!existing || existing.status === "dead" || existing.status === "failed") {
      enqueueTask(state, task, "pipeline");
      recordAudit(state, {
        kind: "enqueue",
        message: `pipeline ${pipeline.id} stage ${stage.id}`,
        agent: stage.agent,
        taskId: stage.taskId,
        meta: { pipelineId: pipeline.id, stageId: stage.id, sequential: true },
      });
    }

    // Admission may have denied immediately
    const afterEnqueue = queueItemForTask(state, stage.taskId);
    if (afterEnqueue?.status === "failed") {
      stage.status = "failed";
      stage.error = afterEnqueue.error ?? "enqueue denied";
      failed = true;
      emitStageComplete(state, pipeline.id, stage, undefined, stage.error, true, stage.error);
      break;
    }

    const firstStart = !stage.started;
    stage.status = "running";
    stage.started = true;
    pipeline.updatedAt = nowIso();

    if (firstStart) {
      emitExecutorEvent(
        {
          pipelineId: pipeline.id,
          at: nowIso(),
          kind: "stage.start",
          stageId: stage.id,
          agent: stage.agent,
          taskId: stage.taskId,
          message: stage.prompt.slice(0, 300),
          meta: { role: stage.role ?? stage.id, index: i + 1, total: pipeline.stages.length },
        },
        state,
      );
    }

    const onProgress = pipelineProgressHook(state, pipeline, prefix);
    const results = await drainQueue(state, {
      ...opts,
      root: opts.root,
      limit: 1,
      concurrency: 1,
      taskIdPrefix: prefix,
      onProgress,
    });

    const hit = results.find((r) => r.task.id === stage.taskId);
    if (hit) {
      stage.status = "done";
      stage.workerId = hit.worker.id;
      stage.output = hit.output;
      drained += 1;
      rememberStageOutput(state, pipeline, stage);
      emitStageComplete(state, pipeline.id, stage, hit.worker.id, hit.output, false);
      continue;
    }

    syncPipelineFromQueue(state, pipeline);
    if (stage.status === "failed") {
      failed = true;
      emitStageComplete(state, pipeline.id, stage, stage.workerId, stage.error, true, stage.error);
      break;
    }

    // No worker / not claimed — leave pending for a later drain call
    stage.status = "pending";
    break;
  }

  syncPipelineFromQueue(state, pipeline);
  if (failed) pipeline.status = "failed";
  pipeline.updatedAt = nowIso();
  return drained;
}

/** Drain an existing pipeline by id (scoped queue claims). */
export async function drainPipeline(
  state: ClusterState,
  pipelineId: string,
  opts: DrainOptions & { root?: string } = {},
): Promise<SubmitPipelineResult | undefined> {
  const pipeline = getPipeline(state, pipelineId);
  if (!pipeline) return undefined;
  if (pipeline.status === "done" || pipeline.status === "failed") {
    return { pipeline, drained: 0 };
  }
  pipeline.status = "running";
  const drained = await drainPipelineStages(state, pipeline, opts);
  syncPipelineFromQueue(state, pipeline);
  emitTerminalIfDone(state, pipeline);
  return { pipeline, drained };
}

export async function submitPipeline(
  state: ClusterState,
  opts: SubmitPipelineOptions,
): Promise<SubmitPipelineResult> {
  if (opts.action === "drain" || opts.pipelineId) {
    const id = opts.pipelineId;
    if (!id) throw new Error("pipelineId required for drain action");
    const result = await drainPipeline(state, id, { root: opts.root, concurrency: opts.concurrency });
    if (!result) throw new Error(`pipeline not found: ${id}`);
    return result;
  }

  const prompt = opts.prompt?.trim();
  if (!prompt) throw new Error("prompt required");

  const stages = planPipeline(prompt, state, {
    agents: opts.agents,
    stages: opts.stages,
  });

  if (!stages.length) throw new Error("stages must not be empty");
  const ids = stages.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate stage ids");

  const validation = validatePipelineAgents(state, stages);
  if (!validation.ok) {
    throw new Error(`unknown agent(s): ${validation.missing.join(", ")} — apply fleet manifests first`);
  }

  const pipelineId = randomUUID();
  const run: PipelineRun = {
    id: pipelineId,
    prompt,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "pending",
    stages: stages.map((s) => ({
      ...s,
      basePrompt: s.prompt,
      taskId: `${pipelineId}:${s.id}`,
      status: "pending" as const,
      started: false,
    })),
    events: [],
  };

  ensurePipelines(state).push(run);

  emitExecutorEvent(
    {
      pipelineId,
      at: nowIso(),
      kind: "pipeline.start",
      message: prompt.slice(0, 500),
    },
    state,
  );
  emitExecutorEvent(
    {
      pipelineId,
      at: nowIso(),
      kind: "pipeline.plan",
      meta: {
        stages: run.stages.length,
        agents: JSON.stringify(planAgentsMeta(run.stages)),
      },
      message: run.stages.map((s) => `${s.id}→${s.agent}`).join(", "),
    },
    state,
  );

  run.status = "running";
  run.updatedAt = nowIso();

  let drained = 0;
  if (opts.drain !== false) {
    drained = await drainPipelineStages(state, run, {
      root: opts.root,
      concurrency: 1,
    });
    syncPipelineFromQueue(state, run);
    emitTerminalIfDone(state, run);
  }

  return { pipeline: run, drained };
}

/** Map executor events to common UI event names (Magentic-compatible). */
export function mapExecutorEventToUi(event: ExecutorEvent): { type: string; data: Record<string, unknown> } {
  switch (event.kind) {
    case "pipeline.start":
      return { type: "status", data: { kind: event.kind, message: event.message, pipeline_id: event.pipelineId } };
    case "pipeline.plan": {
      let agents: unknown[] = [];
      if (typeof event.meta?.agents === "string") {
        try {
          agents = JSON.parse(event.meta.agents) as unknown[];
        } catch {
          agents = [];
        }
      }
      return {
        type: "plan",
        data: {
          description: event.message,
          message: event.message,
          stages: event.meta?.stages,
          agents,
          total_agents: agents.length || event.meta?.stages,
          total_layers: 1,
        },
      };
    }
    case "stage.start":
      return {
        type: "agent_start",
        data: {
          agent_id: event.taskId,
          role: event.meta?.role ?? event.stageId,
          stage_id: event.stageId,
          agent: event.agent,
        },
      };
    case "stage.log":
      return {
        type: "agent_log",
        data: {
          message: event.message,
          stage_id: event.stageId,
          log_type: event.meta?.log_type ?? "log",
          agent_id: event.taskId,
        },
      };
    case "stage.complete":
    case "stage.failed":
      return {
        type: "agent_complete",
        data: {
          agent_id: event.taskId,
          role: event.meta?.role ?? event.stageId,
          output: event.artifact ?? event.message,
          error: event.kind === "stage.failed" || event.meta?.error === true,
          artifacts: event.artifact ? [{ path: `${event.stageId}.txt`, content: event.artifact }] : [],
        },
      };
    case "pipeline.complete":
      return { type: "complete", data: { output: event.artifact ?? event.message, pipeline_id: event.pipelineId } };
    case "pipeline.error":
      return { type: "error", data: { message: event.message, pipeline_id: event.pipelineId } };
    case "pipeline.end":
      return { type: "stream_end", data: { pipeline_id: event.pipelineId } };
    default:
      return { type: "status", data: { kind: event.kind, message: event.message } };
  }
}
