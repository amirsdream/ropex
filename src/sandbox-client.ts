/**
 * Thin docker/podman client for the sandbox layer. Everything goes through
 * `runProcess` so timeout and kill escalation are shared with every other
 * subprocess, and tests inject a fake instead of needing a container runtime.
 */

import { runProcess, runProcessSync, type RunProcessResult } from "./proc.js";
import { resolveContainerBin } from "./session.js";

export type DockerRunOptions = {
  cwd?: string;
  /** Merged over the process env. Values forwarded with `-e NAME` come from here. */
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
};

export type DockerRun = (args: string[], opts?: DockerRunOptions) => Promise<RunProcessResult>;

export type DockerSync = (args: string[], opts?: { timeoutMs?: number }) => RunProcessResult;

const NO_RUNTIME =
  "No container runtime is running. Install Docker, or start Podman (`podman machine start`), or use sandbox provider: local.";

export function defaultDockerRun(base: NodeJS.ProcessEnv = process.env): DockerRun {
  return async (args, opts = {}) => {
    const bin = resolveContainerBin(base);
    try {
      return await runProcess(bin, args, {
        cwd: opts.cwd,
        env: { ...base, ...opts.env },
        stdin: opts.stdin,
        timeoutMs: opts.timeoutMs ?? 600_000,
        onStdout: opts.onStdout,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(NO_RUNTIME);
      throw err;
    }
  };
}

export function defaultDockerSync(base: NodeJS.ProcessEnv = process.env): DockerSync {
  return (args, opts = {}) => {
    try {
      return runProcessSync(resolveContainerBin(base), args, {
        env: base,
        timeoutMs: opts.timeoutMs ?? 30_000,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(NO_RUNTIME);
      throw err;
    }
  };
}

/** Throw with the runtime's own message when a docker call exits non-zero. */
export function expectOk(res: RunProcessResult, what: string): RunProcessResult {
  if (res.timedOut) throw new Error(`${what} timed out`);
  if (res.code !== 0) {
    throw new Error(`${what} failed: ${res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`}`);
  }
  return res;
}
