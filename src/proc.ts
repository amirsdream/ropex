/**
 * Shared subprocess primitive for every runtime that shells out.
 * One place owns timeout, stdout/stderr capture, stdin, and exit handling so
 * adapters (dsh headless, Claude Code / Codex / Copilot CLIs, live Hermes, git
 * clone) stay declarative.
 */

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type RunProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export const DEFAULT_PROCESS_TIMEOUT_MS = 120_000;
/** After SIGTERM, wait this long before SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = 5_000;
/** After SIGKILL, wait this long then resolve anyway so drain cannot hang. */
export const DEFAULT_FORCE_EXIT_MS = 2_000;

export type RunProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Hard kill after this many ms (default 120s). */
  timeoutMs?: number;
  /** After SIGTERM, wait this long before SIGKILL (default 5s). */
  killGraceMs?: number;
  /** After SIGKILL, wait this long then resolve anyway (default 2s). */
  forceExitMs?: number;
  /** Written to the child's stdin, then the stream is closed. */
  stdin?: string;
  /** Streamed stdout chunks — lets adapters emit live progress. */
  onStdout?: (chunk: string) => void;
};

/** Run a binary to completion. Never throws on non-zero exit — inspect `code`. */
export function runProcess(
  bin: string,
  args: string[],
  opts: RunProcessOptions = {},
): Promise<RunProcessResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const forceExitMs = opts.forceExitMs ?? DEFAULT_FORCE_EXIT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: [opts.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (result: RunProcessResult | Error) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const arm = (ms: number, fn: () => void) => {
      timers.push(setTimeout(fn, ms));
    };

    if (opts.stdin !== undefined) {
      child.stdin?.on("error", () => {
        // EPIPE if the child exits before consuming stdin.
      });
      child.stdin?.end(opts.stdin);
    }
    child.stdout?.on("data", (c) => {
      const text = String(c);
      stdout += text;
      opts.onStdout?.(text);
    });
    child.stderr?.on("data", (c) => {
      stderr += String(c);
    });

    arm(timeoutMs, () => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // already dead
      }
      arm(killGraceMs, () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
        arm(forceExitMs, () => {
          finish({ code: child.exitCode, stdout, stderr, timedOut: true });
        });
      });
    });

    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Synchronous counterpart for call sites that cannot become async (`clone`,
 * live Hermes plan). Timeout uses spawnSync's built-in kill; the async
 * `runProcess` is the one that escalates SIGTERM → SIGKILL → force-resolve.
 */
export function runProcessSync(
  bin: string,
  args: string[],
  opts: RunProcessOptions = {},
): RunProcessResult {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  const result = spawnSync(bin, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    input: opts.stdin,
    windowsHide: true,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code !== "ETIMEDOUT") {
    throw result.error;
  }
  const timedOut =
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
    result.signal === "SIGTERM" ||
    result.signal === "SIGKILL";
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut,
  };
}

const WINDOWS_EXTS = ["", ".exe", ".cmd", ".bat"];

/**
 * Resolve a binary on PATH without spawning anything (probe stays network- and
 * side-effect-free so `workerRuntimeScaffold` is safe to call from the API).
 */
export function binOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!bin) return undefined;
  const exts = process.platform === "win32" ? WINDOWS_EXTS : [""];
  const candidates = bin.includes("/") || bin.includes("\\") || isAbsolute(bin)
    ? [bin]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, bin));
  for (const candidate of candidates) {
    for (const ext of exts) {
      try {
        accessSync(candidate + ext, constants.X_OK);
        return candidate + ext;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}
