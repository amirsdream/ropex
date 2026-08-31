import { describe, expect, it } from "vitest";
import { buildControlPlaneView } from "../src/api.ts";
import { API_ROUTES } from "../src/contracts.ts";
import { emptyState } from "../src/controller.ts";
import { metricsPrometheus, metricsSnapshot } from "../src/metrics.ts";
import { checkRateLimit, rateLimitReport } from "../src/ratelimit.ts";
import { expandWorkers, runTask } from "../src/runtime.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: triage
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
`;

describe("trajectory + rate-limit observability", () => {
  it("projects trajectories and rateLimits onto the control-plane view", async () => {
    const desired = expandDesired(parseManifests(yaml));
    const worker = expandWorkers(desired[0])[0];
    worker.status = "idle";
    const state = emptyState();
    state.desired = desired;
    state.workers = [worker];

    await runTask(state, worker, { id: "t-obs", agent: "triage", prompt: "summarize" });
    const now = Date.now();
    checkRateLimit(state, "acme/app", { limit: 2, windowMs: 60_000 }, now);
    checkRateLimit(state, "acme/app", { limit: 2, windowMs: 60_000 }, now + 100);

    const view = buildControlPlaneView(state);
    expect(view.trajectories.total).toBe(1);
    expect(view.trajectories.recent[0].taskId).toBe("t-obs");
    expect(view.trajectories.recent[0].stages.length).toBeGreaterThan(0);
    expect(view.rateLimits.buckets).toBe(1);
    expect(view.rateLimits.rows[0].key).toBe("acme/app");
    expect(view.rateLimits.rows[0].count).toBe(2);
    expect(view.rateLimits.rows[0].saturated).toBe(true);
  });

  it("exports trajectory and rate-limit prometheus gauges", () => {
    const state = emptyState();
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      checkRateLimit(state, "org/repo", { limit: 5, windowMs: 60_000 }, now + i);
    }
    state.trajectories = [
      {
        id: "traj-1",
        at: new Date().toISOString(),
        taskId: "t1",
        agent: "triage",
        workerId: "triage:0",
        imageDigest: "abc",
        plan: [],
        steps: [],
        output: "ok",
        stages: ["compose", "execute"],
      },
    ];
    const snap = metricsSnapshot(state);
    expect(snap.trajectories_total).toBe(1);
    expect(snap.ratelimit_buckets).toBe(1);
    expect(snap.ratelimit_saturated).toBe(1);
    const text = metricsPrometheus(state);
    expect(text).toContain("ropex_trajectories_total 1");
    expect(text).toContain("ropex_ratelimit_saturated 1");
  });

  it("rateLimitReport ignores expired windows", () => {
    const state = emptyState();
    checkRateLimit(state, "old/key", { limit: 3, windowMs: 1_000 }, 1_000);
    const stale = rateLimitReport(state, { limit: 3, windowMs: 1_000, now: 5_000 });
    expect(stale.buckets).toBe(0);
    checkRateLimit(state, "new/key", { limit: 3, windowMs: 1_000 }, 5_000);
    const fresh = rateLimitReport(state, { limit: 3, windowMs: 1_000, now: 5_100 });
    expect(fresh.buckets).toBe(1);
    expect(fresh.rows[0].key).toBe("new/key");
  });

  it("exposes ratelimits API route and UI sections", () => {
    expect(API_ROUTES.ratelimits).toBe("/api/v1/ratelimits");
    const observe = readFileSync(join(process.cwd(), "web/src/pages/Observe.tsx"), "utf8");
    expect(observe).toContain("Trajectories");
    expect(observe).toContain("Rate limits");
  });
});
