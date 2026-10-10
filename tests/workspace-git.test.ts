import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expandDesired, parseManifests } from "../src/spec.ts";
import { cleanupWorkspace, prepareWorkspace, publishWorkspace } from "../src/workspace.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("workspace git", () => {
  it("pushes a committed worktree to a local bare remote", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-git-"));
    temps.push(root);
    const repo = join(root, "app");
    const bare = join(root, "bare.git");
    mkdirSync(repo);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Dev"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "hello\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
    execFileSync("git", ["init", "--bare", bare]);
    execFileSync("git", ["remote", "add", "origin", bare], { cwd: repo });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo });
    const agent = expandDesired(
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  replicas: 1
  runtime:
    kind: dsh
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: shared
    learning: false
    skills: []
  workspace:
    path: ${repo}
    remote: origin
    base: main
`),
    )[0];
    const prepared = prepareWorkspace({ root, agent, taskId: "greeting" });
    writeFileSync(join(prepared.worktree, "README.md"), "hello world\n");
    const outcome = publishWorkspace({ prepared, taskId: "greeting" });
    cleanupWorkspace(prepared, { deleteBranch: false });
    expect(outcome.result).toMatchObject({
      branch: "ropex/greeting",
      remote: "origin",
      pushed: true,
    });
    expect(git(bare, ["rev-parse", "refs/heads/ropex/greeting"])).toBe(outcome.result?.commit);
    expect(git(repo, ["show", "ropex/greeting:README.md"])).toBe("hello world");
    expect(git(bare, ["rev-parse", "refs/heads/main"])).toBe(git(repo, ["rev-parse", "main"]));
  });
});
