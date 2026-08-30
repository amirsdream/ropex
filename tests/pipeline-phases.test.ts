import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyState, planReconcile } from "../src/controller.ts";
import { parseManifests } from "../src/spec.ts";
import { drainPipeline, pipelinePhase, submitPipeline } from "../src/executor.ts";
import {
  WORKFLOW_PHASE_ORDER,
  WORKFLOW_STAGES,
  workflowPhases,
} from "../src/workflow.ts";

const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: researcher
spec:
  scale: static
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
kind: Policy
metadata:
  name: cap
spec:
  maxReplicas: 10
  permissions:
    deny: []
    requireApproval: []
`;

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("workflow phase spine", () => {
  it("assigns every stage to exactly one ordered phase", () => {
    for (const stage of WORKFLOW_STAGES) {
      expect(WORKFLOW_PHASE_ORDER).toContain(stage.phase);
    }
    expect(WORKFLOW_STAGES.find((s) => s.id === "compose")?.phase).toBe("intake");
    expect(WORKFLOW_STAGES.find((s) => s.id === "plan")?.phase).toBe("intake");
    expect(WORKFLOW_STAGES.find((s) => s.id === "execute")?.phase).toBe("execute");
    expect(WORKFLOW_STAGES.find((s) => s.id === "deliver")?.phase).toBe("result");
    expect(WORKFLOW_STAGES.find((s) => s.id === "learn")?.phase).toBe("result");
  });

  it("groups the flat stage list into start → execute → result", () => {
    const phases = workflowPhases();
    expect(phases.map((p) => p.phase)).toEqual(["intake", "execute", "result"]);
    expect(phases.map((p) => p.label)).toEqual(["Start", "Execute", "Result"]);
    expect(phases[0].stages.map((s) => s.id)).toEqual(["compose", "plan"]);
    expect(phases[1].stages.map((s) => s.id)).toEqual(["execute"]);
    expect(phases[2].stages.map((s) => s.id)).toEqual(["deliver", "learn"]);
    // Grouping is total and lossless.
    const regrouped = phases.flatMap((p) => p.stages);
    expect(regrouped).toHaveLength(WORKFLOW_STAGES.length);
  });
});

describe("pipeline start and result boundaries", () => {
  it("captures the Start point (input) when the run is accepted", async () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "fleets/");
    const { pipeline } = await submitPipeline(next, {
      prompt: "Research LangGraph alternatives",
      drain: false,
      agents: ["researcher"],
      stages: [{ id: "only", agent: "researcher", prompt: "scoped" }],
    });
    expect(pipeline.input.prompt).toBe("Research LangGraph alternatives");
    expect(pipeline.input.agents).toEqual(["researcher"]);
    expect(pipeline.input.at).toBeTruthy();
    // Not terminal yet — no Result point, and phase reflects intake before any stage runs.
    expect(pipeline.result).toBeUndefined();
    expect(pipelinePhase(pipeline)).toBe("intake");
  });

  it("sets the Result point exactly once when the run finishes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-phase-"));
    temps.push(root);
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "fleets/");
    const { pipeline } = await submitPipeline(next, {
      prompt: "Compare React vs Vue",
      root,
      drain: true,
      stages: [{ id: "only", agent: "researcher", prompt: "compare" }],
    });

    expect(pipeline.status).toBe("done");
    expect(pipelinePhase(pipeline)).toBe("result");
    expect(pipeline.result).toBeDefined();
    expect(pipeline.result?.status).toBe("done");
    expect(pipeline.result?.stageCount).toBe(pipeline.stages.length);
    expect(pipeline.result?.producedBy).toContain("researcher");
    expect(pipeline.result?.output).toBe(pipeline.output);

    // Re-draining a finished run does not mint a second Result point.
    const firstAt = pipeline.result?.at;
    await drainPipeline(next, pipeline.id, { root });
    expect(pipeline.result?.at).toBe(firstAt);
  });
});
