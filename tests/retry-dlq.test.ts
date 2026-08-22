import { describe, expect, it } from "vitest";
import { emptyState } from "../src/controller.ts";
import {
  claimPending,
  completeQueued,
  deadLetters,
  enqueueTask,
  queueSummary,
  requeueDead,
  retryBackoffMs,
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

function withAgent(state = emptyState()) {
  state.desired = [builderDesired()];
  state.workers = [worker()];
  return state;
}

describe("retry backoff", () => {
  it("doubles then caps", () => {
    expect(retryBackoffMs(1)).toBe(1_000);
    expect(retryBackoffMs(2)).toBe(2_000);
    expect(retryBackoffMs(3)).toBe(4_000);
    expect(retryBackoffMs(20)).toBe(15 * 60_000);
  });
});

describe("dead-letter + retry", () => {
  it("requeues failed claims with nextRetryAt until maxAttempts", () => {
    const state = withAgent();
    enqueueTask(state, { id: "t-retry", agent: "builder", prompt: "boom" });
    const t0 = Date.parse("2026-08-22T01:00:00.000Z");
    const { claimed } = claimPending(state, 1, { now: t0 });
    expect(claimed).toHaveLength(1);
    expect(state.workers[0].status).toBe("running");

    const after1 = completeQueued(state, "t-retry", false, "tool exploded", {
      maxAttempts: 3,
      now: t0,
    });
    expect(after1?.status).toBe("pending");
    expect(after1?.attempts).toBe(1);
    expect(after1?.nextRetryAt).toBe(new Date(t0 + 1_000).toISOString());
    expect(state.metrics.tasksRetried).toBe(1);
    expect(state.workers[0].status).toBe("idle");
    expect(queueSummary(state).waitingRetry).toBe(1);

    // Too early — not claimable
    expect(claimPending(state, 1, { now: t0 + 500 }).claimed).toHaveLength(0);

    const t1 = t0 + 1_000;
    expect(claimPending(state, 1, { now: t1 }).claimed).toHaveLength(1);
    completeQueued(state, "t-retry", false, "again", { maxAttempts: 3, now: t1 });
    expect(state.queue[0].attempts).toBe(2);
    expect(state.queue[0].status).toBe("pending");

    const t2 = Date.parse(state.queue[0].nextRetryAt!);
    claimPending(state, 1, { now: t2 });
    const dead = completeQueued(state, "t-retry", false, "final", { maxAttempts: 3, now: t2 });
    expect(dead?.status).toBe("dead");
    expect(state.metrics.tasksDead).toBe(1);
    expect(state.metrics.tasksFailed).toBe(1);
    expect(deadLetters(state)).toHaveLength(1);
    expect(queueSummary(state).dead).toBe(1);
  });

  it("requeueDead resets a dead letter for another cycle", () => {
    const state = withAgent();
    state.queue.push({
      id: "dlq-1",
      task: { id: "dlq-1", agent: "builder", prompt: "resurrect" },
      enqueuedAt: "2026-08-22T00:00:00.000Z",
      status: "dead",
      attempts: 3,
      source: "cli",
      priority: 0,
      error: "exhausted",
      finishedAt: "2026-08-22T00:01:00.000Z",
    });
    const item = requeueDead(state, "dlq-1");
    expect(item?.status).toBe("pending");
    expect(item?.attempts).toBe(0);
    expect(item?.error).toBeUndefined();
    expect(claimPending(state, 1).claimed[0]?.queueId).toBe("dlq-1");
  });

  it("exports dead and retry metrics", () => {
    const state = withAgent();
    state.metrics.tasksRetried = 4;
    state.metrics.tasksDead = 2;
    state.queue.push({
      id: "d1",
      task: { id: "d1", agent: "builder", prompt: "x" },
      enqueuedAt: "2026-08-22T00:00:00.000Z",
      status: "dead",
      attempts: 3,
      source: "cli",
      priority: 0,
    });
    const snap = metricsSnapshot(state);
    expect(snap.queue_dead).toBe(1);
    expect(snap.tasks_retried).toBe(4);
    expect(snap.tasks_dead).toBe(2);
    const text = metricsPrometheus(state);
    expect(text).toContain("ropex_queue_dead 1");
    expect(text).toContain("ropex_tasks_retried_total 4");
  });
});
