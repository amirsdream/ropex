import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startControlPlaneServer, buildControlPlaneView } from "../src/api.ts";
import { API_ROUTES } from "../src/contracts.ts";
import { emptyState, planReconcile, saveState, loadState } from "../src/controller.ts";
import {
  drainPipeline,
  getExecutorEvents,
  mapExecutorEventToUi,
  parsePipelineTaskId,
  submitPipeline,
  validatePipelineAgents,
} from "../src/executor.ts";
import { enqueueTask } from "../src/queue.ts";
import { parseManifests } from "../src/spec.ts";

const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: researcher
spec:
  replicas: 1
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: synthesizer
spec:
  replicas: 1
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
---
apiVersion: ropex.dev/v1
kind: Policy
metadata:
  name: cap
spec:
  maxReplicas: 10
  permissions:
    deny: []
    requireApproval: []
`;

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("executor API", () => {
  it("submitPipeline plans research stages sequentially and emits events", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-exec-"));
    temps.push(root);
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "fleets/");
    const result = await submitPipeline(next, {
      prompt: "Compare React vs Vue for a new dashboard",
      root,
      drain: true,
    });
    expect(result.pipeline.status).toBe("done");
    expect(result.pipeline.stages.length).toBeGreaterThanOrEqual(2);
    const events = getExecutorEvents(result.pipeline.id);
    expect(events.some((e) => e.kind === "pipeline.plan")).toBe(true);
    expect(events.some((e) => e.kind === "pipeline.complete")).toBe(true);
    expect(events.some((e) => e.kind === "pipeline.end")).toBe(true);
    if (result.pipeline.stages.length >= 2) {
      const second = result.pipeline.stages[1];
      expect(second.prompt).toContain("Prior stage outputs");
    }
  });

  it("rejects unknown agents before enqueue", async () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "fleets/");
    const check = validatePipelineAgents(next, [
      { id: "x", agent: "ghost", prompt: "nope" },
    ]);
    expect(check.ok).toBe(false);
    await expect(
      submitPipeline(next, { prompt: "test", stages: [{ id: "x", agent: "ghost", prompt: "nope" }] }),
    ).rejects.toThrow(/unknown agent/);
  });

  it("async drain is scoped to pipeline task ids", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-async-"));
    temps.push(root);
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "fleets/");
    enqueueTask(next, { id: "other-task", agent: "researcher", prompt: "unrelated" });
    const submitted = await submitPipeline(next, {
      prompt: "Research something",
      drain: false,
      stages: [{ id: "only", agent: "researcher", prompt: "scoped run" }],
    });
    const drained = await drainPipeline(next, submitted.pipeline.id, { root });
    expect(drained?.pipeline.status).toBe("done");
    expect(next.queue.find((q) => q.id === "other-task")?.status).toBe("pending");
  });

  it("mapExecutorEventToUi includes plan agents, failure flag, and agent_log", () => {
    expect(
      mapExecutorEventToUi({
        pipelineId: "p1",
        at: new Date().toISOString(),
        kind: "stage.start",
        stageId: "research",
        taskId: "p1:research",
        agent: "researcher",
        meta: { role: "researcher" },
      }).type,
    ).toBe("agent_start");

    const failed = mapExecutorEventToUi({
      pipelineId: "p1",
      at: new Date().toISOString(),
      kind: "stage.failed",
      stageId: "research",
      taskId: "p1:research",
      message: "boom",
      meta: { role: "researcher", error: true },
    });
    expect(failed.type).toBe("agent_complete");
    expect(failed.data.error).toBe(true);

    const log = mapExecutorEventToUi({
      pipelineId: "p1",
      at: new Date().toISOString(),
      kind: "stage.log",
      stageId: "research",
      taskId: "p1:research",
      message: "thinking…",
      meta: { log_type: "thought" },
    });
    expect(log.type).toBe("agent_log");
    expect(log.data.log_type).toBe("thought");
  });

  it("parsePipelineTaskId splits pipeline-scoped task ids", () => {
    expect(parsePipelineTaskId("abc:research")).toEqual({ pipelineId: "abc", stageId: "research" });
    expect(parsePipelineTaskId("plain")).toEqual({});
  });

  it("stage.log events precede stage.complete in event order", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-log-order-"));
    temps.push(root);
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "fleets/");
    const result = await submitPipeline(next, {
      prompt: "Compare X vs Y",
      root,
      drain: true,
      stages: [{ id: "only", agent: "researcher", prompt: "compare" }],
    });
    const events = getExecutorEvents(result.pipeline.id);
    const completeIdx = events.findIndex((e) => e.kind === "stage.complete");
    const logIdx = events.findIndex((e) => e.kind === "stage.log");
    expect(logIdx).toBeGreaterThan(-1);
    expect(completeIdx).toBeGreaterThan(logIdx);
  });

  it("emits stage.log events from trajectory steps", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-log-"));
    temps.push(root);
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "fleets/");
    const result = await submitPipeline(next, {
      prompt: "Compare React vs Vue",
      root,
      drain: true,
      stages: [{ id: "only", agent: "researcher", prompt: "quick compare" }],
    });
    const logs = getExecutorEvents(result.pipeline.id).filter((e) => e.kind === "stage.log");
    expect(logs.length).toBeGreaterThan(0);
  });

  it("POST /api/v1/pipeline and GET pipeline by id", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-exec-api-"));
    temps.push(root);
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "fleets/");
    saveState(root, next);

    const server = await startControlPlaneServer({
      root,
      port: 0,
      loadState,
      saveState,
    });
    try {
      const post = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.pipeline}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "Research LangGraph alternatives",
          drain: true,
        }),
      });
      expect(post.status).toBe(200);
      const body = (await post.json()) as { pipeline: { id: string; status: string; events?: unknown[] } };
      expect(body.pipeline.status).toBe("done");

      const get = await fetch(
        `http://127.0.0.1:${server.port}${API_ROUTES.pipeline}?id=${body.pipeline.id}`,
      );
      expect(get.status).toBe(200);
      const loaded = (await get.json()) as { events?: unknown[] };
      expect((loaded.events ?? []).length).toBeGreaterThan(0);

      const list = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.pipeline}`);
      expect(list.status).toBe(200);
      const listed = (await list.json()) as { total: number; pipelines: unknown[] };
      expect(listed.total).toBeGreaterThan(0);

      const view = buildControlPlaneView(loadState(root), root);
      expect(view.pipelines.total).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });
});
