/**
 * GitRepo clone contract — seam for remote materialization without network in tests.
 * file:// and existing local paths succeed; https/git remotes fail closed until wired.
 * Progress phases make the fail-closed remote path observable for UI / tick / CLI.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { recordAudit } from "./audit.js";
import type { ClusterState, GitRepo, GitRepoSyncStatus } from "./types.js";
import { resolveGitRepoPath } from "./gitrepo.js";

export type CloneBackend = "local-copy" | "remote-stub" | "git-remote";

export type ClonePhase =
  | "resolve"
  | "local-present"
  | "copy"
  | "remote-blocked"
  | "done"
  | "failed";

export type CloneProgressStep = {
  phase: ClonePhase;
  at: string;
  detail: string;
  pct: number;
};

export type CloneResult = {
  repo: string;
  url: string;
  dest: string;
  ok: boolean;
  backend: CloneBackend;
  reason?: string;
  /** Final phase reached. */
  phase: ClonePhase;
  /** 0–100 progress (100 only when ok). */
  progressPct: number;
  /** Ordered phase log for this attempt. */
  steps: CloneProgressStep[];
};

export type CloneOptions = {
  /** Destination root for checkouts (default `<root>/.ropex/repos`). */
  destRoot?: string;
  /** When true, refresh an existing dest by replacing it (default false). */
  force?: boolean;
  /** When true, only plan phases — do not copy or mutate filesystem. */
  dryRun?: boolean;
  /** When true (or ROPEX_GIT_CLONE=1), run `git clone` for https/git remotes. Off in vitest. */
  remote?: boolean;
};

function remoteCloneEnabled(opts: CloneOptions): boolean {
  if (!(opts.remote || process.env.ROPEX_GIT_CLONE === "1")) return false;
  if (process.env.VITEST === "true" && !opts.dryRun) return false;
  return true;
}

function runGitClone(
  url: string,
  dest: string,
  branch: string | undefined,
  opts: CloneOptions,
): { ok: boolean; reason?: string } {
  if (opts.dryRun) {
    return { ok: true, reason: "dry-run (no git clone)" };
  }
  if (existsSync(dest)) {
    if (opts.force) rmSync(dest, { recursive: true, force: true });
    else return { ok: true, reason: "dest already exists" };
  }
  mkdirSync(dirname(dest), { recursive: true });
  const args = ["clone", "--depth", "1"];
  if (branch) args.push("-b", branch);
  args.push(url, dest);
  const result = spawnSync("git", args, { encoding: "utf8", timeout: 300_000 });
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || "git clone failed").trim();
    return { ok: false, reason: msg.slice(0, 500) };
  }
  return { ok: true };
}

function parseFileUrl(url: string): string | null {
  if (url.startsWith("file://")) {
    return decodeURIComponent(url.slice("file://".length));
  }
  return null;
}

function isRemoteUrl(url: string): boolean {
  return /^(https?|git|ssh):/i.test(url) || url.includes("github.com:") || url.startsWith("git@");
}

function step(phase: ClonePhase, detail: string, pct: number): CloneProgressStep {
  return { phase, at: new Date().toISOString(), detail, pct };
}

function finish(
  base: Omit<CloneResult, "phase" | "progressPct" | "steps"> & {
    phase: ClonePhase;
    progressPct: number;
    steps: CloneProgressStep[];
  },
): CloneResult {
  return base;
}

/**
 * Materialize a GitRepo into a local checkout path.
 * - Existing `spec.path` → ok (already local)
 * - `file://` URL → copy into dest (network-free)
 * - https/git → fail closed with explicit contract message
 */
export function cloneGitRepo(
  root: string,
  repo: GitRepo,
  opts: CloneOptions = {},
): CloneResult {
  const destRoot = opts.destRoot ?? join(root, ".ropex", "repos");
  const dest = join(destRoot, repo.metadata.name);
  const url = repo.spec.url;
  const localPath = resolveGitRepoPath(root, repo);
  const steps: CloneProgressStep[] = [
    step("resolve", `resolve ${repo.metadata.name} → ${url}`, 5),
  ];

  if (existsSync(localPath)) {
    steps.push(step("local-present", `spec.path present: ${localPath}`, 80));
    steps.push(step("done", "already local", 100));
    return finish({
      repo: repo.metadata.name,
      url,
      dest: localPath,
      ok: true,
      backend: "local-copy",
      reason: "spec.path already present",
      phase: "done",
      progressPct: 100,
      steps,
    });
  }

  const filePath = parseFileUrl(url);
  if (filePath) {
    const src = resolve(filePath);
    if (!existsSync(src)) {
      steps.push(step("failed", `file:// source missing: ${src}`, 20));
      return finish({
        repo: repo.metadata.name,
        url,
        dest,
        ok: false,
        backend: "local-copy",
        reason: `file:// source missing: ${src}`,
        phase: "failed",
        progressPct: 20,
        steps,
      });
    }
    steps.push(step("copy", opts.dryRun ? `would copy ${src} → ${dest}` : `copy ${src} → ${dest}`, 60));
    if (!opts.dryRun) {
      if (existsSync(dest) && opts.force) {
        rmSync(dest, { recursive: true, force: true });
      }
      if (!existsSync(dest)) {
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(src, dest, { recursive: true });
      }
    }
    steps.push(step("done", opts.dryRun ? "dry-run ok" : "copy complete", 100));
    return finish({
      repo: repo.metadata.name,
      url,
      dest,
      ok: true,
      backend: "local-copy",
      reason: opts.dryRun ? "dry-run (no filesystem write)" : undefined,
      phase: "done",
      progressPct: 100,
      steps,
    });
  }

  if (isRemoteUrl(url)) {
    if (remoteCloneEnabled(opts)) {
      steps.push(step("copy", opts.dryRun ? `would git clone ${url}` : `git clone ${url}`, 55));
      const cloned = runGitClone(url, dest, repo.spec.branch, opts);
      if (!cloned.ok) {
        steps.push(step("failed", cloned.reason ?? "git clone failed", 70));
        return finish({
          repo: repo.metadata.name,
          url,
          dest,
          ok: false,
          backend: "git-remote",
          reason: cloned.reason,
          phase: "failed",
          progressPct: 70,
          steps,
        });
      }
      steps.push(step("done", opts.dryRun ? "dry-run ok" : "git clone complete", 100));
      return finish({
        repo: repo.metadata.name,
        url,
        dest,
        ok: true,
        backend: "git-remote",
        reason: cloned.reason,
        phase: "done",
        progressPct: 100,
        steps,
      });
    }
    steps.push(
      step(
        "remote-blocked",
        "remote clone disabled — ropex clone --remote or ROPEX_GIT_CLONE=1",
        40,
      ),
    );
    steps.push(step("failed", "fail-closed remote", 40));
    return finish({
      repo: repo.metadata.name,
      url,
      dest,
      ok: false,
      backend: "remote-stub",
      reason: "remote clone disabled — ropex clone --remote or ROPEX_GIT_CLONE=1",
      phase: "failed",
      progressPct: 40,
      steps,
    });
  }

  steps.push(step("failed", `unsupported url scheme: ${url}`, 10));
  return finish({
    repo: repo.metadata.name,
    url,
    dest,
    ok: false,
    backend: "remote-stub",
    reason: `unsupported url scheme: ${url}`,
    phase: "failed",
    progressPct: 10,
    steps,
  });
}

/** Dry-run clone progress for all repos without mutating the filesystem. */
export function planCloneAll(
  root: string,
  state: ClusterState,
  opts: Omit<CloneOptions, "dryRun"> = {},
): CloneResult[] {
  return (state.gitRepos ?? []).map((repo) =>
    cloneGitRepo(root, repo, { ...opts, dryRun: true }),
  );
}

function upsertCloneStatus(state: ClusterState, result: CloneResult, path: string): void {
  if (!state.gitRepoStatus) state.gitRepoStatus = [];
  const now = new Date().toISOString();
  const row: GitRepoSyncStatus = {
    name: result.repo,
    path,
    ok: result.ok,
    reason: result.reason,
    cloneBackend: result.backend,
    clonePhase: result.phase,
    cloneProgressPct: result.progressPct,
    lastClonedAt: now,
    lastSyncedAt: result.ok ? now : undefined,
  };
  const idx = state.gitRepoStatus.findIndex((s) => s.name === result.repo);
  if (idx >= 0) {
    state.gitRepoStatus[idx] = { ...state.gitRepoStatus[idx], ...row };
  } else {
    state.gitRepoStatus.push(row);
  }
}

/** Clone / prepare every declared GitRepo; records audit + clone progress on state. */
export function cloneAllGitRepos(
  root: string,
  state: ClusterState,
  opts: CloneOptions = {},
): CloneResult[] {
  const results: CloneResult[] = [];
  for (const repo of state.gitRepos ?? []) {
    const r = cloneGitRepo(root, repo, opts);
    results.push(r);
    upsertCloneStatus(state, r, resolveGitRepoPath(root, repo));
    recordAudit(state, {
      kind: "sync",
      message: r.ok
        ? `clone ok ${r.repo} phase=${r.phase} ${r.progressPct}%`
        : `clone skipped ${r.repo}: ${r.reason}`,
      meta: {
        url: r.url,
        dest: r.dest,
        ok: r.ok,
        backend: r.backend,
        phase: r.phase,
        progressPct: r.progressPct,
        dryRun: Boolean(opts.dryRun),
      },
    });
  }
  return results;
}

/** Summarize last clone progress from gitRepoStatus (for UI / API). */
export function cloneStatusReport(state: ClusterState): {
  repos: number;
  ok: number;
  blocked: number;
  rows: GitRepoSyncStatus[];
} {
  const rows = state.gitRepoStatus ?? [];
  return {
    repos: rows.length,
    ok: rows.filter((r) => r.ok).length,
    blocked: rows.filter((r) => r.cloneBackend === "remote-stub" || r.clonePhase === "failed").length,
    rows: [...rows],
  };
}
