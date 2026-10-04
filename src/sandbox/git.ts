/**
 * Commit the execute stage's edits back into the sandbox repo.
 *
 * Runs through `Sandbox.exec`, so the same steps work in a host worktree and
 * inside a container. Author identity is set for this commit only — the
 * control plane's git config is not used, and commits are unsigned so a
 * missing gpg agent cannot stall the task.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { RunProcessResult } from "../proc.js";
import type { Sandbox } from "./index.js";

const AUTHOR_NAME = "Ropex";
const AUTHOR_EMAIL = "ropex@localhost";
/** Control-plane bookkeeping that must not land in the user's commit. */
const IGNORED = new Set([".ropex-worker.json", "README.ropex"]);

export type SandboxCommitResult = {
  committed: boolean;
  sha?: string;
  branch?: string;
  files?: string[];
  pushed?: boolean;
  bundle?: string;
  reason?: string;
};

export type SandboxCommitOptions = {
  branch: string;
  message: string;
  push?: boolean;
  /**
   * Host path for `git bundle create`. Set when the commit lives only inside
   * a container that is about to be removed.
   */
  bundlePath?: string;
};

const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: AUTHOR_NAME,
  GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
  GIT_COMMITTER_NAME: AUTHOR_NAME,
  GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
};

/** `ropex/{taskId}` with characters git rejects in a ref swapped out. */
export function sandboxCommitBranch(template: string | undefined, taskId: string): string {
  const id = taskId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
  const branch = (template ?? "ropex/{taskId}").replaceAll("{taskId}", id);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
    branch.includes("..") ||
    branch.endsWith("/") ||
    branch.endsWith(".lock")
  ) {
    throw new Error(`sandbox git branch "${branch}" is not a valid git ref`);
  }
  return branch;
}

/** One-line message from the task prompt. */
export function sandboxCommitMessage(prompt: string): string {
  const line = prompt.replace(/[\r\n]+/g, " ").trim().slice(0, 72);
  return `ropex: ${line || "task"}`;
}

function porcelainPaths(stdout: string): string[] {
  const files: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length < 4) continue;
    let path = line.slice(3).trim();
    const arrow = path.lastIndexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4);
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (!IGNORED.has(path)) files.push(path);
  }
  return files;
}

async function git(sandbox: Sandbox, args: string[], what: string): Promise<RunProcessResult> {
  const res = await sandbox.exec("git", args, { env: AUTHOR_ENV });
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    throw new Error(`sandbox git ${what} failed${detail ? `: ${detail}` : ` (exit ${res.code})`}`);
  }
  return res;
}

/**
 * If the workspace has changes, commit them on `opts.branch`.
 * A clean tree (ignoring control-plane marker files) is a success with
 * `committed: false` — the executor simply did not edit anything.
 */
export async function commitSandboxChanges(
  sandbox: Sandbox,
  opts: SandboxCommitOptions,
): Promise<SandboxCommitResult> {
  const inside = await sandbox.exec("git", ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() === "false") {
    throw new Error("sandbox git.commit requires a git checkout in the workspace");
  }

  const status = await git(sandbox, ["status", "--porcelain"], "status");
  if (porcelainPaths(status.stdout).length === 0) {
    return { committed: false, reason: "clean" };
  }

  await git(sandbox, ["checkout", "-B", opts.branch], "checkout");
  await git(
    sandbox,
    ["add", "-A", "--", ".", ":(exclude).ropex-worker.json", ":(exclude)README.ropex"],
    "add",
  );

  const committed = await sandbox.exec(
    "git",
    [
      "-c",
      `user.name=${AUTHOR_NAME}`,
      "-c",
      `user.email=${AUTHOR_EMAIL}`,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      opts.message,
    ],
    { env: AUTHOR_ENV },
  );
  if (committed.code !== 0) {
    const detail = `${committed.stderr}\n${committed.stdout}`.toLowerCase();
    if (detail.includes("nothing to commit") || detail.includes("no changes added")) {
      return { committed: false, reason: "clean" };
    }
    const text = (committed.stderr || committed.stdout).trim();
    throw new Error(`sandbox git commit failed${text ? `: ${text}` : ` (exit ${committed.code})`}`);
  }

  const sha = (await git(sandbox, ["rev-parse", "HEAD"], "rev-parse")).stdout.trim();
  const files = (await git(sandbox, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], "diff-tree"))
    .stdout.split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let pushed = false;
  if (opts.push) {
    await git(sandbox, ["push", "-u", "origin", opts.branch], "push");
    pushed = true;
  }

  let bundle: string | undefined;
  if (opts.bundlePath && !pushed) {
    const inside = "/tmp/ropex-commit.bundle";
    await git(sandbox, ["bundle", "create", inside, opts.branch], "bundle");
    mkdirSync(dirname(opts.bundlePath), { recursive: true });
    await sandbox.copyOut(inside, opts.bundlePath);
    bundle = opts.bundlePath;
  }

  return { committed: true, sha, branch: opts.branch, files, pushed, bundle };
}
