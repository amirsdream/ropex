/**
 * GitRepo clone contract — seam for remote materialization without network in tests.
 * file:// and existing local paths succeed; https/git remotes fail closed until wired.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { recordAudit } from "./audit.js";
import type { ClusterState, GitRepo } from "./types.js";
import { resolveGitRepoPath } from "./gitrepo.js";

export type CloneBackend = "local-copy" | "remote-stub";

export type CloneResult = {
  repo: string;
  url: string;
  dest: string;
  ok: boolean;
  backend: CloneBackend;
  reason?: string;
};

export type CloneOptions = {
  /** Destination root for checkouts (default `<root>/.ropex/repos`). */
  destRoot?: string;
  /** When true, refresh an existing dest by replacing it (default false). */
  force?: boolean;
};

function parseFileUrl(url: string): string | null {
  if (url.startsWith("file://")) {
    return decodeURIComponent(url.slice("file://".length));
  }
  return null;
}

function isRemoteUrl(url: string): boolean {
  return /^(https?|git|ssh):/i.test(url) || url.includes("github.com:") || url.startsWith("git@");
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

  if (existsSync(localPath)) {
    return {
      repo: repo.metadata.name,
      url,
      dest: localPath,
      ok: true,
      backend: "local-copy",
      reason: "spec.path already present",
    };
  }

  const filePath = parseFileUrl(url);
  if (filePath) {
    const src = resolve(filePath);
    if (!existsSync(src)) {
      return {
        repo: repo.metadata.name,
        url,
        dest,
        ok: false,
        backend: "local-copy",
        reason: `file:// source missing: ${src}`,
      };
    }
    if (existsSync(dest) && opts.force) {
      rmSync(dest, { recursive: true, force: true });
    }
    if (!existsSync(dest)) {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: true });
    }
    return {
      repo: repo.metadata.name,
      url,
      dest,
      ok: true,
      backend: "local-copy",
    };
  }

  if (isRemoteUrl(url)) {
    return {
      repo: repo.metadata.name,
      url,
      dest,
      ok: false,
      backend: "remote-stub",
      reason: "remote clone not wired (https/git); use file:// or local spec.path",
    };
  }

  return {
    repo: repo.metadata.name,
    url,
    dest,
    ok: false,
    backend: "remote-stub",
    reason: `unsupported url scheme: ${url}`,
  };
}

/** Clone / prepare every declared GitRepo; records audit events on the state. */
export function cloneAllGitRepos(
  root: string,
  state: ClusterState,
  opts: CloneOptions = {},
): CloneResult[] {
  const results: CloneResult[] = [];
  for (const repo of state.gitRepos ?? []) {
    const r = cloneGitRepo(root, repo, opts);
    results.push(r);
    recordAudit(state, {
      kind: "sync",
      message: r.ok ? `clone ok ${r.repo}` : `clone skipped ${r.repo}: ${r.reason}`,
      meta: { url: r.url, dest: r.dest, ok: r.ok, backend: r.backend },
    });
  }
  return results;
}
