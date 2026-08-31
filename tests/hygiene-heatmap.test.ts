import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildControlPlaneView, startControlPlaneServer } from "../src/api.ts";
import { API_ROUTES } from "../src/contracts.ts";
import { emptyState, planReconcile, saveState, loadState } from "../src/controller.ts";
import { hygieneReport, poolHeatmap, runHygiene } from "../src/hygiene.ts";
import { enqueueTask } from "../src/queue.ts";
import { parseManifests } from "../src/spec.ts";
import { WEBHOOK_SEEN_MAX } from "../src/webhook.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: heat
spec:
  scale: static
  replicas: 3
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
`;

describe("hygiene + pool heatmap", () => {
  it("builds pool heatmap and queue depth bars", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    next.workers[0].status = "idle";
    next.workers[1].status = "running";
    next.workers[2].status = "failed";
    next.workers[2].cordoned = true;
    enqueueTask(next, { id: "p1", agent: "heat", prompt: "a" });
    next.webhookSeen = ["d1", "d2"];
    next.metrics.webhookDuplicates = 4;
    const report = hygieneReport(next);
    expect(report.pool).toHaveLength(1);
    expect(report.pool[0].idle).toBe(1);
    expect(report.pool[0].running).toBe(1);
    expect(report.pool[0].failed).toBe(1);
    expect(report.pool[0].cordoned).toBe(1);
    expect(report.webhook.seen).toBe(2);
    expect(report.webhook.duplicates).toBe(4);
    expect(report.webhook.cap).toBe(WEBHOOK_SEEN_MAX);
    expect(report.queueDepth.some((b) => b.key === "pending" && b.count >= 1)).toBe(true);
    expect(poolHeatmap(next)[0].total).toBe(3);
  });

  it("runHygiene reclaim+age and projects onto view", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    const view = buildControlPlaneView(next);
    expect(view.hygiene.pool.length).toBe(1);
    expect(view.hygiene.webhook.cap).toBe(WEBHOOK_SEEN_MAX);
    const aged = runHygiene(next, "age");
    expect(aged.action).toBe("age");
  });

  it("GET/POST /api/v1/hygiene", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-hyg-"));
    temps.push(root);
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    mkdirSync(join(root, "sandbox/worktrees/orphan-slot"), { recursive: true });
    writeFileSync(join(root, "sandbox/worktrees/orphan-slot/x"), "1");
    saveState(root, next);

    const server = await startControlPlaneServer({
      root,
      port: 0,
      loadState,
      saveState,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.hygiene}`);
      expect(get.status).toBe(200);
      const report = (await get.json()) as { pool: unknown[] };
      expect(report.pool.length).toBe(1);

      const post = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.hygiene}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "gc" }),
      });
      expect(post.status).toBe(200);
      const body = (await post.json()) as { gcRemoved: number };
      expect(body.gcRemoved).toBeGreaterThanOrEqual(1);
    } finally {
      await server.close();
    }
  });

  it("UI includes heatmap and hygiene controls", () => {
    const fleet = readFileSync(join(process.cwd(), "web/src/pages/Fleet.tsx"), "utf8");
    const api = readFileSync(join(process.cwd(), "web/src/lib/api.ts"), "utf8");
    expect(fleet).toContain("Hygiene");
    expect(fleet).toContain("heat-cell");
    expect(api).toContain("hygiene");
  });
});
