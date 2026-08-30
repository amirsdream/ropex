import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { selectCanaryRolls } from "../src/canary.ts";
import { emptyState, planReconcile } from "../src/controller.ts";
import { buildAgentImage } from "../src/image.ts";
import { pickIdleWorker } from "../src/queue.ts";
import { writeSnapshot, exportSnapshot } from "../src/snapshot.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import type { Worker } from "../src/types.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function agentYaml(replicas: number, skill: string): string {
  return `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: canary
spec:
  scale: static
  replicas: ${replicas}
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: [${skill}]
`;
}

describe("canary digest rolls", () => {
  it("selectCanaryRolls limits per-agent mismatches", () => {
    const mk = (replica: number): { prev: Worker; next: Worker } => ({
      prev: {
        id: `canary:${replica}`,
        agent: "canary",
        replica,
        status: "idle",
        imageDigest: "oldoldoldoldold1",
        harness: "minimal",
        plugins: [],
        skills: [],
        model: "x",
      },
      next: {
        id: `canary:${replica}`,
        agent: "canary",
        replica,
        status: "idle",
        imageDigest: "newnewnewnewnew2",
        harness: "minimal",
        plugins: [],
        skills: [],
        model: "x",
      },
    });
    const { roll, hold } = selectCanaryRolls([mk(0), mk(1), mk(2)], {
      strategy: "canary",
      canaryCount: 1,
    });
    expect(roll).toHaveLength(1);
    expect(roll[0].next.replica).toBe(0);
    expect(hold).toHaveLength(2);
  });

  it("planReconcile canary rolls one replica per pass", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-canary-"));
    temps.push(root);
    const { next: v1 } = planReconcile(
      emptyState(),
      parseManifests(agentYaml(3, "s1")),
      "v1",
      { root },
    );
    expect(v1.workers.filter((w) => w.status !== "retired")).toHaveLength(3);
    const dig1 = v1.workers[0].imageDigest;

    const { next: v2, plan, canaryHeld } = planReconcile(
      v1,
      parseManifests(agentYaml(3, "s1, s2")),
      "v2",
      { root, rollout: { strategy: "canary", canaryCount: 1 } },
    );
    expect(plan.create).toHaveLength(1);
    expect(plan.retire).toHaveLength(1);
    expect(canaryHeld).toBe(2);
    const live = v2.workers.filter((w) => w.status !== "retired");
    expect(live).toHaveLength(3);
    const digests = new Set(live.map((w) => w.imageDigest));
    expect(digests.size).toBe(2);
    expect(digests.has(dig1)).toBe(true);

    // Second canary pass advances another slot.
    const { next: v3, canaryHeld: held2 } = planReconcile(
      v2,
      parseManifests(agentYaml(3, "s1, s2")),
      "v3",
      { root, rollout: { strategy: "canary", canaryCount: 1 } },
    );
    expect(held2).toBe(1);
    const live3 = v3.workers.filter((w) => w.status !== "retired");
    const matching = live3.filter(
      (w) => w.imageDigest === buildAgentImage(expandDesired(parseManifests(agentYaml(3, "s1, s2")))[0]).digest,
    );
    expect(matching.length).toBe(2);
  });

  it("pickIdleWorker skips canary holdouts with old digest", () => {
    const { next } = planReconcile(emptyState(), parseManifests(agentYaml(2, "s1")), "a");
    const desired = buildAgentImage(next.desired[0]).digest;
    next.workers[1].imageDigest = "stale stale stale";
    next.workers[0].status = "idle";
    next.workers[1].status = "idle";
    const picked = pickIdleWorker(next, "canary");
    expect(picked?.imageDigest).toBe(desired);
  });
});

describe("snapshot export", () => {
  it("writes a checkpoint under .ropex/snapshots", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-snap-"));
    temps.push(root);
    const { next } = planReconcile(emptyState(), parseManifests(agentYaml(1, "s1")), "a");
    const { path, meta } = writeSnapshot(root, next);
    expect(path).toContain(".ropex/snapshots");
    expect(meta.revision).toBe(1);
    expect(exportSnapshot(next)).toContain('"meta"');
  });
});
