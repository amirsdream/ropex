import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildControlPlaneView, startControlPlaneServer } from "../src/api.ts";
import { API_ROUTES } from "../src/contracts.ts";
import { emptyState, planReconcile, saveState, loadState } from "../src/controller.ts";
import { enqueueTask, pauseQueue } from "../src/queue.ts";
import {
  clampDrainConcurrency,
  drainQueue,
  drainStatus,
  getDrainConcurrency,
  MAX_DRAIN_CONCURRENCY,
  setDrainConcurrency,
} from "../src/scheduler.ts";
import { parseManifests } from "../src/spec.ts";
import { readFileSync } from "node:fs";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: drainbot
spec:
  scale: static
  replicas: 2
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
`;

describe("drain concurrency preference", () => {
  it("clamps and persists preferred concurrency", () => {
    expect(clampDrainConcurrency(0)).toBe(1);
    expect(clampDrainConcurrency(999)).toBe(MAX_DRAIN_CONCURRENCY);
    const state = emptyState();
    expect(getDrainConcurrency(state)).toBe(1);
    setDrainConcurrency(state, 4);
    expect(state.drainConcurrency).toBe(4);
    expect(drainStatus(state).concurrency).toBe(4);
  });

  it("uses persisted preference when drainQueue omits concurrency", async () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    setDrainConcurrency(next, 2);
    for (const w of next.workers) w.status = "idle";
    enqueueTask(next, { id: "a", agent: "drainbot", prompt: "one" });
    enqueueTask(next, { id: "b", agent: "drainbot", prompt: "two" });
    const results = await drainQueue(next, { limit: 2 });
    expect(results.length).toBe(2);
    expect(getDrainConcurrency(next)).toBe(2);
  });

  it("projects drain onto the control-plane view", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    setDrainConcurrency(next, 3);
    pauseQueue(next);
    const view = buildControlPlaneView(next);
    expect(view.drain.concurrency).toBe(3);
    expect(view.drain.maxConcurrency).toBe(MAX_DRAIN_CONCURRENCY);
    expect(view.drain.paused).toBe(true);
    expect(view.drain.idleWorkers).toBe(2);
  });

  it("PUT /api/v1/drain sets preference; POST drains; paused returns 409", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-drain-"));
    temps.push(root);
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    for (const w of next.workers) w.status = "idle";
    enqueueTask(next, { id: "t1", agent: "drainbot", prompt: "hello" });
    saveState(root, next);

    const server = await startControlPlaneServer({
      root,
      port: 0,
      loadState,
      saveState,
    });
    try {
      const put = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.drain}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ concurrency: 2 }),
      });
      expect(put.status).toBe(200);
      const putBody = (await put.json()) as { concurrency: number };
      expect(putBody.concurrency).toBe(2);
      expect(loadState(root).drainConcurrency).toBe(2);

      const post = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.drain}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ concurrency: 2 }),
      });
      expect(post.status).toBe(200);
      const postBody = (await post.json()) as { drained: number };
      expect(postBody.drained).toBe(1);

      const paused = loadState(root);
      pauseQueue(paused);
      saveState(root, paused);
      const blocked = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.drain}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(blocked.status).toBe(409);
    } finally {
      await server.close();
    }
  });

  it("UI includes drain controls", () => {
    const html = readFileSync(join(process.cwd(), "src/ui/index.html"), "utf8");
    const js = readFileSync(join(process.cwd(), "src/ui/app.js"), "utf8");
    expect(html).toContain("drain-controls");
    expect(js).toContain("runDrain");
    expect(js).toContain("preferDrain");
  });
});
