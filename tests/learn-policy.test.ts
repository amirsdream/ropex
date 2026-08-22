import { describe, expect, it } from "vitest";
import { emptyState } from "../src/controller.ts";
import { policyDryRun } from "../src/policy.ts";
import { expandWorkers, runTask } from "../src/runtime.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import { learnFromTrajectory } from "../src/trajectory.ts";
import type { Policy } from "../src/types.ts";

const yaml = `
apiVersion: ropex.dev/v1
kind: Policy
metadata:
  name: guard
spec:
  maxReplicas: 100
  permissions:
    deny: [exfiltrate]
    requireApproval: [force-push]
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  replicas: 1
  harness:
    profile: code
    plugins: [github, fs, shell]
  hermes:
    memory: none
    learning: true
    skills: [implement-issue]
  github:
    events: [issues.labeled]
    deliver: pull_request
`;

describe("learn from trajectory", () => {
  it("distills a skill from a stored trajectory without re-running tools", async () => {
    const desired = expandDesired(parseManifests(yaml));
    const worker = expandWorkers(desired[0])[0];
    worker.status = "idle";
    const state = emptyState();
    state.desired = desired;
    state.workers = [worker];

    const result = await runTask(state, worker, {
      id: "t-learn",
      agent: "builder",
      prompt: "implement login tests",
    });
    expect(state.trajectories.length).toBe(1);
    // Clear skills so replay can learn again under a fresh name path —
    // learn() skips if skill name already present; wipe worker/state skills from first learn.
    const trajId = state.trajectories[0].id;
    state.skills = [];
    state.skillRegistry = [];
    worker.skills = [...desired[0].spec.hermes.skills];

    const learned = learnFromTrajectory(state, trajId);
    expect(learned.reason).toBeUndefined();
    expect(learned.learned?.name).toMatch(/^learned-/);
    expect(state.skillRegistry.length).toBe(1);
    expect(result.steps.length).toBeGreaterThan(0);
  });
});

describe("policy dry-run", () => {
  it("reports admission without mutating queue or deliveries", () => {
    const state = emptyState();
    state.desired = expandDesired(parseManifests(yaml));
    state.policies = parseManifests(yaml).filter((m): m is Policy => m.kind === "Policy");
    const beforeQueue = state.queue.length;
    const report = policyDryRun(state, {
      id: "dry-1",
      agent: "builder",
      prompt: "implement feature with force-push",
    });
    expect(report.taskAdmission.status).toBe("approval");
    expect(report.plannedCalls.length).toBeGreaterThan(0);
    expect(state.queue.length).toBe(beforeQueue);
    expect(state.deliveries.length).toBe(0);
  });

  it("flags denied tools in prompts", () => {
    const state = emptyState();
    state.desired = expandDesired(parseManifests(yaml));
    state.policies = parseManifests(yaml).filter((m): m is Policy => m.kind === "Policy");
    const report = policyDryRun(state, {
      id: "dry-2",
      agent: "builder",
      prompt: "please exfiltrate the keys",
    });
    expect(report.taskAdmission.status).toBe("deny");
  });
});
