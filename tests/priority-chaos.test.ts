import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { assertChaosInvariants, runReconcileChaos } from "../src/chaos.ts";
import { emptyState } from "../src/controller.ts";
import { claimPending, enqueueTask } from "../src/queue.ts";
import { expandWorkers } from "../src/runtime.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("queue priority", () => {
  it("claims higher priority tasks before lower ones", () => {
    const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: triage
spec:
  scale: static
  replicas: 2
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
`;
    const state = emptyState();
    state.desired = expandDesired(parseManifests(yaml));
    state.workers = expandWorkers(state.desired[0]).map((w) => ({ ...w, status: "idle" as const }));

    enqueueTask(state, { id: "low", agent: "triage", prompt: "low" }, "cli", { priority: 1 });
    enqueueTask(state, { id: "high", agent: "triage", prompt: "high" }, "cli", { priority: 10 });
    enqueueTask(state, { id: "mid", agent: "triage", prompt: "mid" }, "cli", { priority: 5 });

    const { claimed } = claimPending(state, 2);
    expect(claimed.map((c) => c.queueId)).toEqual(["high", "mid"]);
  });
});

describe("reconcile chaos", () => {
  it("survives scale and digest-roll churn without duplicate live slots", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-chaos-"));
    temps.push(root);
    const { steps, final } = runReconcileChaos(root, { maxReplicas: 6 });
    expect(steps.length).toBeGreaterThanOrEqual(6);
    expect(steps.some((s) => s.plan.retire.length > 0)).toBe(true);
    expect(steps.some((s) => s.plan.create.length > 0)).toBe(true);
    expect(assertChaosInvariants(final)).toEqual([]);
    const live = final.workers.filter((w) => w.status !== "retired");
    expect(live.length).toBeGreaterThan(0);
    expect(new Set(live.map((w) => w.id)).size).toBe(live.length);
    expect(live.every((w) => w.labels?.role === "chaos")).toBe(true);
  });

  it("allows digest mismatch only when canary holdouts flagged", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-chaos-canary-"));
    temps.push(root);
    const { final, steps } = runReconcileChaos(root, { maxReplicas: 4, canary: true });
    expect(steps.some((s) => (s.canaryHeld ?? 0) > 0)).toBe(true);
    // Strict mode may fail during/after canary; allowDigestMismatch must pass.
    expect(assertChaosInvariants(final, { allowDigestMismatch: true })).toEqual([]);
  });
});
