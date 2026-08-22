import { describe, expect, it } from "vitest";
import { emptyState, planReconcile } from "../src/controller.ts";
import { detectDrift, formatDriftReport } from "../src/drift.ts";
import { canPlace, placementScore, taskLabelMap } from "../src/placement.ts";
import { claimPending, enqueueTask, pickIdleWorker } from "../src/queue.ts";
import { parseManifests } from "../src/spec.ts";
import type { Worker } from "../src/types.ts";

const baseYaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: placer
  labels:
    zone: west
    tier: hot
spec:
  replicas: 2
  placement:
    require:
      zone: west
    prefer:
      tier: hot
    taints:
      - key: dedicated
        effect: NoSchedule
    tolerations:
      - key: dedicated
        operator: Exists
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
`;

describe("placement", () => {
  it("copies labels and taints onto workers from desired", () => {
    const { next } = planReconcile(emptyState(), parseManifests(baseYaml), "t");
    const w = next.workers.find((x) => x.status !== "retired")!;
    expect(w.labels).toEqual({ zone: "west", tier: "hot" });
    expect(w.taints).toEqual([{ key: "dedicated", effect: "NoSchedule" }]);
  });

  it("skips workers that fail require labels", () => {
    const { next } = planReconcile(emptyState(), parseManifests(baseYaml), "t");
    const a = next.workers.find((w) => w.replica === 0)!;
    const b = next.workers.find((w) => w.replica === 1)!;
    a.labels = { zone: "east", tier: "hot" };
    enqueueTask(next, { id: "p1", agent: "placer", prompt: "work" });
    const { claimed } = claimPending(next, 1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].workerId).toBe(b.id);
  });

  it("prefers higher placementScore workers", () => {
    const { next } = planReconcile(emptyState(), parseManifests(baseYaml), "t");
    const a = next.workers.find((w) => w.replica === 0)!;
    const b = next.workers.find((w) => w.replica === 1)!;
    a.labels = { zone: "west", tier: "cold" };
    b.labels = { zone: "west", tier: "hot" };
    const picked = pickIdleWorker(next, "placer");
    expect(picked?.id).toBe(b.id);
  });

  it("blocks untolerated taints unless task labels tolerate", () => {
    const worker: Worker = {
      id: "x:0",
      agent: "x",
      replica: 0,
      status: "idle",
      imageDigest: "d".repeat(16),
      harness: "minimal",
      plugins: [],
      skills: [],
      model: "m",
      labels: { zone: "west" },
      taints: [{ key: "gpu", effect: "NoSchedule" }],
    };
    const placement = {
      require: { zone: "west" },
      taints: [{ key: "gpu" as const, effect: "NoSchedule" as const }],
    };
    expect(canPlace(worker, placement)).toBe(false);
    expect(
      canPlace(worker, placement, {
        id: "t",
        agent: "x",
        prompt: "g",
        event: { type: "issues.opened", repo: "o/r", number: 1, labels: ["gpu"] },
      }),
    ).toBe(true);
    expect(placementScore(worker, { prefer: { zone: "west" } })).toBe(1);
    expect(taskLabelMap({ id: "t", agent: "x", prompt: "p", event: { type: "x", repo: "a/b", number: 1, labels: ["gpu"] } })["github.com/label/gpu"]).toBe(
      "true",
    );
  });
});

describe("drift detector", () => {
  it("reports ok when live matches desired", () => {
    const { next } = planReconcile(emptyState(), parseManifests(baseYaml), "t");
    const report = detectDrift(next);
    expect(report.ok).toBe(true);
    expect(report.summary.missing).toBe(0);
    expect(report.summary.digest).toBe(0);
    expect(formatDriftReport(report)).toContain("drift ok");
  });

  it("detects digest and replica drift", () => {
    const { next } = planReconcile(emptyState(), parseManifests(baseYaml), "t");
    next.workers[0].imageDigest = "stale".padEnd(16, "0");
    next.workers[1].status = "retired";
    const report = detectDrift(next);
    expect(report.ok).toBe(false);
    expect(report.summary.digest).toBeGreaterThanOrEqual(1);
    expect(report.summary.replica + report.summary.missing).toBeGreaterThanOrEqual(1);
  });

  it("detects extra workers and cordoned", () => {
    const { next } = planReconcile(emptyState(), parseManifests(baseYaml), "t");
    next.workers.push({
      id: "ghost:0",
      agent: "ghost",
      replica: 0,
      status: "idle",
      imageDigest: "a".repeat(16),
      harness: "minimal",
      plugins: [],
      skills: [],
      model: "m",
    });
    next.workers[0].cordoned = true;
    const report = detectDrift(next);
    expect(report.summary.extra).toBe(1);
    expect(report.summary.cordoned).toBe(1);
    expect(report.ok).toBe(false);
  });
});
