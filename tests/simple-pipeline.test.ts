import { describe, expect, it } from "vitest";
import { emptyState, planReconcile } from "../src/controller.ts";
import { submitPipeline } from "../src/executor.ts";
import { simplePipelinePlan } from "../src/pipeline.ts";
import { parseManifests } from "../src/spec.ts";

const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: onDemand
  maxConcurrent: 1
  idleTTLMs: 0
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: none
    learning: false
    skills: []
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: triage
spec:
  scale: onDemand
  maxConcurrent: 1
  idleTTLMs: 0
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: none
    learning: false
    skills: []
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: reviewer
spec:
  scale: onDemand
  maxConcurrent: 1
  idleTTLMs: 0
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: none
    learning: false
    skills: []
---
apiVersion: ropex.dev/v1
kind: Policy
metadata:
  name: cap
spec:
  maxReplicas: 4
  permissions:
    deny: []
    requireApproval: []
`;

describe("simple pipeline", () => {
  it("plans triage then reviewer and ignores keyword stage splitting", async () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "fleets/");
    const planned = simplePipelinePlan(next);
    expect(planned.map((s) => [s.id, s.agent])).toEqual([
      ["look", "triage"],
      ["check", "reviewer"],
    ]);

    const { pipeline } = await submitPipeline(next, {
      simple: true,
      drain: false,
      prompt: "Compare React vs Vue for a dashboard",
    });
    expect(pipeline.stages.map((s) => s.agent)).toEqual(["triage", "reviewer"]);
    expect(pipeline.stages.map((s) => s.id)).toEqual(["look", "check"]);
    expect(pipeline.prompt).toMatch(/one sentence/);
  });

  it("uses a single stage when the fleet has one agent", () => {
    const solo = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: docbot
spec:
  scale: onDemand
  maxConcurrent: 1
  idleTTLMs: 0
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: none
    learning: false
    skills: []
---
apiVersion: ropex.dev/v1
kind: Policy
metadata:
  name: cap
spec:
  maxReplicas: 2
  permissions:
    deny: []
    requireApproval: []
`;
    const { next } = planReconcile(emptyState(), parseManifests(solo), "fleets/");
    expect(simplePipelinePlan(next).map((s) => s.agent)).toEqual(["docbot"]);
  });
});
