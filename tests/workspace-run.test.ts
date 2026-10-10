import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyState } from "../src/controller.ts";
import { enqueueTask } from "../src/queue.ts";
import { expandWorkers, runTask } from "../src/runtime.ts";
import { drainQueue } from "../src/scheduler.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import { defaultGitRunner, type GitRunner } from "../src/workspace.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.ROPEX_LLM;
  delete process.env.ROPEX_IN_SESSION;
});
beforeEach(() => {
  process.env.ROPEX_LLM = "embedded";
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const greetingPrompt = `add a greeting argument

\`\`\`src/hello.ts
export function hello(name: string): string {
  return \`hello, \${name}\`;
}
\`\`\`

\`\`\`src/hello.test.ts
import { hello } from "./hello.js";

if (hello("world") !== "hello, world") {
  throw new Error("hello() mismatch");
}
\`\`\`
`;

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ropex-ws-"));
  temps.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Dev"], { cwd: dir });
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "hello.ts"), "export const hi = 1;\n");
  execFileSync("git", ["add", "src/hello.ts"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

describe("runTask workspace", () => {
  it("does not call the git runner when the agent has no workspace", async () => {
    const repo = initRepo();
    const desired = expandDesired(
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: none
    learning: false
    skills: []
`),
    );
    const worker = expandWorkers(desired[0])[0];
    worker.status = "running";
    const state = emptyState();
    state.desired = desired;
    state.workers = [worker];
    let calls = 0;
    const git: GitRunner = () => {
      calls += 1;
      return { code: 0, stdout: "", stderr: "" };
    };
    await runTask(state, worker, { id: "look", agent: "builder", prompt: "look around" }, {
      worktreeRoot: repo,
      git,
    });
    expect(calls).toBe(0);
  });

  it("fails a clean workspace run, deletes the branch, and still learns", async () => {
    const repo = initRepo();
    const root = mkdtempSync(join(tmpdir(), "ropex-ctrl-"));
    temps.push(root);
    const desired = expandDesired(
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  runtime:
    kind: dsh
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: none
    learning: false
    skills: []
  workspace:
    path: ${repo}
    remote: origin
    base: main
`),
    );
    const worker = expandWorkers(desired[0])[0];
    worker.status = "running";
    const state = emptyState();
    state.desired = desired;
    state.workers = [worker];
    execFileSync("git", ["init", "--bare", join(root, "bare")]);
    execFileSync("git", ["remote", "add", "origin", join(root, "bare")], { cwd: repo });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo });
    const result = await runTask(
      state,
      worker,
      { id: "look", agent: "builder", prompt: "look around" },
      { root },
    );
    expect(result.workspaceError).toBe("no changes on ropex/look");
    expect(result.workspaceResult).toBeUndefined();
    expect(git(repo, ["branch", "--list", "ropex/look"])).toBe("");
  });

  it("deletes the branch when the sandbox is refused after prepare", async () => {
    process.env.ROPEX_IN_SESSION = "1";
    const repo = initRepo();
    const root = mkdtempSync(join(tmpdir(), "ropex-ctrl-"));
    temps.push(root);
    const bare = join(root, "bare");
    execFileSync("git", ["init", "--bare", bare]);
    execFileSync("git", ["remote", "add", "origin", bare], { cwd: repo });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo });
    const desired = expandDesired(
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  runtime:
    kind: dsh
  sandbox:
    provider: docker
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: none
    learning: false
    skills: []
  workspace:
    path: ${repo}
    remote: origin
    base: main
`),
    );
    const worker = expandWorkers(desired[0])[0];
    worker.status = "running";
    const state = emptyState();
    state.desired = desired;
    state.workers = [worker];
    const recorded: string[][] = [];
    const realGit = defaultGitRunner();
    const gitRunner: GitRunner = (args, opts) => {
      recorded.push(args);
      return realGit(args, opts);
    };
    await expect(
      runTask(
        state,
        worker,
        { id: "look", agent: "builder", prompt: "look around" },
        { root, git: gitRunner },
      ),
    ).rejects.toThrow(/ROPEX_IN_SESSION/);
    expect(
      recorded.some(
        (args) =>
          args[0] === "worktree" &&
          args[1] === "add" &&
          args.includes("-b") &&
          args.includes("ropex/look"),
      ),
    ).toBe(true);
    expect(recorded.some((args) => args[0] === "branch" && args[1] === "-D" && args[2] === "ropex/look")).toBe(
      true,
    );
    expect(recorded.some((args) => args[0] === "push")).toBe(false);
    expect(git(repo, ["branch", "--list", "ropex/look"])).toBe("");
    expect(() => git(bare, ["rev-parse", "--verify", "refs/heads/ropex/look"])).toThrow();
  });

  it("pushes a fenced edit to the bare remote", async () => {
    const repo = initRepo();
    const root = mkdtempSync(join(tmpdir(), "ropex-ctrl-"));
    temps.push(root);
    const bare = join(root, "bare");
    execFileSync("git", ["init", "--bare", bare]);
    execFileSync("git", ["remote", "add", "origin", bare], { cwd: repo });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo });
    const desired = expandDesired(
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  runtime:
    kind: dsh
  harness:
    profile: code
    plugins: [fs, shell]
  hermes:
    memory: none
    learning: false
    skills: []
  workspace:
    path: ${repo}
    remote: origin
    base: main
`),
    );
    const worker = expandWorkers(desired[0])[0];
    worker.status = "running";
    const state = emptyState();
    state.desired = desired;
    state.workers = [worker];
    const result = await runTask(
      state,
      worker,
      { id: "greeting", agent: "builder", prompt: greetingPrompt },
      { root },
    );
    expect(result.workspaceError).toBeUndefined();
    expect(result.workspaceResult?.pushed).toBe(true);
    expect(result.workspaceResult?.branch).toBe("ropex/greeting");
    expect(git(bare, ["rev-parse", "--verify", "refs/heads/ropex/greeting"])).toBe(result.workspaceResult?.commit);
  });

  it("dead-letters a clean workspace run without retrying", async () => {
    const repo = initRepo();
    const root = mkdtempSync(join(tmpdir(), "ropex-ctrl-"));
    temps.push(root);
    execFileSync("git", ["init", "--bare", join(root, "bare")]);
    execFileSync("git", ["remote", "add", "origin", join(root, "bare")], { cwd: repo });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo });
    const desired = expandDesired(
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  runtime:
    kind: dsh
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: none
    learning: false
    skills: []
  workspace:
    path: ${repo}
    remote: origin
    base: main
`),
    );
    const worker = expandWorkers(desired[0], { root })[0];
    const state = emptyState();
    state.desired = desired;
    state.workers = [worker];
    enqueueTask(state, { id: "look", agent: "builder", prompt: "look around" }, "cli");
    await drainQueue(state, { root });
    const item = state.queue.find((q) => q.task.id === "look");
    expect(item?.status).toBe("dead");
    expect(item?.attempts).toBe(1);
    expect(item?.error).toBe("no changes on ropex/look");
    expect(state.queue.some((q) => q.status === "pending")).toBe(false);
  });

  it("dead-letters a throw after a kept branch and keeps the push", async () => {
    const repo = initRepo();
    const root = mkdtempSync(join(tmpdir(), "ropex-ctrl-"));
    temps.push(root);
    const bare = join(root, "bare");
    execFileSync("git", ["init", "--bare", bare]);
    execFileSync("git", ["remote", "add", "origin", bare], { cwd: repo });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo });
    const desired = expandDesired(
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  runtime:
    kind: dsh
  harness:
    profile: code
    plugins: [fs, shell]
  hermes:
    memory: none
    learning: false
    skills: []
  workspace:
    path: ${repo}
    remote: origin
    base: main
`),
    );
    const worker = expandWorkers(desired[0], { root })[0];
    const state = emptyState();
    state.desired = desired;
    state.workers = [worker];
    state.trajectories = [];
    state.trajectories.push = (() => {
      throw new Error("record failed");
    }) as typeof state.trajectories.push;
    enqueueTask(state, { id: "greeting", agent: "builder", prompt: greetingPrompt }, "cli");
    await drainQueue(state, { root });
    const item = state.queue.find((q) => q.task.id === "greeting");
    expect(item?.status).toBe("dead");
    expect(item?.attempts).toBe(1);
    expect(item?.error).toBe("record failed");
    expect(state.queue.some((q) => q.status === "pending")).toBe(false);
    expect(git(repo, ["branch", "--list", "ropex/greeting"])).toContain("ropex/greeting");
    expect(git(bare, ["rev-parse", "--verify", "refs/heads/ropex/greeting"])).toMatch(/^[0-9a-f]{40}$/);
  });

  it("retries a throw before publish and deletes the branch", async () => {
    process.env.ROPEX_IN_SESSION = "1";
    const repo = initRepo();
    const root = mkdtempSync(join(tmpdir(), "ropex-ctrl-"));
    temps.push(root);
    const bare = join(root, "bare");
    execFileSync("git", ["init", "--bare", bare]);
    execFileSync("git", ["remote", "add", "origin", bare], { cwd: repo });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo });
    const desired = expandDesired(
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  runtime:
    kind: dsh
  sandbox:
    provider: docker
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: none
    learning: false
    skills: []
  workspace:
    path: ${repo}
    remote: origin
    base: main
`),
    );
    const worker = expandWorkers(desired[0], { root })[0];
    const state = emptyState();
    state.desired = desired;
    state.workers = [worker];
    enqueueTask(state, { id: "look", agent: "builder", prompt: "look around" }, "cli");
    await drainQueue(state, { root });
    const item = state.queue.find((q) => q.task.id === "look");
    expect(item?.status).toBe("pending");
    expect(item?.attempts).toBe(1);
    expect(item?.error).toMatch(/ROPEX_IN_SESSION/);
    expect(git(repo, ["branch", "--list", "ropex/look"])).toBe("");
    expect(() => git(bare, ["rev-parse", "--verify", "refs/heads/ropex/look"])).toThrow();
  });
});
