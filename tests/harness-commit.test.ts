import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyState } from "../src/controller.ts";
import { plannedEdits } from "../src/hermes.ts";
import { expandWorkers, runTask } from "../src/runtime.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import type { ClusterState, Worker } from "../src/types.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  delete process.env.ROPEX_LLM;
});
beforeEach(() => {
  process.env.ROPEX_LLM = "embedded";
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ropex-harness-repo-"));
  temps.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Dev"], { cwd: dir });
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "hello.ts"), 'export function hello(): string {\n  return "hi";\n}\n');
  execFileSync("git", ["add", "src/hello.ts"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init hello"], { cwd: dir });
  return dir;
}

const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  harness:
    profile: code
    plugins: [fs, shell]
  hermes:
    memory: none
    learning: false
    skills: []
`;

function setup(): { state: ClusterState; worker: Worker } {
  const desired = expandDesired(parseManifests(yaml));
  const worker = expandWorkers(desired[0])[0];
  worker.status = "running";
  const state = emptyState();
  state.desired = desired;
  state.workers = [worker];
  return { state, worker };
}

const prompt = `add a greeting argument

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

describe("harness writes and commits", () => {
  it("applies the task's files and commits them from the shell tool", async () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]);
    const { state, worker } = setup();

    const result = await runTask(
      state,
      worker,
      { id: "greeting", agent: "builder", prompt },
      { worktreeRoot: repo },
    );

    const shells = result.steps.filter((step) => step.calls.some((call) => call.name === "shell"));
    const wrote = result.steps.filter((step) => step.calls.some((call) => call.name === "fs"));
    expect(wrote).toHaveLength(2);
    expect(shells.every((step) => step.calls[0].plugin === "dsh")).toBe(true);
    const commit = shells.find((step) => {
      const argv = step.calls[0].input.argv;
      return Array.isArray(argv) && argv.includes("commit");
    });
    expect(commit).toBeDefined();

    const worktree = result.worktree as string;
    expect(git(worktree, ["log", "-1", "--format=%an <%ae>"])).toBe("Ropex <ropex@localhost>");
    expect(git(worktree, ["log", "-1", "--format=%s"])).toBe("add a greeting argument");
    expect(git(worktree, ["show", "HEAD:src/hello.ts"])).toContain("hello, ${name}");
    expect(git(worktree, ["show", "HEAD:src/hello.test.ts"])).toContain("hello, world");
    expect(git(worktree, ["ls-tree", "-r", "--name-only", "HEAD"])).not.toContain(".ropex-worker.json");
    expect(git(repo, ["rev-parse", "main"])).toBe(base);
    expect(git(worktree, ["merge-base", "HEAD", base])).toBe(base);
  });

  it("does not commit a task that never asks the harness to write", async () => {
    const repo = initRepo();
    const { state, worker } = setup();
    await runTask(
      state,
      worker,
      { id: "look", agent: "builder", prompt: "implement login tests" },
      { worktreeRoot: repo },
    );
    expect(git(repo, ["rev-list", "--count", "main"])).toBe("1");
    expect(git(repo, ["branch", "--list", "ropex/*"])).toBe("");
  });
});

describe("manual runtime task prompts", () => {
  const prompt = (name: string) =>
    readFileSync(join(process.cwd(), "fleets/examples/manual/prompts", name), "utf8");

  it("turns the scripted prompts into a subject and files", () => {
    const version = plannedEdits(prompt("version-stamp.txt"));
    expect(version?.message).toBe("record the build version");
    expect(version?.files.map((file) => file.path)).toEqual(["src/version.ts"]);
    expect(version?.files[0]?.content).toContain('export const version = "0.1.0"');

    const note = plannedEdits(prompt("haiku.txt"));
    expect(note?.message).toBe("leave a note");
    expect(note?.files.map((file) => file.path)).toEqual(["docs/note.txt"]);
    expect(note?.files[0]?.content).toContain("a frog jumps in");
  });

  it("leaves the open prompts for the runtime to edit", () => {
    for (const name of ["sum-correction.txt", "clamp.txt", "notes.txt"]) {
      const text = prompt(name);
      expect(plannedEdits(text), name).toBeUndefined();
      expect(text, name).not.toMatch(/test|fix|implement/i);
    }
  });
});
