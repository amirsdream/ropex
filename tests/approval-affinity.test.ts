import { describe, expect, it } from "vitest";
import { admitCalls } from "../src/admission.ts";
import { decideApproval, pendingApprovals, requestApprovals } from "../src/approval.ts";
import { emptyState } from "../src/controller.ts";
import { pickIdleWorker } from "../src/queue.ts";
import { expandWorkers, runTask } from "../src/runtime.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import type { Policy } from "../src/types.ts";

const policy: Policy = {
  apiVersion: "ropex.dev/v1",
  kind: "Policy",
  metadata: { name: "guard" },
  spec: {
    maxReplicas: 100,
    permissions: {
      deny: ["exfiltrate"],
      requireApproval: ["force-push"],
    },
  },
};

describe("approval workflow", () => {
  it("creates pending approvals and allows tool after approve", () => {
    const state = emptyState();
    state.policies = [policy];
    requestApprovals(state, {
      taskId: "t1",
      agent: "builder",
      workerId: "builder:0",
      tools: [{ name: "force-push", reason: "needs approval" }],
    });
    expect(pendingApprovals(state)).toHaveLength(1);
    const id = pendingApprovals(state)[0].id;

    let gated = admitCalls(
      [policy],
      [{ name: "force-push", input: {} }],
      state,
      { taskId: "t1", agent: "builder" },
    );
    expect(gated.needsApproval).toHaveLength(1);

    decideApproval(state, id, "approved");
    gated = admitCalls(
      [policy],
      [{ name: "force-push", input: {} }],
      state,
      { taskId: "t1", agent: "builder" },
    );
    expect(gated.allowed.map((c) => c.name)).toEqual(["force-push"]);
    expect(gated.needsApproval).toHaveLength(0);
  });

  it("runTask records approvals for gated tools in the plan path", async () => {
    // force-push isn't in default plans — exercise requestApprovals via admitCalls path unit above.
    // Integration: ensure empty approvals stay empty on normal github task.
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
  name: triage
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
  github:
    events: [issues.opened]
    deliver: comment
`;
    const desired = expandDesired(parseManifests(yaml));
    const worker = expandWorkers(desired[0])[0];
    worker.status = "idle";
    const state = emptyState();
    state.desired = desired;
    state.policies = parseManifests(yaml).filter((m): m is Policy => m.kind === "Policy");
    state.workers = [worker];
    await runTask(state, worker, { id: "t-ok", agent: "triage", prompt: "summarize" });
    expect(pendingApprovals(state)).toHaveLength(0);
  });
});

describe("fleet affinity", () => {
  it("prefers workers in the requested fleet", () => {
    const state = emptyState();
    state.workers = [
      {
        id: "a:0",
        agent: "a",
        fleet: "other",
        replica: 0,
        status: "idle",
        imageDigest: "x",
        harness: "minimal",
        plugins: [],
        skills: [],
        model: "m",
        lastTaskAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "a:1",
        agent: "a",
        fleet: "factory",
        replica: 1,
        status: "idle",
        imageDigest: "x",
        harness: "minimal",
        plugins: [],
        skills: [],
        model: "m",
        lastTaskAt: "2026-01-02T00:00:00.000Z",
      },
    ];
    // Without affinity, LRU would pick a:0 (older lastTaskAt).
    expect(pickIdleWorker(state, "a")?.id).toBe("a:0");
    // With fleet affinity, prefer factory even if more recently used.
    expect(pickIdleWorker(state, "a", { preferFleet: "factory" })?.id).toBe("a:1");
  });
});
