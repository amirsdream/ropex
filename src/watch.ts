/**
 * Flux-style GitRepo watch — re-read local manifest paths and reconcile.
 * `--repos` mode clones due GitRepos then union-syncs declared paths.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadState, planReconcile, saveState } from "./controller.js";
import { cloneAllGitRepos } from "./clone.js";
import { syncMultiRepo, reposDueForSync } from "./gitrepo.js";
import { parseManifests } from "./spec.js";
import type { ClusterState, ReconcilePlan } from "./types.js";

export type WatchOnceResult = {
  source: string;
  state: ClusterState;
  plan: ReconcilePlan;
  /** True when workers were created, retired, or replica-capped. */
  changed: boolean;
};

export function readManifestTree(path: string): string {
  const st = statSync(path);
  if (st.isFile()) return readFileSync(path, "utf8");
  const files = readdirSync(path)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  return files.map((f) => readFileSync(join(path, f), "utf8")).join("\n---\n");
}

/** One reconcile pass against a local GitRepo path (or any manifest directory). */
export function watchOnce(
  root: string,
  manifestPath: string,
  opts: { persist?: boolean } = {},
): WatchOnceResult {
  const source = manifestPath;
  const raw = readManifestTree(manifestPath);
  const current = loadState(root);
  const { next, plan } = planReconcile(current, parseManifests(raw), source, { root });
  const changed = plan.create.length + plan.retire.length + plan.capped.length > 0;
  if (opts.persist !== false) {
    saveState(root, next);
  }
  return { source, state: next, plan, changed };
}

export type WatchLoopOptions = {
  root: string;
  path: string;
  intervalMs: number;
  /** Max iterations; omit for infinite (caller should abort). */
  maxTicks?: number;
  onTick?: (result: WatchOnceResult, tick: number) => void;
  /** Test hook — return false to stop. */
  shouldContinue?: (tick: number) => boolean;
};

/**
 * Polling watch loop. Network-free; suitable for tests with maxTicks.
 * Production: `ropex watch --interval 5s fleets/`.
 */
export async function watchLoop(opts: WatchLoopOptions): Promise<WatchOnceResult[]> {
  const results: WatchOnceResult[] = [];
  let tick = 0;
  const max = opts.maxTicks ?? Number.POSITIVE_INFINITY;

  while (tick < max) {
    if (opts.shouldContinue && !opts.shouldContinue(tick)) break;
    const result = watchOnce(opts.root, opts.path);
    results.push(result);
    opts.onTick?.(result, tick);
    tick += 1;
    if (tick >= max) break;
    await sleep(opts.intervalMs);
  }

  return results;
}

export type WatchReposOptions = {
  persist?: boolean;
  now?: number;
  /** Clone remotes before sync (requires ROPEX_GIT_CLONE=1 or --remote). */
  remote?: boolean;
  /** When true, clone/sync even if interval not elapsed. */
  force?: boolean;
};

/** One pass: optional clone, then multi-repo union sync + reconcile. */
export function watchDeclaredRepos(
  root: string,
  state: ClusterState,
  opts: WatchReposOptions = {},
): WatchOnceResult {
  const now = opts.now ?? Date.now();
  const due = opts.force ? (state.gitRepos ?? []) : reposDueForSync(state, now);
  if (due.length && (opts.remote || process.env.ROPEX_GIT_CLONE === "1")) {
    cloneAllGitRepos(root, state, { remote: opts.remote });
  }
  const bundle = syncMultiRepo(root, state, { persist: opts.persist, now });
  const source = bundle.results.map((r) => r.path).join("+") || "gitrepos";
  return {
    source,
    state: bundle.state,
    plan: bundle.plan ?? { create: [], update: [], retire: [], capped: [] },
    changed: bundle.changed,
  };
}

export type WatchReposLoopOptions = {
  root: string;
  intervalMs: number;
  maxTicks?: number;
  remote?: boolean;
  force?: boolean;
  onTick?: (result: WatchOnceResult, tick: number) => void;
  shouldContinue?: (tick: number) => boolean;
};

/** Polling watch over declared GitRepos (clone + union sync). */
export async function watchReposLoop(opts: WatchReposLoopOptions): Promise<WatchOnceResult[]> {
  const results: WatchOnceResult[] = [];
  let tick = 0;
  const max = opts.maxTicks ?? Number.POSITIVE_INFINITY;

  while (tick < max) {
    if (opts.shouldContinue && !opts.shouldContinue(tick)) break;
    const state = loadState(opts.root);
    const result = watchDeclaredRepos(opts.root, state, {
      remote: opts.remote,
      force: opts.force,
    });
    results.push(result);
    opts.onTick?.(result, tick);
    tick += 1;
    if (tick >= max) break;
    await sleep(opts.intervalMs);
  }

  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse interval strings like `5s`, `30s`, `1m` into milliseconds. */
export function parseInterval(text: string): number {
  const m = /^(\d+)(ms|s|m)?$/.exec(text.trim());
  if (!m) throw new Error(`invalid interval: ${text}`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  if (unit === "ms") return n;
  if (unit === "m") return n * 60_000;
  return n * 1000;
}
