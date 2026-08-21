/**
 * Per-worker sandbox worktrees — isolate fs/shell so fleet replicas cannot clobber each other.
 * Prefer `git worktree add` when the workspace is a git repo; otherwise a plain directory.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Worker } from "./types.js";

export const WORKTREE_ROOT = join("sandbox", "worktrees");

/** Safe filesystem segment for a worker id (`triage:0` → `triage_0`). */
export function worktreeSlug(workerId: string): string {
  return workerId.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function worktreePath(root: string, workerId: string): string {
  return join(root, WORKTREE_ROOT, worktreeSlug(workerId));
}

export function ensureWorktree(root: string, worker: Pick<Worker, "id" | "agent" | "imageDigest">): string {
  const path = worktreePath(root, worker.id);
  if (existsSync(path)) {
    writeMarker(path, worker);
    return path;
  }
  mkdirSync(join(root, WORKTREE_ROOT), { recursive: true });

  const gitDir = join(root, ".git");
  if (existsSync(gitDir)) {
    try {
      execFileSync(
        "git",
        ["worktree", "add", "--detach", path, "HEAD"],
        { cwd: root, stdio: "pipe" },
      );
      writeMarker(path, worker);
      return path;
    } catch {
      // Fall through to plain directory isolation.
    }
  }

  mkdirSync(path, { recursive: true });
  writeMarker(path, worker);
  writeFileSync(join(path, "README.ropex"), `Ropex worktree for ${worker.id}\n`, "utf8");
  return path;
}

export function removeWorktree(root: string, workerId: string): void {
  const path = worktreePath(root, workerId);
  if (!existsSync(path)) return;

  const gitDir = join(root, ".git");
  if (existsSync(gitDir)) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", path], {
        cwd: root,
        stdio: "pipe",
      });
      return;
    } catch {
      // Fall through to rm.
    }
  }
  rmSync(path, { recursive: true, force: true });
}

/** Stamp worktree paths onto create/update workers; tear down retired ones. */
export function applyWorktrees(
  root: string,
  plan: { create: Worker[]; update: Worker[]; retire: Worker[] },
): void {
  for (const w of [...plan.create, ...plan.update]) {
    w.worktree = ensureWorktree(root, w);
  }
  for (const w of plan.retire) {
    removeWorktree(root, w.id);
    w.worktree = undefined;
  }
}

function writeMarker(path: string, worker: Pick<Worker, "id" | "agent" | "imageDigest">): void {
  writeFileSync(
    join(path, ".ropex-worker.json"),
    `${JSON.stringify({ id: worker.id, agent: worker.agent, imageDigest: worker.imageDigest }, null, 2)}\n`,
  );
}
