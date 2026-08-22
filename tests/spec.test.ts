import { describe, expect, it } from "vitest";
import { applyReplicaCap, expandDesired, maxReplicas, parseManifests } from "../src/spec.ts";

const sample = `
apiVersion: ropex.dev/v1
kind: Policy
metadata:
  name: cap
spec:
  maxReplicas: 10
  permissions:
    deny: [exfiltrate]
    requireApproval: [force-push]
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: triage
spec:
  replicas: 2
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: sqlite
    learning: true
    skills: [issue-triage]
  github:
    events: [issues.opened]
    deliver: comment
---
apiVersion: ropex.dev/v1
kind: Fleet
metadata:
  name: factory
spec:
  replicas: 4
  template:
    spec:
      harness:
        profile: code
        plugins: [github, fs]
      hermes:
        memory: sqlite
        learning: true
        skills: [implement-issue]
      github:
        events: [issues.labeled]
        deliver: pull_request
`;

describe("spec", () => {
  it("parses multi-doc manifests", () => {
    const manifests = parseManifests(sample);
    expect(manifests.map((m) => m.kind)).toEqual(["Policy", "Agent", "Fleet"]);
  });

  it("expands fleet replicas into derived agents", () => {
    const desired = expandDesired(parseManifests(sample));
    expect(desired).toHaveLength(5);
    expect(desired.filter((a) => a.derivedFrom?.fleet === "factory")).toHaveLength(4);
    expect(desired.find((a) => a.metadata.name === "factory-0")?.spec.harness.profile).toBe("code");
  });

  it("caps replica explosion with policy", () => {
    const manifests = parseManifests(sample);
    const cap = maxReplicas(manifests.filter((m) => m.kind === "Policy"));
    expect(cap).toBe(10);
    const { agents, capped } = applyReplicaCap(expandDesired(manifests), 3);
    const total = agents.reduce((n, a) => n + a.spec.replicas, 0);
    expect(total).toBe(3);
    expect(capped.length).toBeGreaterThan(0);
  });

  it("rejects unknown kinds", () => {
    expect(() =>
      parseManifests("apiVersion: ropex.dev/v1\nkind: Pod\nmetadata:\n  name: x\n"),
    ).toThrow(/unsupported kind/);
  });

  it("parses Task manifests", () => {
    const raw = `
apiVersion: ropex.dev/v1
kind: Task
metadata:
  name: t
spec:
  agent: triage
  prompt: hello
`;
    const tasks = parseManifests(raw).filter((m) => m.kind === "Task");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].kind === "Task" && tasks[0].spec.agent).toBe("triage");
  });
});
