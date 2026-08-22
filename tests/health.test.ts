import { describe, expect, it } from "vitest";
import { emptyState } from "../src/controller.ts";
import {
  evaluateBacklogSlo,
  healthReport,
  probeWorker,
} from "../src/health.ts";
import { metricsPrometheus, metricsSnapshot } from "../src/metrics.ts";
import { claimPending, enqueueTask } from "../src/queue.ts";
import type { DesiredAgent, Worker } from "../src/types.ts";

function idleWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: "builder:0",
    agent: "builder",
    replica: 0,
    status: "idle",
    imageDigest: "abcdef0123456789",
    harness: "code",
    plugins: ["github"],
    skills: [],
    model: "deepseek-v4-pro",
    ...overrides,
  };
}

describe("worker health probes", () => {
  it("marks failed workers unhealthy", () => {
    const h = probeWorker(idleWorker({ status: "failed" }));
    expect(h.healthy).toBe(false);
    expect(h.checks.some((c) => c.name === "not-failed" && !c.ok)).toBe(true);
  });

  it("flags missing digest", () => {
    const h = probeWorker(idleWorker({ imageDigest: "short" }));
    expect(h.healthy).toBe(false);
    expect(h.checks.find((c) => c.name === "digest")?.ok).toBe(false);
  });

  it("detects stuck running workers via claimedAt", () => {
    const state = emptyState();
    const worker = idleWorker({ status: "running" });
    state.workers = [worker];
    state.desired = [
      {
        apiVersion: "ropex.dev/v1",
        kind: "Agent",
        metadata: { name: "builder" },
        spec: {
          replicas: 1,
          harness: { profile: "code", plugins: ["github"] },
          hermes: { memory: "none", learning: false, skills: [] },
        },
      } as DesiredAgent,
    ];
    const now = Date.parse("2026-08-22T00:30:00.000Z");
    state.queue = [
      {
        id: "t1",
        task: { id: "t1", agent: "builder", prompt: "hang" },
        enqueuedAt: "2026-08-21T23:00:00.000Z",
        claimedAt: "2026-08-21T23:00:00.000Z",
        status: "claimed",
        workerId: "builder:0",
        attempts: 1,
        source: "cli",
        priority: 0,
      },
    ];
    const h = probeWorker(worker, { now, maxRunningMs: 60_000 }, state);
    expect(h.healthy).toBe(false);
    expect(h.checks.find((c) => c.name === "not-stuck")?.ok).toBe(false);
  });

  it("records claimedAt when claiming", () => {
    const state = emptyState();
    const worker = idleWorker();
    state.workers = [worker];
    state.desired = [
      {
        apiVersion: "ropex.dev/v1",
        kind: "Agent",
        metadata: { name: "builder" },
        spec: {
          replicas: 1,
          harness: { profile: "code", plugins: ["github"] },
          hermes: { memory: "none", learning: false, skills: [] },
        },
      } as DesiredAgent,
    ];
    enqueueTask(state, { id: "t-claim", agent: "builder", prompt: "go" });
    const { claimed } = claimPending(state, 1);
    expect(claimed).toHaveLength(1);
    const item = state.queue.find((q) => q.id === "t-claim");
    expect(item?.claimedAt).toBeTruthy();
    expect(Date.parse(item!.claimedAt!)).toBeGreaterThan(0);
  });
});

describe("backlog SLO", () => {
  it("breaches on depth and age", () => {
    const state = emptyState();
    const now = Date.parse("2026-08-22T00:10:00.000Z");
    for (let i = 0; i < 3; i++) {
      state.queue.push({
        id: `p${i}`,
        task: { id: `p${i}`, agent: "builder", prompt: "x" },
        enqueuedAt: "2026-08-22T00:00:00.000Z",
        status: "pending",
        attempts: 0,
        source: "cli",
        priority: 0,
      });
    }
    const slo = evaluateBacklogSlo(state, {
      now,
      maxPendingDepth: 2,
      maxPendingAgeMs: 5 * 60_000,
    });
    expect(slo.breached).toBe(true);
    expect(slo.pending).toBe(3);
    expect(slo.oldestPendingAgeMs).toBe(10 * 60_000);
    expect(slo.reasons.some((r) => /depth/.test(r))).toBe(true);
    expect(slo.reasons.some((r) => /age/.test(r))).toBe(true);
  });

  it("reports ok when within budgets", () => {
    const state = emptyState();
    state.workers = [idleWorker()];
    const report = healthReport(state, { now: Date.now() });
    expect(report.ok).toBe(true);
    expect(report.unhealthy).toBe(0);
    expect(report.backlog.breached).toBe(false);
  });
});

describe("health metrics export", () => {
  it("includes unhealthy and backlog gauges", () => {
    const state = emptyState();
    state.workers = [idleWorker({ status: "failed" })];
    state.queue.push({
      id: "old",
      task: { id: "old", agent: "builder", prompt: "x" },
      enqueuedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      status: "pending",
      attempts: 0,
      source: "cli",
      priority: 0,
    });
    const snap = metricsSnapshot(state);
    expect(snap.workers_unhealthy).toBe(1);
    expect(snap.backlog_slo_breached).toBe(1);
    expect(snap.backlog_oldest_age_ms).toBeGreaterThan(5 * 60_000);
    const text = metricsPrometheus(state);
    expect(text).toContain("ropex_workers_unhealthy 1");
    expect(text).toContain("ropex_backlog_slo_breached 1");
  });
});
