import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyState } from "../../src/controller.ts";
import { expandWorkers, runTask } from "../../src/runtime.ts";
import { expandDesired, parseManifests } from "../../src/spec.ts";
import type { ClusterState, Worker } from "../../src/types.ts";

const EDIT = fileURLToPath(new URL("../fixtures/fake-claude-edit.mjs", import.meta.url));

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.FAKE_CLAUDE_FAIL;
  delete process.env.FAKE_CLAUDE_NOOP;
});
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A real repository the task will edit. Not the control-plane checkout. */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ropex-commit-repo-"));
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

function setup(repo: string, gitBlock: string): { state: ClusterState; worker: Worker } {
  const manifest = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  runtime:
    kind: claude-code
    command: ${JSON.stringify(process.execPath)}
    commandArgs: [${JSON.stringify(EDIT)}]
    timeoutMs: 30000
  sandbox:
    provider: local
${gitBlock}
  harness:
    profile: code
    plugins: [fs, shell]
  hermes:
    memory: none
    learning: false
    skills: []
  github:
    events: [issues.labeled]
    deliver: pull_request
`;
  const desired = expandDesired(parseManifests(manifest));
  const worker = expandWorkers(desired[0])[0];
  worker.status = "running";
  const state = emptyState();
  state.desired = desired;
  state.workers = [worker];
  return { state, worker };
}

describe("sandbox git commit of a real task", () => {
  it("edits the repo and commits the change on a task branch", async () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]);
    const { state, worker } = setup(repo, "    git: { commit: true }");

    const result = await runTask(
      state,
      worker,
      { id: "task-1", agent: "builder", prompt: "add a greeting argument" },
      { worktreeRoot: repo },
    );

    expect(result.commit?.committed).toBe(true);
    expect(result.commit?.branch).toBe("ropex/task-1");
    expect(result.commit?.pushed).toBe(false);
    expect(result.commit?.files?.sort()).toEqual(["src/hello.test.ts", "src/hello.ts"]);
    expect(result.output).toContain(`commit ${result.commit?.sha?.slice(0, 12)} on ropex/task-1`);
    expect(result.delivery?.body).toContain("commit ");
    expect(state.audit.some((a) => a.message.startsWith("sandbox commit "))).toBe(true);

    const sha = result.commit?.sha as string;
    expect(git(repo, ["rev-parse", "ropex/task-1"])).toBe(sha);
    expect(git(repo, ["rev-parse", "main"])).toBe(base);
    expect(git(repo, ["merge-base", "main", sha])).toBe(base);
    expect(git(repo, ["log", "-1", "--format=%an <%ae>", sha])).toBe("Ropex <ropex@localhost>");
    expect(git(repo, ["log", "-1", "--format=%s", sha])).toBe("ropex: add a greeting argument");
    expect(git(repo, ["show", `${sha}:src/hello.ts`])).toContain("hello, ${name}");
    expect(git(repo, ["show", `${sha}:src/hello.test.ts`])).toContain("hello, world");
    expect(git(repo, ["show", "main:src/hello.ts"])).toContain('return "hi"');
    expect(git(repo, ["ls-tree", "-r", "--name-only", sha])).not.toContain(".ropex-worker.json");
  });

  it("uses the branch template and leaves a clean tree uncommitted", async () => {
    const repo = initRepo();
    process.env.FAKE_CLAUDE_NOOP = "1";
    const { state, worker } = setup(repo, '    git: { commit: true, branch: "agent/{taskId}" }');
    const result = await runTask(
      state,
      worker,
      { id: "task-clean", agent: "builder", prompt: "look around" },
      { worktreeRoot: repo },
    );
    expect(result.commit).toEqual({ committed: false, reason: "clean" });
    expect(git(repo, ["branch", "--list", "agent/task-clean"])).toBe("");
    expect(git(repo, ["rev-list", "--count", "main"])).toBe("1");
  });

  it("does not commit when the executor fails", async () => {
    const repo = initRepo();
    process.env.FAKE_CLAUDE_FAIL = "1";
    const { state, worker } = setup(repo, "    git: { commit: true }");
    await expect(
      runTask(state, worker, { id: "task-fail", agent: "builder", prompt: "break" }, { worktreeRoot: repo }),
    ).rejects.toThrow(/exited 1/);
    expect(git(repo, ["branch", "--list", "ropex/task-fail"])).toBe("");
    expect(git(repo, ["rev-list", "--count", "main"])).toBe("1");
  });
});
