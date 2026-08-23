import { describe, expect, it } from "vitest";
import { emptyState, planReconcile } from "../src/controller.ts";
import { parseManifests } from "../src/spec.ts";

const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: triage
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
---
apiVersion: ropex.dev/v1
kind: Fleet
metadata:
  name: swarm
spec:
  scale: static
  replicas: 5
  template:
    spec:
      harness:
        profile: standard
        plugins: [github, fs, shell]
      hermes:
        memory: sqlite
        learning: true
        skills: [open-pr]
`;

describe("reconcile", () => {
  it("derives workers from git desired state", () => {
    const { next, plan } = planReconcile(emptyState(), parseManifests(yaml), "fleets/");
    expect(plan.create).toHaveLength(8);
    expect(next.workers.filter((w) => w.status !== "retired")).toHaveLength(8);
    expect(next.workers.some((w) => w.id === "swarm-0:0")).toBe(true);
  });

  it("retires workers when the fleet shrinks", () => {
    const first = planReconcile(emptyState(), parseManifests(yaml), "fleets/").next;
    const shrunk = yaml.replace("replicas: 5", "replicas: 1");
    const { plan, next } = planReconcile(first, parseManifests(shrunk), "fleets/");
    expect(plan.retire).toHaveLength(4);
    expect(next.workers.filter((w) => w.status !== "retired")).toHaveLength(4);
  });
});
