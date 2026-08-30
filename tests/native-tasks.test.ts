import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyManifestText, emptyState, loadState, saveState } from "../src/controller.ts";
import {
  deliverTaskOutcome,
  ensureConnectors,
  findNativeTask,
  nativeTaskSummary,
} from "../src/connectors.ts";
import { buildControlPlaneView } from "../src/api.ts";
import { drainQueue } from "../src/scheduler.ts";
import { submitNativeTask } from "../src/tasks.ts";

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
    memory: none
    learning: false
    skills: []
`;

describe("native task inbox", () => {
  it("submits via API-shaped flow without git", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-native-"));
    temps.push(root);
    applyManifestText(root, agentYaml, "agent");
    let state = loadState(root);
    for (const w of state.workers) w.status = "idle";

    const { task, queued } = submitNativeTask(state, {
      agent: "docbot",
      prompt: "summarize the readme",
    });
    expect(task.delivery.mode).toBe("ui");
    expect(queued.source).toBe("api");
    saveState(root, state);

    state = loadState(root);
    expect(findNativeTask(state, task.id)?.status).toBe("pending");
    await drainQueue(state, { root, limit: 1 });
    saveState(root, state);

    state = loadState(root);
    const done = findNativeTask(state, task.id);
    expect(done?.status).toBe("done");
    expect(done?.output).toBeTruthy();
  });

  it("exposes native tasks and connectors in control plane view", () => {
    const state = emptyState();
    ensureConnectors(state);
    submitNativeTask(state, { agent: "docbot", prompt: "hello" });
    const view = buildControlPlaneView(state);
    expect(view.nativeTasks.total).toBe(1);
    expect(view.connectors.some((c) => c.id === "native" && c.enabled)).toBe(true);
    expect(view.connectors.some((c) => c.id === "github" && !c.enabled)).toBe(true);
  });

  it("deliverTaskOutcome stores UI results without manifest path", () => {
    const state = emptyState();
    const { queued } = submitNativeTask(state, { agent: "docbot", prompt: "x" });
    queued.status = "done";
    queued.finishedAt = new Date().toISOString();
    const { modes } = deliverTaskOutcome(state, queued, { output: "done output" });
    expect(modes).toContain("ui");
    expect(nativeTaskSummary(state).done).toBe(1);
  });
});
