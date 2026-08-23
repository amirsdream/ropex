import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { emptyState, planReconcile } from "../src/controller.ts";
import { enqueueTask, claimPending, queueSummary } from "../src/queue.ts";
import { drainQueue } from "../src/scheduler.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import {
  promoteWorkerMemory,
  resolveMaxConcurrent,
  resolveScaleMode,
  spawnWorker,
} from "../src/scale.ts";
import { SharedMemoryStore, memoryContextFor } from "../src/memory.ts";

const onDemandYaml = `
apiVersion: ropex.dev/v1
kind: Policy
metadata:
  name: cap
spec:
  maxReplicas: 10
  permissions:
    deny: []
    requireApproval: []
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: triage
spec:
  scale: onDemand
  maxConcurrent: 2
  idleTTLMs: 0
  harness:
    profile: minimal
    plugins: [github, fs]
  hermes:
    memory: shared
    share:
      read: [agent]
      write: agent
    learning: true
    skills: [issue-triage]
  github:
    events: [issues.opened]
    deliver: comment
---
apiVersion: ropex.dev/v1
kind: Fleet
metadata:
  name: builders
spec:
  scale: onDemand
  maxConcurrent: 3
  replicas: 3
  template:
    spec:
      harness:
        profile: code
        plugins: [github, fs]
      hermes:
        memory: shared
        share:
          read: [agent, fleet]
          write: agent
        learning: true
        skills: [implement]
`;

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("on-demand orchestration", () => {
  it("resolves scale mode and concurrency", () => {
    expect(resolveScaleMode({ replicas: 3 })).toBe("static");
    expect(resolveScaleMode({ scale: "onDemand", maxConcurrent: 4 })).toBe("onDemand");
    expect(resolveScaleMode({ maxConcurrent: 2 })).toBe("onDemand");
    expect(resolveMaxConcurrent({ scale: "onDemand", maxConcurrent: 5 })).toBe(5);
    expect(resolveMaxConcurrent({ scale: "onDemand", replicas: 7 })).toBe(7);
  });

  it("expands fleet onDemand to one agent definition", () => {
    const desired = expandDesired(parseManifests(onDemandYaml));
    expect(desired.map((a) => a.metadata.name).sort()).toEqual(["builders", "triage"]);
    expect(desired.find((a) => a.metadata.name === "builders")?.spec.maxConcurrent).toBe(3);
    expect(desired.find((a) => a.metadata.name === "triage")?.spec.scale).toBe("onDemand");
  });

  it("reconcile creates no warm idle workers for onDemand", () => {
    const { next, plan } = planReconcile(emptyState(), parseManifests(onDemandYaml), "fleets/");
    expect(plan.create).toHaveLength(0);
    expect(next.workers.filter((w) => w.status !== "retired")).toHaveLength(0);
    expect(next.desired).toHaveLength(2);
  });

  it("spawns on claim and destroys after drain (idleTTL 0)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-od-"));
    temps.push(root);
    const { next } = planReconcile(emptyState(), parseManifests(onDemandYaml), "fleets/", { root });
    enqueueTask(next, { id: "t1", agent: "triage", prompt: "triage this issue" }, "cli");
    enqueueTask(next, { id: "t2", agent: "triage", prompt: "another issue" }, "cli");

    const results = await drainQueue(next, { root, concurrency: 2 });
    expect(results).toHaveLength(2);
    expect(queueSummary(next).done).toBe(2);
    const live = next.workers.filter((w) => w.status !== "retired");
    expect(live).toHaveLength(0);
    expect(next.workers.some((w) => w.status === "retired")).toBe(true);
  });

  it("respects maxConcurrent when claiming", () => {
    const { next } = planReconcile(emptyState(), parseManifests(onDemandYaml), "fleets/");
    for (let i = 0; i < 5; i++) {
      enqueueTask(next, { id: `p${i}`, agent: "triage", prompt: `p${i}` }, "cli");
    }
    const { claimed, remaining } = claimPending(next, 10);
    expect(claimed).toHaveLength(2);
    expect(remaining).toBe(3);
    expect(next.workers.filter((w) => w.status === "running")).toHaveLength(2);
  });

  it("keeps agent memory after worker destroy", () => {
    const { next } = planReconcile(emptyState(), parseManifests(onDemandYaml), "fleets/");
    const w = spawnWorker(next, "triage", { status: "idle" })!;
    const store = SharedMemoryStore.fromState(next);
    const ctx = memoryContextFor(w, next.desired[0].spec.hermes);
    // Force a worker-scoped write then promote on destroy
    const noneCtx = {
      ...ctx,
      policy: { read: ["worker", "agent"], write: "worker" as const },
    };
    store.remember(noneCtx, "scratch note", { scope: "worker", tags: ["scratch"] });
    expect(next.memory.some((f) => f.scope === "worker")).toBe(true);
    promoteWorkerMemory(next, w.id);
    expect(next.memory.every((f) => f.scope !== "worker" || (f.worker !== w.id && f.sourceWorker !== w.id))).toBe(
      true,
    );
    expect(next.memory.some((f) => f.scope === "agent" && f.text.includes("scratch"))).toBe(true);
  });
});
