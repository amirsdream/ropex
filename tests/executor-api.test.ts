import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startControlPlaneServer } from "../src/api.ts";
import { API_ROUTES } from "../src/contracts.ts";
import { emptyState, planReconcile, saveState, loadState } from "../src/controller.ts";
import {
  getExecutorEvents,
  mapExecutorEventToUi,
  submitPipeline,
} from "../src/executor.ts";
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
  it("submitPipeline plans research stages and emits events", async () => {
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
  });

  it("mapExecutorEventToUi matches Magentic websocket names", () => {
    const mapped = mapExecutorEventToUi({
      pipelineId: "p1",
      at: new Date().toISOString(),
      kind: "stage.start",
      stageId: "research",
      taskId: "p1:research",
      agent: "researcher",
      meta: { role: "researcher" },
    });
    expect(mapped.type).toBe("agent_start");
    expect(mapped.data.role).toBe("researcher");
  });

  it("POST /api/v1/pipeline and GET /api/v1/events?format=ui", async () => {
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
      const body = (await post.json()) as { pipeline: { id: string; status: string } };
      expect(body.pipeline.status).toBe("done");

      const get = await fetch(
        `http://127.0.0.1:${server.port}${API_ROUTES.pipeline}?id=${body.pipeline.id}`,
      );
      expect(get.status).toBe(200);

      const buffered = getExecutorEvents(body.pipeline.id);
      expect(buffered.some((e) => e.kind === "pipeline.plan")).toBe(true);
      const planUi = mapExecutorEventToUi(buffered.find((e) => e.kind === "pipeline.plan")!);
      expect(planUi.type).toBe("plan");
    } finally {
      await server.close();
    }
  });
});
