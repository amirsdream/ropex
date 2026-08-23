import { describe, expect, it } from "vitest";
import { planAutoscale } from "../src/autoscale.ts";
import { emptyState, planReconcile } from "../src/controller.ts";
import { enqueueTask } from "../src/queue.ts";
import { metricsSnapshot } from "../src/metrics.ts";
import { parseManifests } from "../src/spec.ts";

const yaml = `
apiVersion: ropex.dev/v1
kind: Policy
metadata:
  name: guard
spec:
  maxReplicas: 5
  permissions:
    deny: []
    requireApproval: []
---
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

describe("autoscale stub", () => {
  it("recommends scale-up when pending with no idle capacity", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    // Burn the only worker as running so idle=0
    next.workers[0].status = "running";
    for (let i = 0; i < 4; i++) {
      enqueueTask(next, { id: `j${i}`, agent: "builder", prompt: `work ${i}` });
    }
    const plan = planAutoscale(next);
    expect(plan.recommendations.length).toBe(1);
    const rec = plan.recommendations[0];
    expect(rec.delta).toBeGreaterThan(0);
    expect(rec.recommendedReplicas).toBeGreaterThan(rec.currentReplicas);
    expect(rec.recommendedReplicas).toBeLessThanOrEqual(5);
    expect(plan.yaml).toContain("kind: Agent");
    expect(plan.yaml).toContain("replicas:");
  });

  it("caps recommendations at Policy.maxReplicas", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    next.workers[0].status = "running";
    for (let i = 0; i < 20; i++) {
      enqueueTask(next, { id: `p${i}`, agent: "builder", prompt: "x" });
    }
    const plan = planAutoscale(next, { maxScaleUp: 100 });
    expect(plan.recommendations[0].recommendedReplicas).toBe(5);
    expect(plan.recommendations[0].cappedByPolicy).toBe(true);
  });

  it("recommends scale-down when idle surplus and empty queue", () => {
    const fat = yaml.replace("replicas: 1", "replicas: 4");
    const { next } = planReconcile(emptyState(), parseManifests(fat), "t");
    expect(next.workers.filter((w) => w.status !== "retired").length).toBe(4);
    const plan = planAutoscale(next, { idleSurplus: 1, minReplicas: 1 });
    expect(plan.recommendations.length).toBe(1);
    expect(plan.recommendations[0].delta).toBeLessThan(0);
    expect(plan.recommendations[0].recommendedReplicas).toBeGreaterThanOrEqual(1);
  });

  it("exposes recommendation count in metrics", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    next.workers[0].status = "running";
    enqueueTask(next, { id: "m1", agent: "builder", prompt: "x" });
    expect(metricsSnapshot(next).autoscale_recommendations).toBeGreaterThan(0);
  });
});
