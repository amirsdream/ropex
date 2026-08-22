import { describe, expect, it } from "vitest";
import { emptyState, planReconcile } from "../src/controller.ts";
import { rememberAffinity, lookupAffinity } from "../src/affinity.ts";
import { compactJournal } from "../src/journal.ts";
import {
  claimPending,
  completeQueued,
  enqueueTask,
  pauseQueue,
  resumeQueue,
} from "../src/queue.ts";
import { controlPlaneTick } from "../src/tick.ts";
import { parseManifests } from "../src/spec.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: sticky
spec:
  replicas: 2
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
`;

describe("queue pause", () => {
  it("blocks claims while paused", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    enqueueTask(next, { id: "p1", agent: "sticky", prompt: "x" });
    pauseQueue(next);
    expect(claimPending(next, 1).claimed).toHaveLength(0);
    resumeQueue(next);
    expect(claimPending(next, 1).claimed).toHaveLength(1);
  });
});

describe("sticky affinity", () => {
  it("prefers last successful worker for same agent/repo", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    const a = next.workers.find((w) => w.replica === 0)!;
    const b = next.workers.find((w) => w.replica === 1)!;
    const task = {
      id: "s1",
      agent: "sticky",
      prompt: "work",
      event: { type: "issues.opened", repo: "acme/app", number: 1 },
    };
    rememberAffinity(next, task, b.id, { now: Date.now(), ttlMs: 60_000 });
    expect(lookupAffinity(next, task)?.workerId).toBe(b.id);
    enqueueTask(next, task);
    const { claimed } = claimPending(next, 1);
    expect(claimed[0].workerId).toBe(b.id);
    // completing remembers affinity (already set)
    completeQueued(next, "s1", true);
    expect(a.status === "idle" || a.status === "pending" || a.status === "running").toBe(true);
  });
});

describe("journal compact", () => {
  it("keeps newest N deliveries", () => {
    const state = emptyState();
    for (let i = 0; i < 10; i++) {
      state.deliveries.push({
        id: `d${i}`,
        at: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        kind: "comment",
        body: `b${i}`,
        workerId: "w",
        agent: "a",
        taskId: `t${i}`,
        imageDigest: "x".repeat(16),
      });
    }
    const result = compactJournal(state, { keep: 3 });
    expect(result.removed).toBe(7);
    expect(state.deliveries).toHaveLength(3);
    expect(state.deliveries.map((d) => d.id)).toEqual(["d7", "d8", "d9"]);
  });
});

describe("tick hooks", () => {
  it("runs age + compact without draining when paused", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-tick-hooks-"));
    temps.push(root);
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t", { root });
    enqueueTask(next, { id: "old", agent: "sticky", prompt: "x" });
    next.queue[0].enqueuedAt = new Date(Date.now() - 120_000).toISOString();
    next.queue[0].priority = 0;
    pauseQueue(next);
    for (let i = 0; i < 5; i++) {
      next.deliveries.push({
        id: `d${i}`,
        at: new Date(Date.now() + i).toISOString(),
        kind: "comment",
        body: "x",
        workerId: "w",
        agent: "sticky",
        taskId: `t${i}`,
        imageDigest: "y".repeat(16),
      });
    }
    const result = await controlPlaneTick(root, next, {
      persist: false,
      age: true,
      compactJournalKeep: 2,
      skipSync: true,
      skipAutoscale: true,
    });
    expect(result.paused).toBe(true);
    expect(result.drained).toHaveLength(0);
    expect(result.aged).toBeGreaterThanOrEqual(1);
    expect(result.journal?.after).toBe(2);
    expect(next.queue[0].priority).toBeGreaterThan(0);
  });
});
