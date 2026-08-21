import { describe, expect, it } from "vitest";
import { emptyState } from "../src/controller.ts";
import { expandWorkers, runTask } from "../src/runtime.ts";
import { parseManifests, expandDesired } from "../src/spec.ts";

const yaml = `
apiVersion: ropex.dev/v1
kind: Policy
metadata:
  name: guard
spec:
  maxReplicas: 100
  permissions:
    deny: [exfiltrate]
    requireApproval: []
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  replicas: 1
  harness:
    profile: code
    model: deepseek-v4-pro
    plugins: [github, fs, shell]
  hermes:
    memory: sqlite
    learning: true
    skills: [implement-issue]
  github:
    events: [issues.labeled]
    deliver: pull_request
`;

describe("runtime", () => {
  it("plans with Hermes and executes through the DeepSeek-style harness", async () => {
    const desired = expandDesired(parseManifests(yaml));
    const agent = desired[0];
    const worker = expandWorkers(agent)[0];
    const state = emptyState();
    state.desired = desired;
    state.policies = parseManifests(yaml).filter((m) => m.kind === "Policy");
    worker.status = "running";
    state.workers = [worker];

    const result = await runTask(state, worker, {
      id: "t1",
      agent: "builder",
      prompt: "implement login tests",
    });

    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps.some((s) => s.calls.some((c) => c.name === "github"))).toBe(true);
    expect(result.delivery?.kind).toBe("pull_request");
    expect(result.learned?.name).toMatch(/^learned-/);
    expect(worker.skills).toContain(result.learned?.name);
    expect(worker.status).toBe("idle");
  });
});
