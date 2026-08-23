import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildControlPlaneView, startControlPlaneServer } from "../src/api.ts";
import { applyManifestText, loadState } from "../src/controller.ts";
import {
  DSH_PROFILE_PACKS,
  liveDshScaffold,
  resolveDshBin,
  runHeadlessDsh,
} from "../src/dsh.ts";
import { syncTasksFromDir, taskGitSummary } from "../src/tasks.ts";

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
  replicas: 1
  harness:
    profile: minimal
    plugins: [fs]
  hermes:
    memory: none
    learning: false
    skills: []
`;

const taskYaml = (name: string, status = "pending") => `
apiVersion: ropex.dev/v1
kind: Task
metadata:
  name: ${name}
spec:
  agent: docbot
  prompt: "task ${name}"
  status: ${status}
  delivery:
    mode: git
`;

describe("roadmap: live dsh wiring", () => {
  it("maps harness profiles to dsh headless profiles", () => {
    for (const pack of Object.values(DSH_PROFILE_PACKS)) {
      expect(pack.dshProfile).toBe("headless");
    }
    const scaffold = liveDshScaffold();
    expect(scaffold.apiKeyPresent).toBe(false);
    expect(scaffold.packageInstalled).toBe(false);
    expect(resolveDshBin()).toBeUndefined();
  });

  it("runHeadlessDsh fails closed without package or API key", async () => {
    await expect(runHeadlessDsh("headless", "hello")).rejects.toThrow(/not installed|DEEPSEEK_API_KEY/);
  });
});

describe("roadmap: task git UI surface", () => {
  it("taskGitSummary scans tasks/ and projects onto the view", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-task-ui-"));
    temps.push(root);
    applyManifestText(root, agentYaml, "agent");
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "a.yaml"), taskYaml("task-a"));
    writeFileSync(join(tasksDir, "b.yaml"), taskYaml("task-b", "done"));

    const state = loadState(root);
    const summary = taskGitSummary(state, root);
    expect(summary.pending).toBe(1);
    expect(summary.done).toBe(1);
    expect(summary.items.map((t) => t.id).sort()).toEqual(["task-a", "task-b"]);

    const view = buildControlPlaneView(state, root);
    expect(view.taskGit.pending).toBe(1);
    expect(view.taskGit.done).toBe(1);
    expect(view.taskGit.items).toHaveLength(2);
  });

  it("POST /api/v1/tasks sync enqueues pending manifests", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-task-api-"));
    temps.push(root);
    applyManifestText(root, agentYaml, "agent");
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "sync-me.yaml"), taskYaml("sync-me"));

    const state = loadState(root);
    const server = await startControlPlaneServer({
      root,
      port: 0,
      loadState: () => state,
      saveState: (_r, s) => Object.assign(state, s),
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "sync" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enqueued: string[] };
    expect(body.enqueued).toContain("sync-me");
    expect(state.queue.some((q) => q.id === "sync-me")).toBe(true);
    await server.close();
  });
});
