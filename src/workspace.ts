import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cliRuntime } from "./cli-runtimes/index.js";
import { resolveDshBackend, resolveDshBin } from "./dsh.js";
import { binOnPath } from "./proc.js";
import { sandboxProvider } from "./sandbox/spec.js";
import type { DesiredAgent, SandboxSpec } from "./types.js";
import { prepareRuntimeAuth, resolveRuntimeBin, resolveRuntimeKind } from "./worker-runtime.js";

export type GitRunResult = { code: number; stdout: string; stderr: string };

export type GitRunner = (
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => GitRunResult;

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export function workspaceSlug(taskId: string): string {
  const slug = taskId
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) throw new WorkspaceError("task id produces an empty branch slug");
  return slug.slice(0, 80);
}

export function workspaceBranch(taskId: string): string {
  return `ropex/${workspaceSlug(taskId)}`;
}

export type PreparedWorkspace = {
  checkout: string;
  worktree: string;
  branch: string;
  base: string;
  remote: string;
  agent: string;
};

export function assertWorkspaceRuntime(
  agent: DesiredAgent,
  opts: {
    env?: NodeJS.ProcessEnv;
    binExists?: (file: string) => boolean;
    fileExists?: (file: string) => boolean;
    homedir?: () => string;
  } = {},
): void {
  const env = opts.env ?? process.env;
  const kind = resolveRuntimeKind(agent.spec);
  const provider = sandboxProvider(agent.spec.sandbox);
  if (kind === "dsh") {
    if (resolveDshBackend() === "live") {
      if (provider === "docker") {
        throw new WorkspaceError(
          "live dsh cannot run in a docker sandbox; use a CLI runtime or unset ROPEX_DSH_BACKEND=live",
        );
      }
      if (!resolveDshBin()) throw new WorkspaceError("live dsh is not installed (@deepseek-ai/dsh)");
    }
    return;
  }
  const descriptor = cliRuntime(kind);
  prepareRuntimeAuth(agent.spec, {
    env,
    container: provider === "docker",
    fileExists: opts.fileExists,
    homedir: opts.homedir,
  });
  const bin = resolveRuntimeBin(descriptor, agent.spec.runtime, env);
  const exists = opts.binExists ?? ((file: string) => binOnPath(file, env) !== undefined);
  if (!exists(bin)) throw new WorkspaceError(`runtime ${kind} binary not found: ${bin}`);
}

function gitOut(result: GitRunResult): string {
  return result.stdout.trim();
}

export function prepareWorkspace(opts: {
  root: string;
  agent: DesiredAgent;
  taskId: string;
  dryRun?: boolean;
  git?: GitRunner;
  env?: NodeJS.ProcessEnv;
  binExists?: (file: string) => boolean;
  fileExists?: (file: string) => boolean;
  homedir?: () => string;
}): PreparedWorkspace {
  const workspace = opts.agent.spec.workspace;
  if (!workspace?.path) throw new WorkspaceError("workspace.path is required");
  assertWorkspaceRuntime(opts.agent, opts);
  const checkout = workspace.path;
  const remote = workspace.remote?.trim() || "origin";
  const exists = opts.fileExists ?? existsSync;
  if (!exists(checkout)) throw new WorkspaceError(`not a git checkout: ${checkout}`);
  const git = opts.git ?? ((() => {
    throw new WorkspaceError("git runner is required");
  }) as GitRunner);
  const run = (args: string[]) => git(args, { cwd: checkout });
  const inside = run(["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || gitOut(inside) !== "true") {
    throw new WorkspaceError(`not a git checkout: ${checkout}`);
  }
  const remoteUrl = run(["remote", "get-url", remote]);
  if (remoteUrl.code !== 0) throw new WorkspaceError(`remote ${remote} is missing`);
  let base = workspace.base?.trim();
  if (!base) {
    const head = run(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (head.code !== 0 || gitOut(head) === "HEAD") {
      throw new WorkspaceError("detached HEAD and workspace.base is unset");
    }
    base = gitOut(head);
  }
  const verified = run(["rev-parse", "--verify", `${base}^{commit}`]);
  if (verified.code !== 0) throw new WorkspaceError(`base ${base} does not exist`);
  const branch = workspaceBranch(opts.taskId);
  const slug = workspaceSlug(opts.taskId);
  const taken = run(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (taken.code === 0) throw new WorkspaceError(`branch ${branch} already exists`);
  const worktree = join(opts.root, ".ropex", "workspace", opts.agent.metadata.name, slug);
  if (!opts.dryRun) {
    mkdirSync(join(opts.root, ".ropex", "workspace", opts.agent.metadata.name), { recursive: true });
    const added = run(["worktree", "add", "-b", branch, worktree, base]);
    if (added.code !== 0) throw new WorkspaceError(`git worktree add failed: ${added.stderr.trim()}`);
  }
  return { checkout, worktree, branch, base, remote, agent: opts.agent.metadata.name };
}

export function sandboxSpecForWorkspace<T extends SandboxSpec>(spec: T | undefined, prepared: boolean): T | undefined {
  if (!prepared || sandboxProvider(spec) !== "docker") return spec;
  return {
    ...spec,
    provider: "docker",
    repo: { workspace: "mount" },
    lifecycle: spec?.lifecycle ? { ...spec.lifecycle, warmSnapshot: false } : undefined,
  };
}
