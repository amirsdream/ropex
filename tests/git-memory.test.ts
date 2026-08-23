import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyManifestText, loadState, saveState } from "../src/controller.ts";
import { createHermes } from "../src/hermes.ts";
import { SharedMemoryStore, createMemoryPort, memoryContextFor } from "../src/memory.ts";
import {
  exportMemoryFacts,
  readMemoryManifest,
  syncMemoryFromDir,
  factFromManifest,
} from "../src/gitmemory.ts";
import { parseManifests, collectMemory } from "../src/spec.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const agentYaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: docbot
spec:
  scale: static
  replicas: 1
  harness:
    profile: minimal
    plugins: [fs]
  hermes:
    memory: shared
    share:
      read: [agent, fleet]
      write: agent
    learning: false
    skills: []
`;

const memoryYaml = (name: string, text: string) => `
apiVersion: ropex.dev/v1
kind: Memory
metadata:
  name: ${name}
spec:
  agent: docbot
  scope: agent
  text: "${text}"
  tags: [ops]
`;

describe("Memory manifest spec", () => {
  it("parses Memory kind", () => {
    const raw = memoryYaml("tip-1", "always run tests");
    const mem = collectMemory(parseManifests(raw));
    expect(mem).toHaveLength(1);
    expect(mem[0].spec.agent).toBe("docbot");
  });

  it("rejects Memory without agent or text", () => {
    expect(() =>
      parseManifests(
        "apiVersion: ropex.dev/v1\nkind: Memory\nmetadata:\n  name: x\nspec:\n  agent: a\n",
      ),
    ).toThrow(/spec.agent or spec.text/);
  });
});

describe("git memory sync and export", () => {
  it("syncs Memory YAML into cluster state", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-mem-"));
    temps.push(root);
    mkdirSync(join(root, "memory"));
    writeFileSync(join(root, "memory", "tip.yaml"), memoryYaml("deploy-tip", "run npm test before push"));

    applyManifestText(root, agentYaml, "agent");
    const state = loadState(root);
    const result = syncMemoryFromDir(state, root);
    expect(result.synced).toContain("deploy-tip");
    expect(state.memory.some((f) => f.id === "deploy-tip" && f.text.includes("npm test"))).toBe(true);

    const m = readMemoryManifest(join(root, "memory", "tip.yaml"));
    expect(factFromManifest(m, join(root, "memory", "tip.yaml")).manifestPath).toMatch(/tip.yaml$/);
  });

  it("replicas share git-synced agent memory", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-mem-"));
    temps.push(root);
    mkdirSync(join(root, "memory"));
    writeFileSync(join(root, "memory", "shared.yaml"), memoryYaml("shared-fact", "prefer small diffs"));

    applyManifestText(root, agentYaml.replace("replicas: 1", "replicas: 2"), "agent");
    const state = loadState(root);
    syncMemoryFromDir(state, root);

    const store = SharedMemoryStore.fromState(state);
    const ctx1 = memoryContextFor(
      { id: "docbot:1", agent: "docbot" },
      { memory: "shared", skills: [], learning: false, share: { read: ["agent"], write: "agent" } },
    );
    const visible = createMemoryPort(store, ctx1).query();
    expect(visible.some((f) => f.text.includes("small diffs"))).toBe(true);
  });

  it("exports runtime facts to Memory YAML", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-mem-"));
    temps.push(root);
    applyManifestText(root, agentYaml, "agent");
    const state = loadState(root);

    const hermes = createHermes(state.desired[0].spec, {
      store: SharedMemoryStore.fromState(state),
      worker: { id: "docbot:0", agent: "docbot" },
    });
    hermes.remember("learned from run: update changelog");

    const result = exportMemoryFacts(state, root, { all: true });
    expect(result.exported.length).toBe(1);
    const exported = readFileSync(result.exported[0], "utf8");
    expect(exported).toMatch(/kind: Memory/);
    expect(exported).toMatch(/update changelog/);
    saveState(root, state);
    const reloaded = loadState(root);
    expect(reloaded.memory[0].manifestPath).toBe(result.exported[0]);
  });
});
