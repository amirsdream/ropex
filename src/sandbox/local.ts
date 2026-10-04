/**
 * Local sandbox — the per-worker git worktree. Behaviour matches the original
 * `ensureWorktree` + `runProcess` path; the worktree outlives the task and is torn
 * down with the worker (`destroyWorker`), so `dispose` has nothing to do.
 */

import { cpSync, existsSync } from "node:fs";

import { binOnPath, runProcess } from "../proc.js";
import type { Sandbox, SandboxAcquireContext, SandboxProvider } from "./index.js";
import type { SandboxSpec } from "../types.js";
import { ensureWorktree } from "../worktree.js";

function cleanEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

export async function acquireLocalSandbox(
  spec: SandboxSpec | undefined,
  ctx: SandboxAcquireContext,
): Promise<Sandbox> {
  const { worker } = ctx;
  // A recorded worktree can outlive the directory (container restart, cleanup).
  // Re-materialise it rather than handing a runtime a path that no longer exists.
  const cwd =
    worker.worktree && existsSync(worker.worktree) ? worker.worktree : ensureWorktree(ctx.root, worker);
  const base = ctx.env ?? process.env;
  const envFor = (extra?: Record<string, string | undefined>) =>
    cleanEnv({ ...base, ...spec?.env, ...extra });

  return {
    id: worker.id,
    kind: "local",
    cwd,
    hostCwd: cwd,
    exec(bin, args, opts = {}) {
      return runProcess(bin, args, {
        cwd: opts.cwd ?? cwd,
        env: envFor(opts.env),
        timeoutMs: opts.timeoutMs,
        stdin: opts.stdin,
        onStdout: opts.onStdout,
      });
    },
    async resolveBin(bin) {
      return binOnPath(bin, base);
    },
    async snapshot() {
      return undefined;
    },
    async copyOut(src, dest) {
      cpSync(src, dest, { recursive: true });
    },
    async dispose() {
      // The worktree is owned by the worker, not the task.
    },
  };
}

export const localProvider: SandboxProvider = {
  kind: "local",
  label: "Local git worktree",
  probe() {
    return {
      kind: "local",
      label: "Local git worktree",
      ready: true,
      hint: "Always available — commands run on the host inside the worker's git worktree.",
    };
  },
  acquire: acquireLocalSandbox,
};
