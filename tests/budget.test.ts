import { describe, expect, it } from "vitest";
import { emptyState, planReconcile } from "../src/controller.ts";
import { chargeBudget, budgetReport, admitBudget } from "../src/budget.ts";
import { enqueueTask, claimPending, completeQueued, queueSummary } from "../src/queue.ts";
import { parseManifests } from "../src/spec.ts";

const yaml = `
apiVersion: ropex.dev/v1
kind: Policy
metadata:
  name: guard
spec:
  maxReplicas: 10
  permissions:
    deny: []
    requireApproval: []
  budget:
    maxUnits: 5
    windowMs: 3600000
    scope: cluster
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  replicas: 1
  harness:
    profile: code
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
`;

describe("budget accounting", () => {
  it("charges profile-weighted units on task completion", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    enqueueTask(next, { id: "b1", agent: "builder", prompt: "ship" });
    claimPending(next, 1);
    completeQueued(next, "b1", true);
    const report = budgetReport(next);
    expect(report).toHaveLength(1);
    // code profile = 3 units
    expect(report[0].spent).toBe(3);
    expect(report[0].remaining).toBe(2);
  });

  it("denies enqueue when budget would be exhausted", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    chargeBudget(next, { id: "seed", agent: "builder", prompt: "x" }, { units: 5 });
    const decision = admitBudget(next, { id: "n", agent: "builder", prompt: "more" });
    expect(decision.status).toBe("deny");
    const item = enqueueTask(next, { id: "n", agent: "builder", prompt: "more" });
    expect(item.status).toBe("failed");
    expect(queueSummary(next).failed).toBe(1);
  });

  it("rolls the window and resets spend", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    const t0 = Date.parse("2026-08-22T06:00:00.000Z");
    chargeBudget(next, { id: "a", agent: "builder", prompt: "x" }, { now: t0, units: 5 });
    expect(budgetReport(next, { now: t0 })[0].exhausted).toBe(true);
    const later = t0 + 3_600_000;
    const status = budgetReport(next, { now: later })[0];
    expect(status.spent).toBe(0);
    expect(status.exhausted).toBe(false);
  });
});
