import { describe, expect, it } from "vitest";
import { emptyState, planReconcile } from "../src/controller.ts";
import { buildAgentImage } from "../src/image.ts";
import { pickIdleWorker } from "../src/queue.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import { composeWorkflow, WORKFLOW_STAGES } from "../src/workflow.ts";

const base = `
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
    soul: souls/triage.md
    memory: none
    learning: false
    skills: [issue-triage]
`;

describe("immutable agent images", () => {
  it("content-addresses agent code into an image digest", () => {
    const agent = expandDesired(parseManifests(base))[0];
    const a = buildAgentImage(agent);
    const b = buildAgentImage(agent);
    expect(a.digest).toMatch(/^[a-f0-9]{16}$/);
    expect(a.digest).toBe(b.digest);
  });

  it("rolls workers when agent code/config changes (no in-place mutate)", () => {
    const first = planReconcile(emptyState(), parseManifests(base), "fleets/").next;
    const before = first.workers.filter((w) => w.status !== "retired");
    expect(before).toHaveLength(2);
    const digestBefore = before[0].imageDigest;

    const changed = base.replace("skills: [issue-triage]", "skills: [issue-triage, label-hygiene]");
    const { plan, next } = planReconcile(first, parseManifests(changed), "fleets/");

    expect(plan.retire).toHaveLength(2);
    expect(plan.create).toHaveLength(2);
    expect(plan.update).toHaveLength(0);

    const live = next.workers.filter((w) => w.status !== "retired");
    expect(live).toHaveLength(2);
    expect(live[0].imageDigest).not.toBe(digestBefore);
    expect(next.workers.filter((w) => w.status === "retired")).toHaveLength(2);
    expect(next.workers.filter((w) => w.status === "retired")[0].imageDigest).toBe(digestBefore);
  });

  it("pickIdleWorker matches soul digests when root is passed", () => {
    const root = process.cwd();
    const { next } = planReconcile(emptyState(), parseManifests(base), "fleets/", { root });
    const withRoot = buildAgentImage(next.desired[0], { root }).digest;
    const withoutRoot = buildAgentImage(next.desired[0]).digest;
    expect(withRoot).not.toBe(withoutRoot);
    expect(next.workers[0].imageDigest).toBe(withRoot);
    expect(pickIdleWorker(next, "triage")?.id).toBeUndefined();
    expect(pickIdleWorker(next, "triage", { root })?.id).toBe("triage:0");
  });
});

describe("hermes + deepseek workflow", () => {
  it("assigns best-of-both stages to Hermes and DeepSeek", () => {
    const agent = expandDesired(parseManifests(base))[0];
    const wf = composeWorkflow(agent);
    expect(wf.imageDigest).toMatch(/^[a-f0-9]{16}$/);
    expect(wf.stages.map((s) => s.id)).toEqual(WORKFLOW_STAGES.map((s) => s.id));
    expect(wf.stages.find((s) => s.id === "plan")?.owner).toBe("hermes");
    expect(wf.stages.find((s) => s.id === "execute")?.owner).toBe("deepseek");
    expect(wf.stages.find((s) => s.id === "learn")?.owner).toBe("hermes");
    expect(wf.brain.skills).toContain("issue-triage");
    expect(wf.harness.profile).toBe("minimal");
  });
});
