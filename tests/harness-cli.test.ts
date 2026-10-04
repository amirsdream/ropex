import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { emptyState } from "../src/controller.ts";
import { expandWorkers, runTask } from "../src/runtime.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import type { ClusterState, Worker, WorkerRuntimeKind } from "../src/types.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-harness-cli.mjs", import.meta.url));

const RUNTIMES: Array<{ kind: Exclude<WorkerRuntimeKind, "dsh">; env: string }> = [
  { kind: "claude-code", env: "ANTHROPIC_API_KEY" },
  { kind: "codex", env: "OPENAI_API_KEY" },
  { kind: "copilot", env: "GH_TOKEN" },
];

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const runtime of RUNTIMES) delete process.env[runtime.env];
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ropex-cli-harness-"));
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

function setup(kind: WorkerRuntimeKind): { state: ClusterState; worker: Worker } {
  const manifest = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  runtime:
    kind: ${kind}
    command: ${JSON.stringify(process.execPath)}
    commandArgs: [${JSON.stringify(FIXTURE)}]
    timeoutMs: 30000
  harness:
    profile: code
    plugins: [fs, shell]
  hermes:
    memory: none
    learning: false
    skills: []
`;
  const desired = expandDesired(parseManifests(manifest));
  const worker = expandWorkers(desired[0])[0];
  worker.status = "running";
  const state = emptyState();
  state.desired = desired;
  state.workers = [worker];
  return { state, worker };
}

describe("CLI runtimes are the harness", () => {
  it.each(RUNTIMES)("$kind writes the files and commits them", async ({ kind, env }) => {
    process.env[env] = "test-key";
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]);
    const { state, worker } = setup(kind);

    const result = await runTask(
      state,
      worker,
      { id: "greeting", agent: "builder", prompt },
      { worktreeRoot: repo },
    );

    expect(result.steps[0].calls[0].plugin).toBe(`runtime:${kind}`);
    expect(result.steps[0].observation).toMatch(/committed [0-9a-f]{40}/);

    const worktree = result.worktree as string;
    expect(git(worktree, ["log", "-1", "--format=%s"])).toBe("add a greeting argument");
    expect(git(worktree, ["show", "HEAD:src/hello.ts"])).toContain("hello, ${name}");
    expect(git(worktree, ["show", "HEAD:src/hello.test.ts"])).toContain("hello, world");
    expect(git(worktree, ["merge-base", "HEAD", base])).toBe(base);
    expect(git(repo, ["rev-parse", "main"])).toBe(base);
  });
});
