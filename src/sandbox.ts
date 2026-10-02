/**
 * Sandbox providers — where an agent's `execute` stage runs.
 *
 * Hermes still composes, plans and learns on the control plane; only the place
 * the executor runs commands changes. `local` is the per-worker git worktree
 * (the original behaviour). `docker` is one container per task. Another isolate
 * (SSH host, VM) is one more provider implementing `SandboxProvider`.
 */

import { dockerProvider } from "./sandbox-docker.js";
import { localProvider } from "./sandbox-local.js";
import { admitSandbox, sandboxProvider } from "./sandbox-spec.js";
import type { SnapshotRecord } from "./sandbox-store.js";
import type { RunProcessResult } from "./proc.js";
import type { DockerRun } from "./sandbox-client.js";
import type {
  Policy,
  SandboxProviderKind,
  SandboxSpec,
  Worker,
} from "./types.js";

export type SandboxExecOptions = {
  /** Directory the command starts in. Defaults to the sandbox `cwd`. */
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  /**
   * Extra environment for this command. Treated as sensitive: the docker provider
   * forwards names only (`-e NAME`) so values never appear on an argv.
   */
  env?: Record<string, string | undefined>;
  onStdout?: (chunk: string) => void;
};

export type Sandbox = {
  id: string;
  kind: SandboxProviderKind;
  /** Working directory as the executor sees it (`/workspace` in a container). */
  cwd: string;
  /** Host directory Hermes and the harness use as their cwd. */
  hostCwd: string;
  /** Image the isolate started from, when there is one. */
  imageRef?: string;
  exec(bin: string, args: string[], opts?: SandboxExecOptions): Promise<RunProcessResult>;
  /** Locate an executable inside the sandbox; undefined when it is missing. */
  resolveBin(bin: string): Promise<string | undefined>;
  /** Persist the isolate. Providers that cannot snapshot return undefined. */
  snapshot(label: string): Promise<SnapshotRecord | undefined>;
  copyOut(src: string, dest: string): Promise<void>;
  /** Release the isolate. Idempotent. */
  dispose(): Promise<void>;
};

export type SandboxAcquireContext = {
  /** Workspace root (worktrees, scratch, `.ropex`). */
  root: string;
  worker: Pick<Worker, "id" | "agent" | "imageDigest" | "worktree">;
  taskId?: string;
  /** Control-plane environment tokens are read from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  policies?: Policy[];
  /** Injectable docker client; tests pass a fake. */
  docker?: DockerRun;
  /** Snapshot store directory (`ROPEX_SANDBOX_DIR`). */
  storeDir?: string;
};

export type SandboxProbe = {
  kind: SandboxProviderKind;
  label: string;
  ready: boolean;
  bin?: string;
  hint: string;
};

export type SandboxProvider = {
  kind: SandboxProviderKind;
  label: string;
  /** Availability check that never spawns anything. */
  probe(env?: NodeJS.ProcessEnv): SandboxProbe;
  acquire(spec: SandboxSpec | undefined, ctx: SandboxAcquireContext): Promise<Sandbox>;
};

export const SANDBOX_PROVIDERS: Record<SandboxProviderKind, SandboxProvider> = {
  local: localProvider,
  docker: dockerProvider,
};

export function sandboxScaffold(env: NodeJS.ProcessEnv = process.env): SandboxProbe[] {
  return Object.values(SANDBOX_PROVIDERS).map((p) => p.probe(env));
}

/** True when the sandbox runs against a worktree on the host. */
export function needsHostWorktree(spec: SandboxSpec | undefined): boolean {
  const kind = sandboxProvider(spec);
  if (kind === "local") return true;
  return spec?.repo?.workspace === "mount";
}

/**
 * Admit against policy, then ask the provider for an isolate.
 * Fails closed: a policy violation or an unavailable provider throws.
 */
export async function acquireSandbox(
  spec: SandboxSpec | undefined,
  ctx: SandboxAcquireContext,
): Promise<Sandbox> {
  const kind = sandboxProvider(spec);
  const env = ctx.env ?? process.env;
  const admitted = admitSandbox(ctx.policies ?? [], spec);
  if (!admitted.ok) throw new Error(admitted.reason);
  if (kind !== "local" && env.ROPEX_IN_SESSION === "1") {
    throw new Error(
      `sandbox provider "${kind}" is unavailable inside a pipeline session container (ROPEX_IN_SESSION=1); ` +
        `use provider: local, or leave ROPEX_EXECUTOR unset`,
    );
  }
  const provider = SANDBOX_PROVIDERS[kind];
  if (!provider) throw new Error(`unknown sandbox provider "${kind}"`);
  return provider.acquire(spec, { ...ctx, env });
}
