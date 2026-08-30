import { describe, expect, it } from "vitest";
import { buildControlPlaneView } from "../src/api.ts";
import { emptyState } from "../src/controller.ts";
import { createHermes } from "../src/hermes.ts";
import {
  canRead,
  createMemoryPort,
  defaultSharePolicy,
  memoryContextFor,
  SharedMemoryStore,
} from "../src/memory.ts";
import { expandWorkers, runTask } from "../src/runtime.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import type { AgentSpec } from "../src/types.ts";

const sharedYaml = `
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
    memory: shared
    share:
      read: [agent, fleet]
      write: agent
    learning: true
    skills: [issue-triage]
---
apiVersion: ropex.dev/v1
kind: Fleet
metadata:
  name: factory
spec:
  scale: static
  replicas: 2
  template:
    spec:
      harness:
        profile: code
        plugins: [github, fs]
      hermes:
        memory: shared
        share:
          read: [agent, fleet]
          write: fleet
        learning: true
        skills: [implement-issue]
`;

describe("memory sharing", () => {
  it("defaults share policy from backend", () => {
    expect(defaultSharePolicy("sqlite")).toEqual({ read: ["agent"], write: "agent" });
    expect(defaultSharePolicy("shared")).toEqual({ read: ["agent", "fleet"], write: "agent" });
    expect(defaultSharePolicy("none")).toEqual({ read: [], write: "worker" });
  });

  it("shares agent-scoped facts across replicas", () => {
    const store = new SharedMemoryStore([]);
    const a0 = memoryContextFor(
      { id: "triage:0", agent: "triage" },
      { memory: "shared", skills: [], learning: false, share: { read: ["agent"], write: "agent" } },
    );
    const a1 = memoryContextFor(
      { id: "triage:1", agent: "triage" },
      { memory: "shared", skills: [], learning: false, share: { read: ["agent"], write: "agent" } },
    );
    const port0 = createMemoryPort(store, a0);
    port0.remember("login flake on main", { tags: ["bug"] });
    const visible = createMemoryPort(store, a1).query();
    expect(visible).toHaveLength(1);
    expect(visible[0].text).toMatch(/login flake/);
    expect(visible[0].scope).toBe("agent");
  });

  it("isolates worker-scoped facts", () => {
    const store = new SharedMemoryStore([]);
    const a0 = memoryContextFor(
      { id: "triage:0", agent: "triage" },
      { memory: "sqlite", skills: [], learning: false, share: { read: ["worker", "agent"], write: "worker" } },
    );
    const a1 = memoryContextFor(
      { id: "triage:1", agent: "triage" },
      { memory: "sqlite", skills: [], learning: false, share: { read: ["worker", "agent"], write: "worker" } },
    );
    createMemoryPort(store, a0).remember("private scratch", { scope: "worker" });
    expect(createMemoryPort(store, a1).query()).toHaveLength(0);
    expect(createMemoryPort(store, a0).query()).toHaveLength(1);
  });

  it("shares fleet-scoped facts across fleet workers only", () => {
    const store = new SharedMemoryStore([]);
    const w0 = memoryContextFor(
      { id: "factory-0:0", agent: "factory-0", fleet: "factory" },
      { memory: "shared", skills: [], learning: false, share: { read: ["fleet"], write: "fleet" } },
    );
    const w1 = memoryContextFor(
      { id: "factory-1:0", agent: "factory-1", fleet: "factory" },
      { memory: "shared", skills: [], learning: false, share: { read: ["fleet"], write: "fleet" } },
    );
    const outsider = memoryContextFor(
      { id: "triage:0", agent: "triage" },
      { memory: "shared", skills: [], learning: false, share: { read: ["fleet", "agent"], write: "agent" } },
    );
    createMemoryPort(store, w0).remember("shared build cache tip", { scope: "fleet" });
    expect(createMemoryPort(store, w1).query()).toHaveLength(1);
    expect(createMemoryPort(store, outsider).query()).toHaveLength(0);
  });

  it("promotes facts to a wider scope", () => {
    const store = new SharedMemoryStore([]);
    const ctx = memoryContextFor(
      { id: "factory-0:0", agent: "factory-0", fleet: "factory" },
      { memory: "shared", skills: [], learning: false, share: { read: ["agent", "fleet"], write: "fleet" } },
    );
    const port = createMemoryPort(store, ctx);
    const fact = port.remember("narrow", { scope: "agent" });
    const promoted = port.promote(fact.id, "fleet");
    expect(promoted?.scope).toBe("fleet");
    expect(promoted?.fleet).toBe("factory");
  });

  it("persists shared memory through runTask for sibling replicas", async () => {
    const desired = expandDesired(parseManifests(sharedYaml));
    const triage = desired.find((a) => a.metadata.name === "triage")!;
    const workers = expandWorkers(triage);
    const state = emptyState();
    state.desired = desired;
    state.workers = workers.map((w) => ({ ...w, status: "running" as const }));

    await runTask(state, state.workers[0], {
      id: "t-share",
      agent: "triage",
      prompt: "summarize open bugs",
    });

    expect(state.memory.some((m) => m.text.includes("summarize open bugs"))).toBe(true);
    const store = SharedMemoryStore.fromState(state);
    const sibling = memoryContextFor(state.workers[1], triage.spec.hermes);
    expect(store.query(sibling).length).toBeGreaterThan(0);
  });
});

describe("hermes + deepseek contracts", () => {
  it("Hermes brain exposes MemoryPort and plans with share hints", () => {
    const store = new SharedMemoryStore([]);
    const spec: AgentSpec = {
      scale: "static" as const,
      replicas: 1,
      harness: { profile: "minimal", plugins: ["github"] },
      hermes: {
        memory: "shared",
        share: { read: ["agent"], write: "agent" },
        learning: false,
        skills: ["x"],
      },
    };
    const brain = createHermes(spec, {
      store,
      worker: { id: "triage:0", agent: "triage" },
    });
    brain.remember("prior art");
    const plan = brain.plan({ id: "1", agent: "triage", prompt: "look around" });
    expect(plan.thoughts.some((t) => t.includes("share:"))).toBe(true);
    expect(plan.thoughts.some((t) => t.includes("memory[agent]"))).toBe(true);
    expect(brain.port.snapshot()).toHaveLength(1);
  });

  it("buildControlPlaneView projects Hermes and DeepSeek surfaces", () => {
    const desired = expandDesired(parseManifests(sharedYaml));
    const state = emptyState("fleets/");
    state.desired = desired;
    state.revision = 3;
    state.workers = desired.flatMap((a) => expandWorkers(a)).map((w) => ({ ...w, status: "running" as const }));
    state.memory.push({
      id: "m1",
      agent: "triage",
      text: "hello rope",
      at: new Date().toISOString(),
      scope: "agent",
      sourceWorker: "triage:0",
    });

    const view = buildControlPlaneView(state);
    expect(view.brand).toBe("ropex");
    expect(view.hermes.length).toBeGreaterThan(0);
    expect(view.harness[0].tools.length).toBeGreaterThan(0);
    expect(view.memory[0].text).toBe("hello rope");
    expect(view.workflow.map((s) => s.id)).toContain("plan");
    expect(canRead(state.memory[0], memoryContextFor(state.workers[0], desired[0].spec.hermes))).toBe(true);
  });
});
