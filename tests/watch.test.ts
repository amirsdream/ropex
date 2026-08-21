import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { loadState } from "../src/controller.ts";
import { parseInterval, watchLoop, watchOnce } from "../src/watch.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function agentYaml(replicas: number, skill = "issue-triage"): string {
  return `apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: triage
spec:
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

describe("watch", () => {
  it("parses interval strings", () => {
    expect(parseInterval("5s")).toBe(5000);
    expect(parseInterval("250ms")).toBe(250);
    expect(parseInterval("1m")).toBe(60_000);
  });

  it("reconciles local manifests and detects scale drift", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-watch-"));
    temps.push(root);
    const fleets = join(root, "fleets");
    mkdirSync(fleets);
    writeFileSync(join(fleets, "a.yaml"), agentYaml(2));

    const first = watchOnce(root, fleets);
    expect(first.changed).toBe(true);
    expect(first.plan.create).toHaveLength(2);
    expect(loadState(root).workers.filter((w) => w.status !== "retired")).toHaveLength(2);

    writeFileSync(join(fleets, "a.yaml"), agentYaml(1));
    const second = watchOnce(root, fleets);
    expect(second.changed).toBe(true);
    expect(second.plan.retire).toHaveLength(1);

    const third = watchOnce(root, fleets);
    expect(third.plan.create).toHaveLength(0);
    expect(third.plan.retire).toHaveLength(0);
  });

  it("rolls workers when agent code changes (skill digest)", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-watch-roll-"));
    temps.push(root);
    const fleets = join(root, "fleets");
    mkdirSync(fleets);
    writeFileSync(join(fleets, "a.yaml"), agentYaml(1, "issue-triage"));
    watchOnce(root, fleets);
    const before = loadState(root).workers.find((w) => w.status !== "retired")!.imageDigest;

    writeFileSync(join(fleets, "a.yaml"), agentYaml(1, "issue-triage, label-hygiene"));
    const rolled = watchOnce(root, fleets);
    expect(rolled.plan.retire).toHaveLength(1);
    expect(rolled.plan.create).toHaveLength(1);
    const after = rolled.state.workers.find((w) => w.status !== "retired")!.imageDigest;
    expect(after).not.toBe(before);
  });

  it("watchLoop runs bounded ticks without network", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-watch-loop-"));
    temps.push(root);
    const fleets = join(root, "fleets");
    mkdirSync(fleets);
    writeFileSync(join(fleets, "a.yaml"), agentYaml(1));
    const ticks = await watchLoop({
      root,
      path: fleets,
      intervalMs: 1,
      maxTicks: 3,
    });
    expect(ticks).toHaveLength(3);
    expect(ticks[0].state.revision).toBeGreaterThan(0);
  });
});
