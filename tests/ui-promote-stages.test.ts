import { describe, expect, it } from "vitest";
import { buildControlPlaneView } from "../src/api.ts";
import { emptyState, planReconcile } from "../src/controller.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import { promoteSkill, registerSkill, skillVersions } from "../src/skills.ts";
import { metricsPrometheus } from "../src/metrics.ts";
import { recordTrajectory, workflowStageCounts } from "../src/trajectory.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const agentYaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: a
spec:
  replicas: 1
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: b
spec:
  replicas: 1
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
`;

describe("control plane UI drift + fairness", () => {
  it("projects drift and fairness onto the view model", () => {
    const { next } = planReconcile(emptyState(), parseManifests(agentYaml), "t");
    next.workers[0].imageDigest = "stale".padEnd(16, "x");
    const view = buildControlPlaneView(next);
    expect(view.drift.ok).toBe(false);
    expect(view.drift.summary.digest).toBeGreaterThanOrEqual(1);
    expect(view.fairness.claimWaitP50Ms).toBeDefined();
    expect(Array.isArray(view.fairness.topWorkers)).toBe(true);
  });
});

describe("skill promote + versions", () => {
  it("promotes latest skill to all desired agents", () => {
    const state = emptyState();
    state.desired = expandDesired(parseManifests(agentYaml));
    registerSkill(state, {
      name: "label-hygiene",
      agent: "a",
      fromTask: "t1",
      at: new Date().toISOString(),
    });
    const rec = promoteSkill(state, "label-hygiene");
    expect(rec?.sharedWith).toContain("b");
    expect(skillVersions(state, "label-hygiene")).toHaveLength(1);
  });
});

describe("workflow stage metrics", () => {
  it("counts stages from recorded trajectories", () => {
    const state = emptyState();
    recordTrajectory(state, {
      task: { id: "t1", agent: "a", prompt: "x" },
      worker: {
        id: "a:0",
        agent: "a",
        replica: 0,
        status: "idle",
        imageDigest: "d".repeat(16),
        harness: "minimal",
        plugins: [],
        skills: [],
        model: "m",
      },
      imageDigest: "d".repeat(16),
      workflow: [
        { id: "compose", owner: "hermes" },
        { id: "plan", owner: "hermes" },
        { id: "execute", owner: "deepseek" },
        { id: "deliver", owner: "deepseek" },
        { id: "learn", owner: "hermes" },
      ],
      plan: ["do"],
      steps: [{ thought: "t", calls: [], observation: "o" }],
      output: "done",
    });
    const counts = workflowStageCounts(state);
    expect(counts.compose).toBe(1);
    expect(counts.learn).toBe(1);
    expect(metricsPrometheus(state)).toContain("ropex_workflow_plan_total 1");
  });
});

describe("placement fleet example", () => {
  it("parses placement on examples yaml", () => {
    const text = readFileSync(
      join(process.cwd(), "fleets/examples/github-control-plane.yaml"),
      "utf8",
    );
    const manifests = parseManifests(text);
    const agents = expandDesired(manifests);
    const triage = agents.find((a) => a.metadata.name === "triage");
    expect(triage?.spec.placement?.require?.role).toBe("github");
    const factory = agents.find((a) => a.metadata.name === "pr-factory-0");
    expect(factory?.spec.placement?.taints?.[0]?.key).toBe("builder");
    expect(factory?.metadata.labels?.zone).toBe("build");
  });
});
