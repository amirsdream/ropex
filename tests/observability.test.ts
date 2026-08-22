import { describe, expect, it } from "vitest";
import { emptyState } from "../src/controller.ts";
import { bootDsh, DSH_PROFILE_PACKS, profilePack } from "../src/dsh.ts";
import { createHermes } from "../src/hermes.ts";
import { deliveriesFor, recordDelivery } from "../src/journal.ts";
import { metricsPrometheus, metricsSnapshot } from "../src/metrics.ts";
import { SharedMemoryStore } from "../src/memory.ts";
import { expandWorkers, runTask } from "../src/runtime.ts";
import { registerSkill, shareSkill, skillsForAgent } from "../src/skills.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";

const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  replicas: 1
  harness:
    profile: code
    model: deepseek-v4-pro
    plugins: [github, fs, shell]
  hermes:
    memory: shared
    learning: true
    skills: [implement-issue]
  github:
    events: [issues.labeled]
    deliver: pull_request
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: triage
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

describe("dsh adapter", () => {
  it("exposes profile packs for every harness profile", () => {
    expect(Object.keys(DSH_PROFILE_PACKS).sort()).toEqual(["code", "creator", "minimal", "standard"]);
    expect(profilePack("code").loop).toBe("code");
    expect(profilePack("minimal").tools).toContain("bash");
  });

  it("boots simulated adapter and executes a Hermes plan", async () => {
    const agent = expandDesired(parseManifests(yaml))[0];
    const store = new SharedMemoryStore([]);
    const hermes = createHermes(agent.spec, {
      store,
      worker: { id: "builder:0", agent: "builder" },
    });
    const dsh = await bootDsh(agent.spec, { hermes, backend: "simulated" });
    expect(dsh.backend).toBe("simulated");
    expect(dsh.pack.profile).toBe("code");
    const planned = hermes.plan({ id: "1", agent: "builder", prompt: "implement tests" });
    const { steps } = await dsh.execute(planned);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0].calls[0].plugin).toBe("dsh");
  });

  it("refuses live backend until wired", async () => {
    const agent = expandDesired(parseManifests(yaml))[0];
    await expect(bootDsh(agent.spec, { backend: "live" })).rejects.toThrow(/live backend not wired/);
  });
});

describe("journal + skills + metrics", () => {
  it("records deliveries and registers/share skills after runTask", async () => {
    const desired = expandDesired(parseManifests(yaml));
    const builder = desired.find((a) => a.metadata.name === "builder")!;
    const worker = expandWorkers(builder)[0];
    worker.status = "idle";
    const state = emptyState();
    state.desired = desired;
    state.workers = [worker];

    const result = await runTask(state, worker, {
      id: "t-journal",
      agent: "builder",
      prompt: "implement login tests",
    });

    expect(result.delivery?.kind).toBe("pull_request");
    expect(state.deliveries).toHaveLength(1);
    expect(deliveriesFor(state, { kind: "pull_request" })[0].taskId).toBe("t-journal");
    expect(state.skillRegistry.length).toBeGreaterThan(0);
    expect(state.skillRegistry[0].originAgent).toBe("builder");

    const shared = shareSkill(state, state.skillRegistry[0].name, "triage");
    expect(shared?.sharedWith).toContain("triage");
    expect(skillsForAgent(state, "triage").some((s) => s.name === shared!.name)).toBe(true);
  });

  it("exports prometheus metrics text", () => {
    const state = emptyState();
    state.revision = 4;
    state.metrics.tasksCompleted = 2;
    state.deliveries.push({
      id: "d1",
      at: new Date().toISOString(),
      kind: "comment",
      body: "hi",
      workerId: "triage:0",
      agent: "triage",
      taskId: "t",
      imageDigest: "abc",
    });
    const snap = metricsSnapshot(state);
    expect(snap.tasks_completed).toBe(2);
    expect(snap.deliveries).toBe(1);
    const text = metricsPrometheus(state);
    expect(text).toContain("ropex_tasks_completed_total 2");
    expect(text).toContain("ropex_cluster_revision 4");
  });

  it("registerSkill versions on re-learn", () => {
    const state = emptyState();
    const a = registerSkill(state, {
      name: "learned-x",
      agent: "builder",
      fromTask: "one",
      at: "2026-01-01T00:00:00.000Z",
    });
    const b = registerSkill(state, {
      name: "learned-x",
      agent: "builder",
      fromTask: "two",
      at: "2026-01-02T00:00:00.000Z",
    });
    expect(a.version).toBe(1);
    expect(b.version).toBe(2);
  });
});
