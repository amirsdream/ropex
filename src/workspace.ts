import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cliRuntime } from "./cli-runtimes/index.js";
import { resolveDshBackend, resolveDshBin } from "./dsh.js";
import { binOnPath, runProcessSync } from "./proc.js";
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

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: "Ropex",
  GIT_AUTHOR_EMAIL: "ropex@localhost",
  GIT_COMMITTER_NAME: "Ropex",
  GIT_COMMITTER_EMAIL: "ropex@localhost",
};

export function defaultGitRunner(): GitRunner {
  return (args, opts) => {
    const result = runProcessSync("git", args, {
      cwd: opts?.cwd,
      env: opts?.env,
      timeoutMs: 300_000,
    });
    return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr };
  };
}

export type WorkspaceResult = {
  branch: string;
  commit?: string;
  remote: string;
  pushed: boolean;
};

export type PublishWorkspaceOutcome = {
  result?: WorkspaceResult;
  error?: string;
  keepBranch: boolean;
};

export function publishWorkspace(opts: {
  prepared: PreparedWorkspace;
  taskId: string;
  git?: GitRunner;
}): PublishWorkspaceOutcome {
  const git = opts.git ?? defaultGitRunner();
  const { prepared, taskId } = opts;
  const run = (args: string[], env?: NodeJS.ProcessEnv) =>
    git(args, { cwd: prepared.worktree, env });
  const head = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const headName = head.stdout.trim();
  if (head.code !== 0 || headName !== prepared.branch) {
    return {
      keepBranch: true,
      error: `refusing to publish: HEAD is ${headName || "unknown"}, expected ${prepared.branch}`,
      result: { branch: prepared.branch, remote: prepared.remote, pushed: false },
    };
  }
  const status = run(["status", "--porcelain"]);
  if (status.code !== 0) {
    return {
      keepBranch: true,
      error: status.stderr.trim() || "git status failed",
      result: { branch: prepared.branch, remote: prepared.remote, pushed: false },
    };
  }
  if (status.stdout.trim()) {
    const added = run(["add", "-A"]);
    if (added.code !== 0) {
      return {
        keepBranch: true,
        error: added.stderr.trim() || "git add failed",
        result: { branch: prepared.branch, remote: prepared.remote, pushed: false },
      };
    }
    const committed = run(
      ["-c", "commit.gpgsign=false", "commit", "-m", `ropex: ${taskId}`],
      { ...process.env, ...COMMIT_ENV },
    );
    if (committed.code !== 0) {
      return {
        keepBranch: true,
        error: committed.stderr.trim() || "git commit failed",
        result: { branch: prepared.branch, remote: prepared.remote, pushed: false },
      };
    }
  }
  const count = run(["rev-list", "--count", `${prepared.base}..HEAD`]);
  if (count.code !== 0) {
    return {
      keepBranch: true,
      error: count.stderr.trim() || `cannot tell if ${prepared.branch} is ahead of ${prepared.base}`,
      result: { branch: prepared.branch, remote: prepared.remote, pushed: false },
    };
  }
  if (Number(count.stdout.trim()) === 0) {
    return { keepBranch: false, error: `no changes on ${prepared.branch}` };
  }
  const sha = run(["rev-parse", "HEAD"]).stdout.trim();
  const pushed = run(["push", "-u", prepared.remote, prepared.branch]);
  if (pushed.code !== 0) {
    return {
      keepBranch: true,
      error: pushed.stderr.trim() || "git push failed",
      result: { branch: prepared.branch, commit: sha, remote: prepared.remote, pushed: false },
    };
  }
  return {
    keepBranch: true,
    result: { branch: prepared.branch, commit: sha, remote: prepared.remote, pushed: true },
  };
}

export function cleanupWorkspace(
  prepared: PreparedWorkspace,
  opts: { deleteBranch: boolean; git?: GitRunner },
): void {
  const git = opts.git ?? defaultGitRunner();
  const removed = git(["worktree", "remove", "--force", prepared.worktree], { cwd: prepared.checkout });
  if (removed.code !== 0) rmSync(prepared.worktree, { recursive: true, force: true });
  if (opts.deleteBranch) git(["branch", "-D", prepared.branch], { cwd: prepared.checkout });
}

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
  const git = opts.git ?? defaultGitRunner();
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
