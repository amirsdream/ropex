import { describe, expect, it } from "vitest";
import { emptyState, planReconcile } from "../src/controller.ts";
import {
  fairnessReport,
  formatFairnessReport,
  latencyStats,
  percentile,
} from "../src/fairness.ts";
import { metricsPrometheus, metricsSnapshot } from "../src/metrics.ts";
import { claimPending, completeQueued, enqueueTask } from "../src/queue.ts";
import { parseManifests } from "../src/spec.ts";

const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: fair
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

describe("fairness latency helpers", () => {
  it("computes percentiles", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95)).toBe(100);
    expect(latencyStats([100, 200, 300]).p50Ms).toBe(200);
    expect(latencyStats([]).count).toBe(0);
  });
});

describe("fairness report", () => {
  it("measures claim wait and run duration from queue timestamps", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    const t0 = Date.parse("2026-08-22T00:00:00.000Z");
    enqueueTask(next, { id: "f1", agent: "fair", prompt: "a" });
    enqueueTask(next, { id: "f2", agent: "fair", prompt: "b" });
    // Fix enqueue times
    next.queue[0].enqueuedAt = new Date(t0).toISOString();
    next.queue[1].enqueuedAt = new Date(t0).toISOString();

    claimPending(next, 1, { now: t0 + 1_000 });
    const q1 = next.queue.find((q) => q.id === "f1")!;
    expect(q1.status).toBe("claimed");
    completeQueued(next, "f1", true, undefined, { now: t0 + 3_000 });

    claimPending(next, 1, { now: t0 + 5_000 });
    completeQueued(next, "f2", true, undefined, { now: t0 + 6_000 });

    const report = fairnessReport(next, { now: t0 + 10_000 });
    expect(report.claimWait.count).toBe(2);
    expect(report.claimWait.p50Ms).toBeGreaterThanOrEqual(1000);
    expect(report.runDuration.count).toBe(2);
    expect(report.workers.length).toBe(2);
    expect(report.workers.reduce((n, w) => n + w.claims, 0)).toBeGreaterThanOrEqual(2);
    expect(formatFairnessReport(report)).toContain("claimWait");

    const snap = metricsSnapshot(next);
    expect(snap.claim_wait_p50_ms).toBe(report.claimWait.p50Ms);
    expect(snap.fairness_claim_cv).toBe(report.claimCountCv);
    const prom = metricsPrometheus(next);
    expect(prom).toContain("ropex_claim_wait_p95_ms");
    expect(prom).toContain("ropex_fairness_idle_skew_ms");
  });

  it("reports pendingByAgent and idle skew", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    const now = Date.parse("2026-08-22T01:00:00.000Z");
    next.workers[0].lastTaskAt = new Date(now - 60_000).toISOString();
    next.workers[1].lastTaskAt = new Date(now - 10_000).toISOString();
    enqueueTask(next, { id: "p1", agent: "fair", prompt: "wait" });
    const report = fairnessReport(next, { now });
    expect(report.pendingByAgent.fair).toBe(1);
    expect(report.maxIdleSkewMs).toBe(50_000);
  });
});
