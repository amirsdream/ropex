/**
 * GitRepo sync stub — reconcile from declared GitRepo.path locally.
 * Remote clone is reserved; this proves the control-plane sync contract offline.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ClusterState, GitRepo } from "./types.js";
import { watchOnce, type WatchOnceResult } from "./watch.js";

export type GitRepoSyncResult = {
  repo: string;
  path: string;
  ok: boolean;
  reason?: string;
  watch?: WatchOnceResult;
};

/** Resolve a GitRepo.spec.path against the workspace root (local stub). */
export function resolveGitRepoPath(root: string, repo: GitRepo): string {
  const p = repo.spec.path;
  if (isAbsolute(p)) return p;
  return resolve(root, p);
}

/**
 * Sync all declared GitRepos by re-reading their local paths and reconciling.
 * Skips missing paths; never clones remotes (network-free).
 */
export function syncGitRepos(
  root: string,
  state: ClusterState,
  opts: { persist?: boolean } = {},
): GitRepoSyncResult[] {
  const results: GitRepoSyncResult[] = [];
  for (const repo of state.gitRepos ?? []) {
    const path = resolveGitRepoPath(root, repo);
    if (!existsSync(path)) {
      // Fall back: if manifests were applied from elsewhere, try root-relative fleets/
      const fallback = join(root, "fleets");
      if (existsSync(fallback) && repo.spec.path.includes("fleets")) {
        const watch = watchOnce(root, fallback, opts);
        // Merge gitRepos from watch into result state is already persisted via watchOnce
        results.push({ repo: repo.metadata.name, path: fallback, ok: true, watch });
        continue;
      }
      results.push({
        repo: repo.metadata.name,
        path,
        ok: false,
        reason: `path missing (remote clone not wired): ${path}`,
      });
      continue;
    }
    const watch = watchOnce(root, path, opts);
    results.push({ repo: repo.metadata.name, path, ok: true, watch });
  }
  return results;
}

/** Parse interval from GitRepo.spec.interval (e.g. 30s). */
export function gitRepoIntervalMs(repo: GitRepo, fallback = 30_000): number {
  const raw = repo.spec.interval ?? "";
  const m = /^(\d+)(ms|s|m)?$/.exec(raw.trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  if (unit === "ms") return n;
  if (unit === "m") return n * 60_000;
  return n * 1000;
}
