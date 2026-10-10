import { describe, expect, it } from "vitest";
import {
  cleanupWorkspace,
  publishWorkspace,
  type GitRunner,
  type PreparedWorkspace,
} from "../src/workspace.ts";

const prepared: PreparedWorkspace = {
  checkout: "/tmp/app",
  worktree: "/ctrl/.ropex/workspace/builder/greeting",
  branch: "ropex/greeting",
  base: "main",
  remote: "origin",
  agent: "builder",
};

function scripted(map: Record<string, { code?: number; stdout?: string; stderr?: string }>): {
  git: GitRunner;
  calls: Array<{ args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }>;
} {
  const calls: Array<{ args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
  const git: GitRunner = (args, opts) => {
    calls.push({ args, cwd: opts?.cwd, env: opts?.env });
    const hit = map[args.join(" ")];
    if (!hit) return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    return { code: hit.code ?? 0, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
  };
  return { git, calls };
}

const clean = {
  "rev-parse --abbrev-ref HEAD": { stdout: "ropex/greeting\n" },
  "status --porcelain": { stdout: "" },
  "rev-list --count main..HEAD": { stdout: "0\n" },
};

describe("publishWorkspace", () => {
  it("commits a dirty tree and pushes without force", () => {
    const fake = scripted({
      "rev-parse --abbrev-ref HEAD": { stdout: "ropex/greeting\n" },
      "status --porcelain": { stdout: " M src/hello.ts\n" },
      "add -A": { stdout: "" },
      "-c commit.gpgsign=false commit -m ropex: greeting": { stdout: "" },
      "rev-list --count main..HEAD": { stdout: "1\n" },
      "rev-parse HEAD": { stdout: "deadbeef\n" },
      "push -u origin ropex/greeting": { stdout: "" },
    });
    const outcome = publishWorkspace({ prepared, taskId: "greeting", git: fake.git });
    expect(outcome.keepBranch).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toEqual({
      branch: "ropex/greeting",
      commit: "deadbeef",
      remote: "origin",
      pushed: true,
    });
    const commit = fake.calls.find((call) => call.args.includes("commit"));
    expect(commit?.cwd).toBe(prepared.worktree);
    expect(commit?.env).toMatchObject({
      GIT_AUTHOR_NAME: "Ropex",
      GIT_AUTHOR_EMAIL: "ropex@localhost",
      GIT_COMMITTER_NAME: "Ropex",
      GIT_COMMITTER_EMAIL: "ropex@localhost",
    });
    expect(fake.calls.some((call) => call.args.includes("--force") || call.args.includes("--force-with-lease"))).toBe(
      false,
    );
  });

  it("pushes an existing commit without a second commit", () => {
    const fake = scripted({
      "rev-parse --abbrev-ref HEAD": { stdout: "ropex/greeting\n" },
      "status --porcelain": { stdout: "" },
      "rev-list --count main..HEAD": { stdout: "1\n" },
      "rev-parse HEAD": { stdout: "abc\n" },
      "push -u origin ropex/greeting": { stdout: "" },
    });
    const outcome = publishWorkspace({ prepared, taskId: "greeting", git: fake.git });
    expect(outcome.result?.pushed).toBe(true);
    expect(fake.calls.some((call) => call.args.includes("commit"))).toBe(false);
  });

  it("fails a clean tree that is not ahead and does not keep the branch", () => {
    const fake = scripted(clean);
    const outcome = publishWorkspace({ prepared, taskId: "greeting", git: fake.git });
    expect(outcome).toEqual({ error: "no changes on ropex/greeting", keepBranch: false });
    expect(fake.calls.some((call) => call.args[0] === "push")).toBe(false);
  });

  it("keeps the branch when commit fails", () => {
    const fake = scripted({
      "rev-parse --abbrev-ref HEAD": { stdout: "ropex/greeting\n" },
      "status --porcelain": { stdout: " M a.ts\n" },
      "add -A": { stdout: "" },
      "-c commit.gpgsign=false commit -m ropex: greeting": { code: 1, stderr: "commit failed\n" },
    });
    const outcome = publishWorkspace({ prepared, taskId: "greeting", git: fake.git });
    expect(outcome.keepBranch).toBe(true);
    expect(outcome.error).toBe("commit failed");
    expect(outcome.result).toEqual({ branch: "ropex/greeting", remote: "origin", pushed: false });
  });

  it("keeps the branch when push fails", () => {
    const fake = scripted({
      "rev-parse --abbrev-ref HEAD": { stdout: "ropex/greeting\n" },
      "status --porcelain": { stdout: "" },
      "rev-list --count main..HEAD": { stdout: "2\n" },
      "rev-parse HEAD": { stdout: "abc\n" },
      "push -u origin ropex/greeting": { code: 1, stderr: "rejected\n" },
    });
    const outcome = publishWorkspace({ prepared, taskId: "greeting", git: fake.git });
    expect(outcome.keepBranch).toBe(true);
    expect(outcome.error).toBe("rejected");
    expect(outcome.result).toEqual({
      branch: "ropex/greeting",
      commit: "abc",
      remote: "origin",
      pushed: false,
    });
  });

  it("does not commit or push when HEAD is another branch", () => {
    const fake = scripted({
      "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
    });
    const outcome = publishWorkspace({ prepared, taskId: "greeting", git: fake.git });
    expect(outcome.keepBranch).toBe(true);
    expect(outcome.error).toBe("refusing to publish: HEAD is main, expected ropex/greeting");
    expect(outcome.result).toEqual({ branch: "ropex/greeting", remote: "origin", pushed: false });
    expect(fake.calls).toHaveLength(1);
  });
});

describe("cleanupWorkspace", () => {
  it("removes the worktree and deletes the branch when asked", () => {
    const fake = scripted({
      "worktree remove --force /ctrl/.ropex/workspace/builder/greeting": { stdout: "" },
      "branch -D ropex/greeting": { stdout: "" },
    });
    cleanupWorkspace(prepared, { deleteBranch: true, git: fake.git });
    expect(fake.calls.map((call) => call.args[0])).toEqual(["worktree", "branch"]);
    expect(fake.calls.every((call) => call.cwd === prepared.checkout)).toBe(true);
  });

  it("keeps the branch when deleteBranch is false", () => {
    const fake = scripted({
      "worktree remove --force /ctrl/.ropex/workspace/builder/greeting": { stdout: "" },
    });
    cleanupWorkspace(prepared, { deleteBranch: false, git: fake.git });
    expect(fake.calls.some((call) => call.args[0] === "branch")).toBe(false);
  });
});
