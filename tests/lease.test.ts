import { describe, expect, it } from "vitest";
import { emptyState } from "../src/controller.ts";
import {
  claimPending,
  enqueueTask,
  heartbeatClaim,
  queueSummary,
  reclaimExpiredLeases,
} from "../src/queue.ts";
import { metricsPrometheus, metricsSnapshot } from "../src/metrics.ts";
import { buildAgentImage } from "../src/image.ts";
import type { DesiredAgent, Worker } from "../src/types.ts";

function builderDesired(): DesiredAgent {
  return {
    apiVersion: "ropex.dev/v1",
    kind: "Agent",
    metadata: { name: "builder" },
    spec: {
      replicas: 1,
      harness: { profile: "code", plugins: ["github"] },
      hermes: { memory: "none", learning: false, skills: [] },
    },
  } as DesiredAgent;
}

function worker(overrides: Partial<Worker> = {}): Worker {
  const desired = builderDesired();
  return {
    id: "builder:0",
    agent: "builder",
    replica: 0,
    status: "idle",
    imageDigest: buildAgentImage(desired).digest,
    harness: "code",
    plugins: ["github"],
    skills: [],
    model: "deepseek-v4-pro",
    ...overrides,
  };
}

function withAgent() {
  const state = emptyState();
  state.desired = [builderDesired()];
  state.workers = [worker()];
  return state;
}

describe("claim leases", () => {
  it("sets lease on claim and extends via heartbeat", () => {
    const state = withAgent();
    enqueueTask(state, { id: "lease-1", agent: "builder", prompt: "work" });
    const now = Date.parse("2026-08-22T02:00:00.000Z");
    const { claimed } = claimPending(state, 1, { now, leaseMs: 60_000 });
    expect(claimed).toHaveLength(1);
    const item = state.queue[0];
    expect(item.leaseExpiresAt).toBe(new Date(now + 60_000).toISOString());
    expect(item.heartbeatAt).toBe(item.claimedAt);

    const later = now + 30_000;
    heartbeatClaim(state, "lease-1", { now: later, leaseMs: 60_000 });
    expect(item.heartbeatAt).toBe(new Date(later).toISOString());
    expect(item.leaseExpiresAt).toBe(new Date(later + 60_000).toISOString());
  });

  it("reclaims expired leases into retry pending", () => {
    const state = withAgent();
    enqueueTask(state, { id: "stale", agent: "builder", prompt: "hang" });
    const t0 = Date.parse("2026-08-22T02:00:00.000Z");
    claimPending(state, 1, { now: t0, leaseMs: 10_000 });
    expect(state.workers[0].status).toBe("running");
    expect(queueSummary(state).claimed).toBe(1);

    const { reclaimed } = reclaimExpiredLeases(state, {
      now: t0 + 10_001,
      maxAttempts: 3,
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].status).toBe("pending");
    expect(reclaimed[0].error).toBe("lease expired");
    expect(state.workers[0].status).toBe("idle");
    expect(state.metrics.leasesReclaimed).toBe(1);
    expect(state.metrics.tasksRetried).toBe(1);
    expect(queueSummary(state).claimed).toBe(0);
  });

  it("claimPending auto-reclaims before new claims", () => {
    const state = withAgent();
    enqueueTask(state, { id: "a", agent: "builder", prompt: "one" });
    const t0 = Date.parse("2026-08-22T03:00:00.000Z");
    claimPending(state, 1, { now: t0, leaseMs: 5_000 });
    // Worker stuck running with expired lease; add another task.
    enqueueTask(state, { id: "b", agent: "builder", prompt: "two" });
    const again = claimPending(state, 1, { now: t0 + 6_000, leaseMs: 5_000 });
    expect(state.metrics.leasesReclaimed).toBeGreaterThanOrEqual(1);
    // After reclaim, worker idle — can claim either requeued a or new b.
    expect(again.claimed.length + queueSummary(state).pending).toBeGreaterThan(0);
    expect(state.workers[0].status).toBe("running");
  });

  it("exports lease reclaim metrics", () => {
    const state = withAgent();
    state.metrics.leasesReclaimed = 7;
    const snap = metricsSnapshot(state);
    expect(snap.leases_reclaimed).toBe(7);
    expect(metricsPrometheus(state)).toContain("ropex_leases_reclaimed_total 7");
  });
});
