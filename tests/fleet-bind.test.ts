import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyState, planReconcile } from "../src/controller.ts";
import { submitPipeline } from "../src/executor.ts";
import { closeInFlight } from "../src/fleet-bind.ts";
import { parseManifests } from "../src/spec.ts";

const yaml = `
apiVersion: ropex.dev/v1
kind: Fleet
metadata:
  name: review
spec:
  replicas: 1
  scale: onDemand
  maxConcurrent: 2
  template:
    spec:
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
`;

function loaded() {
  return planReconcile(emptyState(), parseManifests(yaml), "fleets/").next;
}

describe("fleet bind", () => {
  it("mints a working set on the first simple run and reuses it on the second", async () => {
    const state = loaded();
    const first = await submitPipeline(state, { simple: true, drain: false });
    expect(first.pipeline.fleet?.mode).toBe("mint");
    expect(first.pipeline.fleet?.agents).toEqual(["triage", "reviewer"]);
    expect(first.pipeline.fleet?.pinned).toBe(true);
    expect(state.inflightFleets?.find((f) => f.pipelineId === first.pipeline.id)?.status).toBe("open");

    const second = await submitPipeline(state, { simple: true, drain: false });
    expect(second.pipeline.fleet?.mode).toBe("reuse");
    expect(second.pipeline.fleet?.agents).toEqual(["triage", "reviewer"]);
    expect(state.fleetPins).toHaveLength(1);
  });

  it("reuses a named fleet and leaves other agents out of the plan", async () => {
    const state = loaded();
    const { pipeline } = await submitPipeline(state, {
      prompt: "Look at the review fleet only",
      fleet: "review",
      drain: false,
      pin: true,
    });
    expect(pipeline.fleet?.mode).toBe("reuse");
    expect(pipeline.fleet?.name).toBe("review");
    expect(pipeline.stages.every((s) => s.agent === "review")).toBe(true);
    expect(pipeline.stages.some((s) => s.agent === "triage")).toBe(false);
  });

  it("does not pin a one-off prompt", async () => {
    const state = loaded();
    const { pipeline } = await submitPipeline(state, {
      prompt: "Something we will not repeat",
      drain: false,
      pin: false,
    });
    expect(pipeline.fleet?.mode).toBe("mint");
    expect(pipeline.fleet?.pinned).toBe(false);
    expect(state.fleetPins ?? []).toHaveLength(0);
  });

  it("closes the in-flight fleet when the plan finishes and can reflect the pin", async () => {
    const state = loaded();
    const root = mkdtempSync(join(tmpdir(), "ropex-pin-"));
    const { pipeline } = await submitPipeline(state, {
      simple: true,
      drain: false,
      reflect: true,
      root,
    });
    closeInFlight(state, pipeline.id);
    expect(state.inflightFleets?.[0]?.status).toBe("closed");
    expect(state.fleetPins?.[0]?.reflected).toBe(join(root, ".ropex", "pinned", "simple.yaml"));
  });

  it("rejects a fleet name that is not loaded", async () => {
    const state = loaded();
    await expect(
      submitPipeline(state, { prompt: "no such fleet", fleet: "missing", drain: false }),
    ).rejects.toThrow(/unknown fleet: missing/);
  });
});
