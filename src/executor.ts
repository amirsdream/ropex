/**
 * Ropex executor API — engine-neutral pipeline runs for external UIs (Magentic, etc.).
 * Repos stay independent: contract is HTTP + SSE documented in docs/executor-api.md.
 */

import { randomUUID } from "node:crypto";
import { recordAudit } from "./audit.js";
import { enqueueTask } from "./queue.js";
import { drainQueue } from "./scheduler.js";
import { planPipeline, type PipelineStagePlan } from "./pipeline.js";
import type { ClusterState, PipelineRun, Task } from "./types.js";

export type ExecutorEventKind =
  | "pipeline.start"
  | "pipeline.plan"
  | "stage.start"
  | "stage.log"
  | "stage.complete"
  | "pipeline.complete"
  | "pipeline.error";

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
  prompt: string;
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

export function emitExecutorEvent(event: ExecutorEvent): void {
  const buf = eventBuffer.get(event.pipelineId) ?? [];
  buf.push(event);
  while (buf.length > MAX_EVENT_BUFFER) buf.shift();
  eventBuffer.set(event.pipelineId, buf);

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
}

export function getExecutorEvents(pipelineId: string): ExecutorEvent[] {
  return [...(eventBuffer.get(pipelineId) ?? [])];
}

/** Register SSE subscriber; returns unsubscribe. */
export function subscribeExecutorEvents(
  pipelineId: string,
  write: (chunk: string) => void,
  close: () => void,
): () => void {
  const sub: SseSubscriber = { pipelineId, write, close };
  subscribers.add(sub);
  for (const e of getExecutorEvents(pipelineId)) {
    write(`data: ${JSON.stringify(e)}\n\n`);
  }
  return () => {
    subscribers.delete(sub);
  };
}

function ensurePipelines(state: ClusterState): PipelineRun[] {
  if (!state.pipelines) state.pipelines = [];
  return state.pipelines;
}

export function getPipeline(state: ClusterState, id: string): PipelineRun | undefined {
  return ensurePipelines(state).find((p) => p.id === id);
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
    if (latest.status === "dead") {
      stage.status = "failed";
      stage.error = latest.error;
      stage.workerId = latest.workerId;
    }
  }

  const allDone = pipeline.stages.every((s) => s.status === "done");
  const anyFailed = pipeline.stages.some((s) => s.status === "failed");
  if (anyFailed) pipeline.status = "failed";
  else if (allDone) pipeline.status = "done";
  else if (pipeline.stages.some((s) => s.status === "running")) pipeline.status = "running";
  pipeline.updatedAt = nowIso();

  if (pipeline.status === "done") {
    pipeline.output = pipeline.stages
      .filter((s) => s.output)
      .map((s) => `[${s.id}] ${s.output}`)
      .join("\n\n");
  }
}

export async function submitPipeline(
  state: ClusterState,
  opts: SubmitPipelineOptions,
): Promise<SubmitPipelineResult> {
  const pipelineId = randomUUID();
  const stages = planPipeline(opts.prompt, state, {
    agents: opts.agents,
    stages: opts.stages,
  });

  const run: PipelineRun = {
    id: pipelineId,
    prompt: opts.prompt,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "pending",
    stages: stages.map((s) => ({
      ...s,
      taskId: `${pipelineId}:${s.id}`,
      status: "pending" as const,
    })),
  };

  ensurePipelines(state).push(run);

  emitExecutorEvent({
    pipelineId,
    at: nowIso(),
    kind: "pipeline.start",
    message: opts.prompt.slice(0, 500),
  });
  emitExecutorEvent({
    pipelineId,
    at: nowIso(),
    kind: "pipeline.plan",
    meta: { stages: run.stages.length },
    message: run.stages.map((s) => `${s.id}→${s.agent}`).join(", "),
  });

  for (const stage of run.stages) {
    const task: Task = {
      id: stage.taskId,
      agent: stage.agent,
      prompt: stage.prompt,
    };
    enqueueTask(state, task, "pipeline");
    emitExecutorEvent({
      pipelineId,
      at: nowIso(),
      kind: "stage.start",
      stageId: stage.id,
      agent: stage.agent,
      taskId: stage.taskId,
      message: stage.prompt.slice(0, 300),
      meta: { role: stage.role ?? stage.id },
    });
    recordAudit(state, {
      kind: "enqueue",
      message: `pipeline ${pipelineId} stage ${stage.id}`,
      agent: stage.agent,
      taskId: stage.taskId,
      meta: { pipelineId, stageId: stage.id },
    });
  }

  run.status = "running";
  run.updatedAt = nowIso();

  let drained = 0;
  if (opts.drain !== false) {
    const results = await drainQueue(state, {
      root: opts.root,
      limit: run.stages.length,
      concurrency: opts.concurrency,
    });
    drained = results.length;
    for (const r of results) {
      const stage = run.stages.find((s) => s.taskId === r.task.id);
      if (!stage) continue;
      stage.status = "done";
      stage.workerId = r.worker.id;
      stage.output = r.output;
      emitExecutorEvent({
        pipelineId,
        at: nowIso(),
        kind: "stage.complete",
        stageId: stage.id,
        agent: stage.agent,
        taskId: stage.taskId,
        workerId: r.worker.id,
        artifact: r.output?.slice(0, 4000),
        message: "stage complete",
        meta: { role: stage.role ?? stage.id },
      });
    }
    syncPipelineFromQueue(state, run);
  } else {
    syncPipelineFromQueue(state, run);
  }

  emitExecutorEvent({
    pipelineId,
    at: nowIso(),
    kind: run.status === "failed" ? "pipeline.error" : "pipeline.complete",
    artifact: run.output?.slice(0, 4000),
    message: run.status,
  });

  return { pipeline: run, drained };
}

/** Map executor events to common UI event names (Magentic-compatible). */
export function mapExecutorEventToUi(event: ExecutorEvent): { type: string; data: Record<string, unknown> } {
  switch (event.kind) {
    case "pipeline.plan":
      return { type: "plan", data: { message: event.message, stages: event.meta?.stages } };
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
      return { type: "agent_log", data: { message: event.message, stage_id: event.stageId } };
    case "stage.complete":
      return {
        type: "agent_complete",
        data: {
          agent_id: event.taskId,
          role: event.meta?.role ?? event.stageId,
          output: event.artifact ?? event.message,
          artifacts: event.artifact ? [{ path: `${event.stageId}.txt`, content: event.artifact }] : [],
        },
      };
    case "pipeline.complete":
      return { type: "complete", data: { output: event.artifact ?? event.message, pipeline_id: event.pipelineId } };
    case "pipeline.error":
      return { type: "error", data: { message: event.message, pipeline_id: event.pipelineId } };
    default:
      return { type: "status", data: { kind: event.kind, message: event.message } };
  }
}
