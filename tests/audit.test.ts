import { describe, expect, it } from "vitest";
import { AUDIT_MAX, auditsFor, exportAuditJsonl, recordAudit } from "../src/audit.ts";
import { emptyState, planReconcile } from "../src/controller.ts";
import { enqueueTask, claimPending, completeQueued } from "../src/queue.ts";
import { metricsPrometheus, metricsSnapshot } from "../src/metrics.ts";
import { parseManifests } from "../src/spec.ts";
import { buildAgentImage } from "../src/image.ts";
import type { DesiredAgent, Worker } from "../src/types.ts";

function builderDesired(): DesiredAgent {
  return {
    apiVersion: "ropex.dev/v1",
    kind: "Agent",
    metadata: { name: "builder" },
    spec: {
      scale: "static" as const,
      replicas: 1,
      harness: { profile: "code", plugins: ["github"] },
      hermes: { memory: "none", learning: false, skills: [] },
    },
  } as DesiredAgent;
}

const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  harness:
    profile: code
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
`;

describe("audit trail", () => {
  it("records reconcile and queue lifecycle", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "test");
    expect(auditsFor(next, { kind: "reconcile" }).length).toBe(1);
    expect(next.audit[0].kind).toBe("reconcile");

    enqueueTask(next, { id: "t1", agent: "builder", prompt: "ship it" });
    expect(auditsFor(next, { kind: "enqueue", taskId: "t1" })).toHaveLength(1);

    const { claimed } = claimPending(next, 1);
    expect(claimed).toHaveLength(1);
    expect(auditsFor(next, { kind: "claim" }).length).toBeGreaterThan(0);

    completeQueued(next, "t1", true);
    expect(auditsFor(next, { kind: "complete" })).toHaveLength(1);
  });

  it("exports jsonl and trims at AUDIT_MAX", () => {
    const state = emptyState();
    for (let i = 0; i < AUDIT_MAX + 10; i++) {
      recordAudit(state, { kind: "info", message: `n=${i}` });
    }
    expect(state.audit.length).toBe(AUDIT_MAX);
    const jsonl = exportAuditJsonl(state, { limit: 3 });
    const lines = jsonl.trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("exposes audit_events metric", () => {
    const state = emptyState();
    recordAudit(state, { kind: "info", message: "ping" });
    expect(metricsSnapshot(state).audit_events).toBe(1);
    expect(metricsPrometheus(state)).toContain("ropex_audit_events 1");
  });

  it("records retry then dead on exhausted attempts", () => {
    const state = emptyState();
    state.desired = [builderDesired()];
    state.workers = [
      {
        id: "builder:0",
        agent: "builder",
        replica: 0,
        status: "idle",
        imageDigest: buildAgentImage(builderDesired()).digest,
        harness: "code",
        plugins: ["github"],
        skills: [],
        model: "m",
      } as Worker,
    ];
    enqueueTask(state, { id: "fail", agent: "builder", prompt: "x" });
    const t0 = Date.parse("2026-08-22T04:00:00.000Z");
    claimPending(state, 1, { now: t0 });
    completeQueued(state, "fail", false, "boom", { maxAttempts: 2, now: t0 });
    expect(auditsFor(state, { kind: "retry" }).length).toBe(1);
    const t1 = Date.parse(state.queue[0].nextRetryAt!);
    claimPending(state, 1, { now: t1 });
    completeQueued(state, "fail", false, "boom", { maxAttempts: 2, now: t1 });
    expect(auditsFor(state, { kind: "dead" }).length).toBe(1);
  });
});
