import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildControlPlaneView, startControlPlaneServer } from "../src/api.ts";
import { API_ROUTES } from "../src/contracts.ts";
import { emptyState, planReconcile, saveState, loadState } from "../src/controller.ts";
import { enqueueTask, pauseQueue } from "../src/queue.ts";
import { parseManifests } from "../src/spec.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: ops
spec:
  scale: static
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
  name: gate
spec:
  maxReplicas: 10
  permissions:
    deny:
      - force-push
    requireApproval:
      - shell
`;

describe("operator queue + policy UI actions", () => {
  it("POST /api/v1/queue pause/resume/retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-ops-"));
    temps.push(root);
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    enqueueTask(next, { id: "alive", agent: "ops", prompt: "x" });
    const dead = enqueueTask(next, { id: "dead1", agent: "ops", prompt: "y" });
    dead.status = "dead";
    dead.error = "boom";
    saveState(root, next);

    const server = await startControlPlaneServer({
      root,
      port: 0,
      loadState,
      saveState,
    });
    try {
      const pause = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.queue}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pause" }),
      });
      expect(pause.status).toBe(200);
      expect(loadState(root).queuePaused).toBe(true);

      const resume = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.queue}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resume" }),
      });
      expect(resume.status).toBe(200);
      expect(loadState(root).queuePaused).toBe(false);

      const retry = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.queue}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "retry", id: dead.id }),
      });
      expect(retry.status).toBe(200);
      const retryBody = (await retry.json()) as { retried: number };
      expect(retryBody.retried).toBe(1);
      expect(loadState(root).queue.find((q) => q.id === dead.id)?.status).toBe("pending");
    } finally {
      await server.close();
    }
  });

  it("POST /api/v1/policy/simulate accepts custom prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-psim-"));
    temps.push(root);
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    saveState(root, next);
    const server = await startControlPlaneServer({
      root,
      port: 0,
      loadState,
      saveState,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.policySim}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "probe: force-push main" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        rows: Array<{ prompt: string; agent: string }>;
        deniedCalls: number;
      };
      expect(body.rows.every((r) => r.prompt.includes("force-push"))).toBe(true);
      expect(body.rows.some((r) => r.agent === "ops")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("view still projects policySim and drain for UI", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    pauseQueue(next);
    const view = buildControlPlaneView(next);
    expect(view.policySim.rows.length).toBeGreaterThan(0);
    expect(view.drain.paused).toBe(true);
  });

  it("UI wires pause/retry/policy simulate controls", () => {
    const js = readFileSync(join(process.cwd(), "src/ui/app.js"), "utf8");
    expect(js).toContain("queueAction");
    expect(js).toContain("runPolicySim");
    expect(js).toContain("retry all");
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
    expect(readme).toContain("HMAC + rate limit");
    expect(readme).toContain("bounded drain");
  });
});
