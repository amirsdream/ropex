/**
 * Multi-repo GitRepo sync — union all declared local paths into one reconcile.
 * Remote clone is reserved; this proves the control-plane multi-source contract offline.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { recordAudit } from "./audit.js";
import { loadState, planReconcile, saveState } from "./controller.js";
import { parseManifests } from "./spec.js";
import type { ClusterState, GitRepo, ReconcilePlan } from "./types.js";
import { readManifestTree } from "./watch.js";

export type GitRepoSyncResult = {
  repo: string;
  path: string;
  ok: boolean;
  reason?: string;
  /** Present when this path contributed manifests to the union. */
  included?: boolean;
};

export type MultiRepoSyncResult = {
  results: GitRepoSyncResult[];
  /** True when at least one path was included and reconcile ran. */
  synced: boolean;
  plan?: ReconcilePlan;
  state: ClusterState;
  changed: boolean;
  skippedDue?: boolean;
};

/** Resolve a GitRepo.spec.path against the workspace root (local stub). */
export function resolveGitRepoPath(root: string, repo: GitRepo): string {
  const p = repo.spec.path;
  if (isAbsolute(p)) return p;
  return resolve(root, p);
}

/** Checkout path after `ropex clone` materializes a remote GitRepo. */
export function resolveClonedRepoManifestPath(root: string, repo: GitRepo): string {
  const checkout = join(root, ".ropex", "repos", repo.metadata.name);
  const rel = repo.spec.path.replace(/^\//, "");
  return join(checkout, rel);
}

/** Prefer declared path; fall back to root/fleets when path mentions fleets; then cloned checkout. */
export function resolveRepoLocalPath(root: string, repo: GitRepo): { path: string; ok: boolean; reason?: string } {
  const path = resolveGitRepoPath(root, repo);
  if (existsSync(path)) return { path, ok: true };
  const fallback = join(root, "fleets");
  if (existsSync(fallback) && repo.spec.path.includes("fleets")) {
    return { path: fallback, ok: true };
  }
  const cloned = resolveClonedRepoManifestPath(root, repo);
  if (existsSync(cloned)) {
    return { path: cloned, ok: true };
  }
  const checkout = join(root, ".ropex", "repos", repo.metadata.name);
  if (existsSync(checkout)) {
    return { path: cloned, ok: true, reason: `using clone checkout (manifest path pending): ${cloned}` };
  }
  return {
    path,
    ok: false,
    reason: `path missing — run ropex clone --remote or ropex watch --repos: ${path}`,
  };
}

export type ResolvedRepo = {
  repo: GitRepo;
  path: string;
  raw: string;
};

/**
 * Read every resolvable GitRepo path. Missing paths are reported, not fatal.
 * Manifests are concatenated so Policy/Agent/Fleet from all repos share one reconcile.
 */
export function collectMultiRepoManifests(
  root: string,
  repos: GitRepo[],
): { resolved: ResolvedRepo[]; missing: GitRepoSyncResult[] } {
  const resolved: ResolvedRepo[] = [];
  const missing: GitRepoSyncResult[] = [];
  const seenPaths = new Set<string>();

  for (const repo of repos) {
    const loc = resolveRepoLocalPath(root, repo);
    if (!loc.ok) {
      missing.push({ repo: repo.metadata.name, path: loc.path, ok: false, reason: loc.reason });
      continue;
    }
    if (seenPaths.has(loc.path)) {
      // Two GitRepo objects pointing at the same tree — include once, still mark ok.
      missing.push({
        repo: repo.metadata.name,
        path: loc.path,
        ok: true,
        included: false,
        reason: "duplicate path (already included)",
      });
      continue;
    }
    seenPaths.add(loc.path);
    resolved.push({
      repo,
      path: loc.path,
      raw: readManifestTree(loc.path),
    });
  }
  return { resolved, missing };
}

function stampSyncStatus(
  state: ClusterState,
  results: GitRepoSyncResult[],
  at: string,
): void {
  if (!state.gitRepoStatus) state.gitRepoStatus = [];
  for (const r of results) {
    const prev = state.gitRepoStatus.find((s) => s.name === r.repo);
    const row = {
      name: r.repo,
      path: r.path,
      lastSyncedAt: r.ok && r.included !== false ? at : prev?.lastSyncedAt,
      ok: r.ok,
      reason: r.reason,
    };
    if (prev) Object.assign(prev, row);
    else state.gitRepoStatus.push(row);
  }
}

/**
 * Sync all declared GitRepos by unioning their local manifest trees into one reconcile.
 * Unlike per-path watchOnce, this keeps agents from repo A when syncing repo B.
 */
export function syncGitRepos(
  root: string,
  state: ClusterState,
  opts: { persist?: boolean; now?: number } = {},
): GitRepoSyncResult[] {
  const bundle = syncMultiRepo(root, state, opts);
  return bundle.results;
}

/**
 * Full multi-repo sync with plan + updated state.
 */
export function syncMultiRepo(
  root: string,
  state: ClusterState,
  opts: { persist?: boolean; now?: number } = {},
): MultiRepoSyncResult {
  const repos = state.gitRepos ?? [];
  const at = new Date(opts.now ?? Date.now()).toISOString();

  if (!repos.length) {
    return { results: [], synced: false, state, changed: false };
  }

  const { resolved, missing } = collectMultiRepoManifests(root, repos);
  const results: GitRepoSyncResult[] = [
    ...missing,
    ...resolved.map((r) => ({
      repo: r.repo.metadata.name,
      path: r.path,
      ok: true,
      included: true,
    })),
  ];

  if (!resolved.length) {
    for (const m of missing) {
      recordAudit(state, {
        kind: "sync",
        message: `sync skipped ${m.repo}: ${m.reason ?? "missing"}`,
        meta: { path: m.path, ok: false },
      });
    }
    stampSyncStatus(state, results, at);
    if (opts.persist !== false) saveState(root, state);
    return { results, synced: false, state, changed: false };
  }

  const raw = resolved.map((r) => r.raw).join("\n---\n");
  const source = resolved.map((r) => r.path).join("+");
  const base = opts.persist === false ? state : loadState(root);
  const { next, plan } = planReconcile(base, parseManifests(raw), source, { root });
  const changed = plan.create.length + plan.retire.length + plan.capped.length > 0;

  stampSyncStatus(next, results, at);
  recordAudit(next, {
    kind: "sync",
    message: `multi-repo sync paths=${resolved.length} missing=${missing.length}`,
    meta: {
      paths: resolved.length,
      missing: missing.length,
      create: plan.create.length,
      retire: plan.retire.length,
      changed,
      source,
    },
  });

  if (opts.persist !== false) saveState(root, next);

  return { results, synced: true, plan, state: next, changed };
}

/**
 * True when a repo has never synced or its interval has elapsed.
 */
export function isRepoDue(repo: GitRepo, state: ClusterState, now = Date.now()): boolean {
  const status = state.gitRepoStatus?.find((s) => s.name === repo.metadata.name);
  if (!status?.lastSyncedAt) return true;
  const last = Date.parse(status.lastSyncedAt);
  if (!Number.isFinite(last)) return true;
  return now - last >= gitRepoIntervalMs(repo);
}

/** Repos whose sync interval has elapsed (or never synced). */
export function reposDueForSync(state: ClusterState, now = Date.now()): GitRepo[] {
  return (state.gitRepos ?? []).filter((r) => isRepoDue(r, state, now));
}

/**
 * Run a multi-repo union sync only when at least one declared repo is due.
 */
export function syncDueGitRepos(
  root: string,
  state: ClusterState,
  opts: { persist?: boolean; now?: number } = {},
): MultiRepoSyncResult {
  const now = opts.now ?? Date.now();
  const due = reposDueForSync(state, now);
  if (!due.length) {
    return {
      results: (state.gitRepos ?? []).map((r) => {
        const loc = resolveRepoLocalPath(root, r);
        return {
          repo: r.metadata.name,
          path: loc.path,
          ok: true,
          included: false,
          reason: "interval not elapsed",
        };
      }),
      synced: false,
      skippedDue: true,
      state,
      changed: false,
    };
  }
  return syncMultiRepo(root, state, opts);
}

/** Parse interval from GitRepo.spec.interval (e.g. 30s, 5m, 1h). */
export function gitRepoIntervalMs(repo: GitRepo, fallback = 30_000): number {
  const raw = repo.spec.interval ?? "";
  const m = /^(\d+)(ms|s|m|h)?$/.exec(raw.trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  if (unit === "ms") return n;
  if (unit === "m") return n * 60_000;
  if (unit === "h") return n * 3_600_000;
  return n * 1000;
}
