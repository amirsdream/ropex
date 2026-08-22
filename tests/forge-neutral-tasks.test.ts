import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyManifestText, emptyState, loadState, saveState } from "../src/controller.ts";
import { expandWorkers } from "../src/runtime.ts";
import { drainQueue } from "../src/scheduler.ts";
import { parseManifests, collectTasks } from "../src/spec.ts";
import {
  readTaskManifest,
  syncTasksFromDir,
  taskFromManifest,
  isTaskEnqueueable,
} from "../src/tasks.ts";

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
  prompt: "edit docs for ${name}"
  status: ${status}
  delivery:
    mode: git
`;

describe("Task manifest spec", () => {
  it("parses Task kind and collects tasks", () => {
    const docs = parseManifests(agentYaml + "\n---\n" + taskYaml("t1"));
    expect(collectTasks(docs)).toHaveLength(1);
    expect(collectTasks(docs)[0].metadata.name).toBe("t1");
  });

  it("rejects Task without agent/prompt", () => {
    expect(() =>
      parseManifests(`apiVersion: ropex.dev/v1\nkind: Task\nmetadata:\n  name: x\nspec: {}`),
    ).toThrow(/agent or spec.prompt/);
  });
});

describe("git-native task sync + delivery", () => {
  it("enqueues pending tasks and skips done manifests", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-git-task-"));
    temps.push(root);
    applyManifestText(root, agentYaml, "agent");
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "a.yaml"), taskYaml("task-a"));
    writeFileSync(join(tasksDir, "b.yaml"), taskYaml("task-b", "done"));

    const state = loadState(root);
    const result = syncTasksFromDir(state, root);
    expect(result.enqueued).toEqual(["task-a"]);
    expect(result.skipped).toContain("task-b");
    saveState(root, state);
    expect(loadState(root).queue.some((q) => q.id === "task-a" && q.source === "git")).toBe(true);
  });

  it("writes done status back to Task YAML after drain", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-git-drain-"));
    temps.push(root);
    applyManifestText(root, agentYaml, "agent");
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    const path = join(tasksDir, "deliver.yaml");
    writeFileSync(path, taskYaml("deliver-me"));

    let state = loadState(root);
    for (const w of state.workers) w.status = "idle";
    syncTasksFromDir(state, root);
    saveState(root, state);

    state = loadState(root);
    await drainQueue(state, { root, limit: 1 });
    saveState(root, state);

    const updated = readTaskManifest(path);
    expect(updated.spec.status).toBe("done");
    expect(updated.spec.result?.workerId).toMatch(/docbot/);
    expect(updated.spec.result?.output).toBeTruthy();
  });

  it("taskFromManifest preserves manifestPath", () => {
    const m = readTaskManifest(
      join(process.cwd(), "fleets/examples/tasks/update-readme.yaml"),
    );
    expect(isTaskEnqueueable(m)).toBe(true);
    const t = taskFromManifest(m, "/tmp/tasks/update-readme.yaml");
    expect(t.manifestPath).toBe("/tmp/tasks/update-readme.yaml");
    expect(t.agent).toBe("docbot");
  });
});
