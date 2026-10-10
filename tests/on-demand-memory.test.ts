import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyState } from "../src/controller.ts";
import { runTask, workerFromDesired } from "../src/runtime.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import type { ClusterState, MemoryBackend, Worker } from "../src/types.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  delete process.env.ROPEX_LLM;
});
beforeEach(() => {
  process.env.ROPEX_LLM = "embedded";
});

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ropex-ondemand-mem-"));
  temps.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Dev"], { cwd: dir });
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "hello.ts"), "export {}\n");
  execFileSync("git", ["add", "src/hello.ts"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

function setup(memory: MemoryBackend): { state: ClusterState; worker: Worker } {
  const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: onDemand
  maxConcurrent: 1
  idleTTLMs: 0
  harness:
    profile: code
    plugins: [fs, shell]
  hermes:
    memory: ${memory}
    learning: false
    skills: []
`;
  const desired = expandDesired(parseManifests(yaml));
  const worker = workerFromDesired(desired[0], 0);
  worker.status = "running";
  const state = emptyState();
  state.desired = desired;
  state.workers = [worker];
  return { state, worker };
}

describe("on-demand task memory", () => {
  it("finishes a memory: none run without promoting the write to agent scope", async () => {
    const repo = initRepo();
    const { state, worker } = setup("none");
    const result = await runTask(
      state,
      worker,
      { id: "look", agent: "builder", prompt: "look around" },
      { worktreeRoot: repo },
    );
    expect(result.output).toBeTruthy();
    const fact = state.memory.find((f) => f.tags?.includes("task-complete"));
    expect(fact?.scope).toBe("worker");
  });

  it("promotes a shared on-demand memory write to the agent scope", async () => {
    const repo = initRepo();
    const { state, worker } = setup("shared");
    await runTask(
      state,
      worker,
      { id: "look", agent: "builder", prompt: "look around" },
      { worktreeRoot: repo },
    );
    const fact = state.memory.find((f) => f.tags?.includes("task-complete"));
    expect(fact?.scope).toBe("agent");
  });
});
