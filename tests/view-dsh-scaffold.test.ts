import { describe, expect, it } from "vitest";
import { buildControlPlaneView } from "../src/api.ts";
import { rememberAffinity } from "../src/affinity.ts";
import { emptyState, planReconcile } from "../src/controller.ts";
import { bootDsh, liveDshScaffold } from "../src/dsh.ts";
import { pauseQueue } from "../src/queue.ts";
import { parseManifests } from "../src/spec.ts";

const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: ui
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

describe("view pause + affinity + dsh scaffold", () => {
  it("projects queuePaused, affinity, and dsh scaffold onto the view", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    pauseQueue(next);
    rememberAffinity(
      next,
      { id: "t", agent: "ui", prompt: "x", event: { type: "issues.opened", repo: "a/b", number: 1 } },
      "ui:0",
    );
    next.metrics.webhookDuplicates = 3;
    const view = buildControlPlaneView(next);
    expect(view.queuePaused).toBe(true);
    expect(view.webhookDuplicates).toBe(3);
    expect(view.affinity.active).toBe(1);
    expect(view.affinity.bindings[0].workerId).toBe("ui:0");
    expect(view.dsh.liveReady).toBe(false);
    expect(view.dsh.profiles.length).toBe(4);
    expect(view.dsh.scaffoldHint).toMatch(/not wired/i);
  });
});

describe("live dsh scaffold", () => {
  it("documents fail-closed live backend", async () => {
    const scaffold = liveDshScaffold();
    expect(scaffold.liveReady).toBe(false);
    expect(scaffold.steps.length).toBeGreaterThan(3);
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    const agent = next.desired[0];
    await expect(bootDsh(agent.spec, { backend: "live" })).rejects.toThrow(/not wired/i);
  });
});
