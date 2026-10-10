# Workspace Branch Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent declared in a fleet edits a local git checkout the operator already has, and deliver pushes a new branch to that checkout's existing remote.

**Architecture:** `Agent.spec.workspace` names the checkout. `prepareWorkspace` checks the runtime and the repo, then adds a worktree on `ropex/<task-id>` before the sandbox starts. The existing compose → plan → execute → deliver → learn spine runs in that worktree. `publishWorkspace` commits a dirty tree and pushes. Cleanup always removes the worktree directory and deletes the local branch only when the run did not decide to keep it. GitHub, `gh`, fetch, and credential injection are out of this slice.

**Tech Stack:** TypeScript, Vitest, Node.js `git` CLI through an injected runner, existing Hermes + worker runtime spine.

## Global Constraints

- Checkout binding is `Agent.spec.workspace` (`path`, `remote`, `base`). One agent, one checkout.
- Tasks stay the unit of work. The prompt arrives through Task YAML, `ropex tasks submit`, or the API.
- The only new command is `ropex workspace check <agent>`.
- `path` is required when `workspace` is present. `remote` defaults to `origin`. `base` is optional.
- When `base` is omitted, use `git rev-parse --abbrev-ref HEAD`. If that output is `HEAD`, fail before creating a branch.
- Branch name is `ropex/<slug>`. `<slug>` replaces every character outside `[A-Za-z0-9._-]` with `-`, collapses repeats, trims leading and trailing `-`, and is truncated to 80 characters. An empty slug throws.
- Worktree path is `<control-plane-root>/.ropex/workspace/<agent>/<slug>`.
- `workspace` is not added to `agentImagePayload`.
- Prepare order: runtime, path is a git checkout, remote URL, base resolves locally, branch name is free. No fetch. Any failure creates no branch.
- Embedded `dsh` passes. Live `dsh` passes only when `resolveDshBin()` returns a path, and it fails when the sandbox provider is `docker`. CLI runtimes pass only when `prepareRuntimeAuth` succeeds and `resolveRuntimeBin` exists on disk.
- The runtime may commit on the task branch. It must not push, switch branches, or change remotes.
- Commit identity is `Ropex <ropex@localhost>`. Commit message is exactly `ropex: <task-id>`. Stage with `git add -A`. No `git add --force`. `commit.gpgsign=false`.
- Ahead means `git rev-list --count <base>..HEAD` is greater than zero. Push is `git push -u <remote> <branch>` with no `--force` and no `--force-with-lease`.
- A publish failure that keeps the branch is terminal: the queue must not retry it.
- Tests stay free of network, API keys, and real coding CLIs except one local bare-repo git test.
- Do not add a `gh` or GitHub adapter.

---

### Task 1: Workspace spec and image exclusion

**Files:**
- Modify: `src/types.ts`
- Modify: `src/spec.ts`
- Test: `tests/workspace-spec.test.ts`

**Interfaces:**
- Consumes: `AgentSpec`, `normalizeAgentSpec`, `cloneAgentSpec`, `agentImagePayload`, `expandDesired`, `parseManifests`
- Produces:
  - `WorkspaceSpec = { path: string; remote?: string; base?: string }`
  - `AgentSpec.workspace?: WorkspaceSpec`
  - `RunResult.workspaceResult?: { branch: string; commit?: string; remote: string; pushed: boolean }`
  - `RunResult.workspaceError?: string`
  - `TaskManifest.spec.result` gains optional `branch`, `commit`, `remote`
  - After `expandDesired`, a workspace `remote` is `"origin"` when omitted

- [ ] **Step 1: Write the failing test**

Create `tests/workspace-spec.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { agentImagePayload } from "../src/image.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";

const agentYaml = (workspace: string) => `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  replicas: 1
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: shared
    learning: false
    skills: []
  workspace:
${workspace}
`;

describe("workspace spec", () => {
  it("requires workspace.path", () => {
    expect(() => parseManifests(agentYaml("    remote: origin"))).toThrow(/workspace\.path is required/);
  });

  it("defaults remote to origin", () => {
    const agent = expandDesired(parseManifests(agentYaml("    path: /tmp/app")))[0];
    expect(agent.spec.workspace).toEqual({ path: "/tmp/app", remote: "origin" });
  });

  it("keeps an explicit remote and base", () => {
    const agent = expandDesired(
      parseManifests(agentYaml("    path: /tmp/app\n    remote: upstream\n    base: develop")),
    )[0];
    expect(agent.spec.workspace).toEqual({ path: "/tmp/app", remote: "upstream", base: "develop" });
  });

  it("copies workspace from a fleet template", () => {
    const fleet = `
apiVersion: ropex.dev/v1
kind: Fleet
metadata:
  name: builders
spec:
  scale: onDemand
  maxConcurrent: 1
  replicas: 1
  template:
    spec:
      harness:
        profile: minimal
        plugins: []
      hermes:
        memory: shared
        learning: false
        skills: []
      workspace:
        path: /tmp/app
        remote: upstream
`;
    const agent = expandDesired(parseManifests(fleet))[0];
    expect(agent.spec.workspace).toEqual({ path: "/tmp/app", remote: "upstream" });
  });

  it("leaves the image payload unchanged when only workspace differs", () => {
    const withPath = expandDesired(parseManifests(agentYaml("    path: /tmp/one")))[0];
    const otherPath = expandDesired(parseManifests(agentYaml("    path: /tmp/two\n    base: dev")))[0];
    expect(agentImagePayload(withPath, "")).toBe(agentImagePayload(otherPath, ""));
    const bare = expandDesired(
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  replicas: 1
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: shared
    learning: false
    skills: []
`),
    )[0];
    expect(agentImagePayload(bare, "")).toBe(agentImagePayload(withPath, ""));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/workspace-spec.test.ts`

Expected: FAIL. `parseManifests` does not throw for a missing path, and `workspace` is undefined.

- [ ] **Step 3: Write the minimal implementation**

In `src/types.ts`, add the type next to `AgentSpec` and the fields below.

```ts
export type WorkspaceSpec = {
  /** Existing local git checkout. */
  path: string;
  /** Remote to push to. Default `origin`. */
  remote?: string;
  /** Branch new work is cut from. Default: the checkout's current branch. */
  base?: string;
};
```

On `AgentSpec`:

```ts
  /** Local checkout this agent edits. Omitted from the image digest. */
  workspace?: WorkspaceSpec;
```

On `TaskManifest.spec.result`:

```ts
      branch?: string;
      commit?: string;
      remote?: string;
```

On `RunResult`:

```ts
  /** Set when this run prepared a workspace branch. */
  workspaceResult?: {
    branch: string;
    commit?: string;
    remote: string;
    pushed: boolean;
  };
  /** Set when the spine finished but the workspace result must fail the task. */
  workspaceError?: string;
```

In `validateAgentSpec` in `src/spec.ts`, after the runtime checks:

```ts
  const workspace = spec?.workspace as { path?: unknown } | undefined;
  if (workspace !== undefined) {
    if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) {
      throw new Error(`${where}: workspace must be an object`);
    }
    if (typeof workspace.path !== "string" || !workspace.path.trim()) {
      throw new Error(`${where}: workspace.path is required`);
    }
  }
```

`parseManifests` must pass a `where` string into `validateAgentSpec`. Use the existing `where` argument. If the function currently returns before workspace can be seen, add the block before the function returns.

In `normalizeAgentSpec`, before the scale return, copy and default the workspace:

```ts
function withWorkspace(spec: AgentSpec): AgentSpec {
  if (!spec.workspace) return spec;
  const remote = spec.workspace.remote?.trim() || "origin";
  const base = spec.workspace.base?.trim() || undefined;
  return {
    ...spec,
    workspace: { path: spec.workspace.path.trim(), remote, ...(base ? { base } : {}) },
  };
}
```

Call `withWorkspace(spec)` at the start of `normalizeAgentSpec` and use that result for the rest of the function.

In `cloneAgentSpec`, add:

```ts
    workspace: tpl.workspace ? { ...tpl.workspace } : undefined,
```

Do not add `workspace` to `agentImagePayload`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/workspace-spec.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/spec.ts tests/workspace-spec.test.ts
git commit -m "feat(spec): declare an agent workspace outside the image digest"
```

---

### Task 2: Prepare the checkout

**Files:**
- Create: `src/workspace.ts`
- Test: `tests/workspace-prepare.test.ts`

**Interfaces:**
- Consumes: `DesiredAgent`, `resolveRuntimeKind`, `prepareRuntimeAuth`, `resolveRuntimeBin`, `cliRuntime`, `resolveDshBackend`, `resolveDshBin`, `sandboxProvider`, `binOnPath`
- Produces:

```ts
export type GitRunResult = { code: number; stdout: string; stderr: string };
export type GitRunner = (
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => GitRunResult;

export function workspaceSlug(taskId: string): string;
export function workspaceBranch(taskId: string): string;

export type PreparedWorkspace = {
  checkout: string;
  worktree: string;
  branch: string;
  base: string;
  remote: string;
  agent: string;
};

export class WorkspaceError extends Error {}

export function assertWorkspaceRuntime(
  agent: DesiredAgent,
  opts?: {
    env?: NodeJS.ProcessEnv;
    binExists?: (file: string) => boolean;
    fileExists?: (file: string) => boolean;
    homedir?: () => string;
  },
): void;

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
}): PreparedWorkspace;

export function sandboxSpecForWorkspace<T extends { provider?: string; repo?: unknown; lifecycle?: { warmSnapshot?: boolean } }>(
  spec: T | undefined,
  prepared: boolean,
): T | undefined;
```

- [ ] **Step 1: Write the failing test**

Create `tests/workspace-prepare.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { expandDesired, parseManifests } from "../src/spec.ts";
import type { DesiredAgent } from "../src/types.ts";
import {
  prepareWorkspace,
  sandboxSpecForWorkspace,
  workspaceBranch,
  workspaceSlug,
  type GitRunner,
} from "../src/workspace.ts";

function agent(extra = ""): DesiredAgent {
  return expandDesired(
    parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  replicas: 1
  runtime:
    kind: dsh
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: shared
    learning: false
    skills: []
  workspace:
    path: /tmp/app
    remote: origin
    base: main
${extra}
`),
  )[0];
}

function scripted(map: Record<string, { code?: number; stdout?: string; stderr?: string }>): {
  git: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const git: GitRunner = (args) => {
    calls.push(args);
    const key = args.join(" ");
    const hit = map[key];
    if (!hit) return { code: 1, stdout: "", stderr: `unexpected ${key}` };
    return { code: hit.code ?? 0, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
  };
  return { git, calls };
}

const ok = {
  "rev-parse --is-inside-work-tree": { stdout: "true\n" },
  "remote get-url origin": { stdout: "https://example.test/app.git\n" },
  "rev-parse --verify main^{commit}": { stdout: "abc\n" },
  "show-ref --verify --quiet refs/heads/ropex/greeting": { code: 1 },
  "worktree add -b ropex/greeting /ctrl/.ropex/workspace/builder/greeting main": { stdout: "" },
};

describe("prepareWorkspace", () => {
  it("slug-formats the branch", () => {
    expect(workspaceSlug("Issue: 12")).toBe("Issue-12");
    expect(workspaceBranch("Issue: 12")).toBe("ropex/Issue-12");
    expect(workspaceSlug("a".repeat(90))).toHaveLength(80);
    expect(() => workspaceSlug("///")).toThrow(/empty branch slug/);
  });

  it("creates the worktree after the checks pass", () => {
    const fake = scripted(ok);
    const prepared = prepareWorkspace({
      root: "/ctrl",
      agent: agent(),
      taskId: "greeting",
      git: fake.git,
      fileExists: () => true,
      binExists: () => true,
    });
    expect(prepared).toMatchObject({
      checkout: "/tmp/app",
      worktree: "/ctrl/.ropex/workspace/builder/greeting",
      branch: "ropex/greeting",
      base: "main",
      remote: "origin",
      agent: "builder",
    });
    expect(fake.calls.some((args) => args[0] === "worktree")).toBe(true);
  });

  it("does not create a branch on dry run", () => {
    const fake = scripted(ok);
    prepareWorkspace({
      root: "/ctrl",
      agent: agent(),
      taskId: "greeting",
      dryRun: true,
      git: fake.git,
      fileExists: () => true,
    });
    expect(fake.calls.some((args) => args[0] === "worktree")).toBe(false);
  });

  it.each([
    ["rev-parse --is-inside-work-tree", { code: 1 }, /not a git checkout/],
    ["remote get-url origin", { code: 1 }, /remote origin is missing/],
    ["rev-parse --verify main^{commit}", { code: 1 }, /base main does not exist/],
    ["show-ref --verify --quiet refs/heads/ropex/greeting", { code: 0 }, /branch ropex\/greeting already exists/],
  ] as const)("stops before worktree add when %s fails", (key, result, message) => {
    const fake = scripted({ ...ok, [key]: result });
    expect(() =>
      prepareWorkspace({
        root: "/ctrl",
        agent: agent(),
        taskId: "greeting",
        git: fake.git,
        fileExists: () => true,
      }),
    ).toThrow(message);
    expect(fake.calls.some((args) => args[0] === "worktree")).toBe(false);
  });

  it("rejects a missing checkout path before git", () => {
    const fake = scripted(ok);
    expect(() =>
      prepareWorkspace({
        root: "/ctrl",
        agent: agent(),
        taskId: "greeting",
        git: fake.git,
        fileExists: () => false,
      }),
    ).toThrow(/not a git checkout: \/tmp\/app/);
    expect(fake.calls).toEqual([]);
  });

  it("rejects a detached HEAD when base is omitted", () => {
    const yamlAgent = agent();
    delete yamlAgent.spec.workspace!.base;
    const fake = scripted({
      "rev-parse --is-inside-work-tree": { stdout: "true\n" },
      "remote get-url origin": { stdout: "ok\n" },
      "rev-parse --abbrev-ref HEAD": { stdout: "HEAD\n" },
    });
    expect(() =>
      prepareWorkspace({
        root: "/ctrl",
        agent: yamlAgent,
        taskId: "greeting",
        git: fake.git,
        fileExists: () => true,
      }),
    ).toThrow(/detached HEAD and workspace.base is unset/);
    expect(fake.calls.some((args) => args[0] === "worktree")).toBe(false);
  });

  it("rejects live dsh in a docker sandbox before git", () => {
    const previous = process.env.ROPEX_DSH_BACKEND;
    process.env.ROPEX_DSH_BACKEND = "live";
    try {
      const docker = agent("  sandbox:\n    provider: docker\n");
      const fake = scripted(ok);
      expect(() =>
        prepareWorkspace({
          root: "/ctrl",
          agent: docker,
          taskId: "greeting",
          git: fake.git,
          fileExists: () => true,
        }),
      ).toThrow(/live dsh cannot run in a docker sandbox/);
      expect(fake.calls).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.ROPEX_DSH_BACKEND;
      else process.env.ROPEX_DSH_BACKEND = previous;
    }
  });

  it("fails a missing CLI binary before git", () => {
    const cli = expandDesired(
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  replicas: 1
  runtime:
    kind: codex
    auth: api-key
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: shared
    learning: false
    skills: []
  workspace:
    path: /tmp/app
`),
    )[0];
    const fake = scripted(ok);
    expect(() =>
      prepareWorkspace({
        root: "/ctrl",
        agent: cli,
        taskId: "greeting",
        git: fake.git,
        fileExists: () => true,
        binExists: () => false,
        env: { ...process.env, OPENAI_API_KEY: "test-key" },
      }),
    ).toThrow(/runtime codex binary not found/);
    expect(fake.calls).toEqual([]);
  });

  it("forces a docker sandbox to mount the prepared worktree", () => {
    const spec = sandboxSpecForWorkspace(
      {
        provider: "docker" as const,
        repo: { url: "https://example.test/other.git", workspace: "clone" as const },
        lifecycle: { warmSnapshot: true },
      },
      true,
    );
    expect(spec).toEqual({
      provider: "docker",
      repo: { workspace: "mount" },
      lifecycle: { warmSnapshot: false },
    });
    expect(sandboxSpecForWorkspace({ provider: "local" }, true)).toEqual({ provider: "local" });
    expect(sandboxSpecForWorkspace({ provider: "docker", repo: { url: "https://example.test/a.git" } }, false)).toEqual({
      provider: "docker",
      repo: { url: "https://example.test/a.git" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/workspace-prepare.test.ts`

Expected: FAIL with cannot find module `../src/workspace.ts`

- [ ] **Step 3: Write the minimal implementation**

Create `src/workspace.ts` with the functions below. `prepareWorkspace` calls `assertWorkspaceRuntime` before any git command.

```ts
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
```

Replace the inline throwing default git runner with a real one only in Task 3. Task 2 tests always pass `git`.

`resolveDshBackend()` reads `process.env.ROPEX_DSH_BACKEND`. Codex `auth: api-key` matches `CODEX_API_KEY.method` in `src/cli-runtimes/codex.ts`. The binary test passes `OPENAI_API_KEY` so `prepareRuntimeAuth` succeeds before the missing-binary check.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/workspace-prepare.test.ts tests/workspace-spec.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/workspace.ts tests/workspace-prepare.test.ts
git commit -m "feat(workspace): prepare a branch worktree after runtime and git checks"
```

---

### Task 3: Publish and cleanup

**Files:**
- Modify: `src/workspace.ts`
- Test: `tests/workspace-publish.test.ts`

**Interfaces:**
- Consumes: `PreparedWorkspace`, `GitRunner`, `WorkspaceError`
- Produces:

```ts
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
}): PublishWorkspaceOutcome;

export function cleanupWorkspace(
  prepared: PreparedWorkspace,
  opts: { deleteBranch: boolean; git?: GitRunner },
): void;

export function defaultGitRunner(): GitRunner;
```

- [ ] **Step 1: Write the failing test**

Create `tests/workspace-publish.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  cleanupWorkspace,
  publishWorkspace,
  type GitRunner,
  type PreparedWorkspace,
} from "../src/workspace.ts";

const prepared: PreparedWorkspace = {
  checkout: "/tmp/app",
  worktree: "/ctrl/.ropex/workspace/builder/greeting",
  branch: "ropex/greeting",
  base: "main",
  remote: "origin",
  agent: "builder",
};

function scripted(map: Record<string, { code?: number; stdout?: string; stderr?: string }>): {
  git: GitRunner;
  calls: Array<{ args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }>;
} {
  const calls: Array<{ args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
  const git: GitRunner = (args, opts) => {
    calls.push({ args, cwd: opts?.cwd, env: opts?.env });
    const hit = map[args.join(" ")];
    if (!hit) return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    return { code: hit.code ?? 0, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
  };
  return { git, calls };
}

const clean = {
  "rev-parse --abbrev-ref HEAD": { stdout: "ropex/greeting\n" },
  "status --porcelain": { stdout: "" },
  "rev-list --count main..HEAD": { stdout: "0\n" },
};

describe("publishWorkspace", () => {
  it("commits a dirty tree and pushes without force", () => {
    const fake = scripted({
      "rev-parse --abbrev-ref HEAD": { stdout: "ropex/greeting\n" },
      "status --porcelain": { stdout: " M src/hello.ts\n" },
      "add -A": { stdout: "" },
      "-c commit.gpgsign=false commit -m ropex: greeting": { stdout: "" },
      "rev-list --count main..HEAD": { stdout: "1\n" },
      "rev-parse HEAD": { stdout: "deadbeef\n" },
      "push -u origin ropex/greeting": { stdout: "" },
    });
    const outcome = publishWorkspace({ prepared, taskId: "greeting", git: fake.git });
    expect(outcome.keepBranch).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toEqual({
      branch: "ropex/greeting",
      commit: "deadbeef",
      remote: "origin",
      pushed: true,
    });
    const commit = fake.calls.find((call) => call.args.includes("commit"));
    expect(commit?.cwd).toBe(prepared.worktree);
    expect(commit?.env).toMatchObject({
      GIT_AUTHOR_NAME: "Ropex",
      GIT_AUTHOR_EMAIL: "ropex@localhost",
      GIT_COMMITTER_NAME: "Ropex",
      GIT_COMMITTER_EMAIL: "ropex@localhost",
    });
    expect(fake.calls.some((call) => call.args.includes("--force") || call.args.includes("--force-with-lease"))).toBe(
      false,
    );
  });

  it("pushes an existing commit without a second commit", () => {
    const fake = scripted({
      "rev-parse --abbrev-ref HEAD": { stdout: "ropex/greeting\n" },
      "status --porcelain": { stdout: "" },
      "rev-list --count main..HEAD": { stdout: "1\n" },
      "rev-parse HEAD": { stdout: "abc\n" },
      "push -u origin ropex/greeting": { stdout: "" },
    });
    const outcome = publishWorkspace({ prepared, taskId: "greeting", git: fake.git });
    expect(outcome.result?.pushed).toBe(true);
    expect(fake.calls.some((call) => call.args.includes("commit"))).toBe(false);
  });

  it("fails a clean tree that is not ahead and does not keep the branch", () => {
    const fake = scripted(clean);
    const outcome = publishWorkspace({ prepared, taskId: "greeting", git: fake.git });
    expect(outcome).toEqual({ error: "no changes on ropex/greeting", keepBranch: false });
    expect(fake.calls.some((call) => call.args[0] === "push")).toBe(false);
  });

  it("keeps the branch when commit fails", () => {
    const fake = scripted({
      "rev-parse --abbrev-ref HEAD": { stdout: "ropex/greeting\n" },
      "status --porcelain": { stdout: " M a.ts\n" },
      "add -A": { stdout: "" },
      "-c commit.gpgsign=false commit -m ropex: greeting": { code: 1, stderr: "commit failed\n" },
    });
    const outcome = publishWorkspace({ prepared, taskId: "greeting", git: fake.git });
    expect(outcome.keepBranch).toBe(true);
    expect(outcome.error).toBe("commit failed");
    expect(outcome.result).toEqual({ branch: "ropex/greeting", remote: "origin", pushed: false });
  });

  it("keeps the branch when push fails", () => {
    const fake = scripted({
      "rev-parse --abbrev-ref HEAD": { stdout: "ropex/greeting\n" },
      "status --porcelain": { stdout: "" },
      "rev-list --count main..HEAD": { stdout: "2\n" },
      "rev-parse HEAD": { stdout: "abc\n" },
      "push -u origin ropex/greeting": { code: 1, stderr: "rejected\n" },
    });
    const outcome = publishWorkspace({ prepared, taskId: "greeting", git: fake.git });
    expect(outcome.keepBranch).toBe(true);
    expect(outcome.error).toBe("rejected");
    expect(outcome.result).toEqual({
      branch: "ropex/greeting",
      commit: "abc",
      remote: "origin",
      pushed: false,
    });
  });

  it("does not commit or push when HEAD is another branch", () => {
    const fake = scripted({
      "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
    });
    const outcome = publishWorkspace({ prepared, taskId: "greeting", git: fake.git });
    expect(outcome.keepBranch).toBe(true);
    expect(outcome.error).toBe("refusing to publish: HEAD is main, expected ropex/greeting");
    expect(outcome.result).toEqual({ branch: "ropex/greeting", remote: "origin", pushed: false });
    expect(fake.calls).toHaveLength(1);
  });
});

describe("cleanupWorkspace", () => {
  it("removes the worktree and deletes the branch when asked", () => {
    const fake = scripted({
      "worktree remove --force /ctrl/.ropex/workspace/builder/greeting": { stdout: "" },
      "branch -D ropex/greeting": { stdout: "" },
    });
    cleanupWorkspace(prepared, { deleteBranch: true, git: fake.git });
    expect(fake.calls.map((call) => call.args[0])).toEqual(["worktree", "branch"]);
    expect(fake.calls.every((call) => call.cwd === prepared.checkout)).toBe(true);
  });

  it("keeps the branch when deleteBranch is false", () => {
    const fake = scripted({
      "worktree remove --force /ctrl/.ropex/workspace/builder/greeting": { stdout: "" },
    });
    cleanupWorkspace(prepared, { deleteBranch: false, git: fake.git });
    expect(fake.calls.some((call) => call.args[0] === "branch")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/workspace-publish.test.ts`

Expected: FAIL because `publishWorkspace` is not exported.

- [ ] **Step 3: Write the minimal implementation**

Add to `src/workspace.ts`:

```ts
import { rmSync } from "node:fs";
import { runProcessSync } from "./proc.js";

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
```

Change `prepareWorkspace` so `const git = opts.git ?? defaultGitRunner()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/workspace-publish.test.ts tests/workspace-prepare.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/workspace.ts tests/workspace-publish.test.ts
git commit -m "feat(workspace): commit a dirty tree and push the task branch"
```

---

### Task 4: Brief rules

**Files:**
- Modify: `src/brief.ts`
- Test: `tests/brief-workspace.test.ts`

**Interfaces:**
- Consumes: `composeBrief`, `ComposeBriefOptions`
- Produces: `ComposeBriefOptions.workspace?: { branch: string; base: string }`. When set, the Working directory section contains the three sentences below and does not contain the old sentence `You are already in the worker worktree.`

- [ ] **Step 1: Write the failing test**

Create `tests/brief-workspace.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { composeBrief } from "../src/brief.ts";
import type { HermesContract } from "../src/contracts.ts";
import type { AgentWorkflow } from "../src/workflow.ts";

const workflow = { brain: { soul: "builder", skills: [] } } as AgentWorkflow;
const hermes = { port: { query: () => [] } } as unknown as HermesContract;
const task = { id: "greeting", agent: "builder", prompt: "add a greeting" };
const plan = { thoughts: [], calls: [] };

describe("composeBrief workspace", () => {
  it("tells the runtime it may commit and must not push", () => {
    const brief = composeBrief(workflow, hermes, task, plan, {
      workspace: { branch: "ropex/greeting", base: "main" },
    });
    expect(brief).toContain("You are on branch ropex/greeting, cut from main.");
    expect(brief).toContain("You may commit on this branch.");
    expect(brief).toContain("You must not push, switch branches, or change remotes.");
    expect(brief).not.toContain("You are already in the worker worktree.");
  });

  it("keeps the current working-directory text when no workspace is set", () => {
    const brief = composeBrief(workflow, hermes, task, plan);
    expect(brief).toContain("You are already in the worker worktree.");
    expect(brief).not.toContain("You may commit on this branch.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/brief-workspace.test.ts`

Expected: FAIL. `composeBrief` does not accept `workspace`, or the text is missing.

- [ ] **Step 3: Write the minimal implementation**

In `src/brief.ts`, extend `ComposeBriefOptions`:

```ts
export type ComposeBriefOptions = {
  maxFacts?: number;
  workspace?: { branch: string; base: string };
};
```

Replace the Working directory section body with a choice:

```ts
    section(
      "Working directory",
      opts.workspace
        ? [
            `You are on branch ${opts.workspace.branch}, cut from ${opts.workspace.base}.`,
            "You may commit on this branch.",
            "You must not push, switch branches, or change remotes.",
          ].join(" ")
        : [
            "You are already in the worker worktree. Act here; do not clone or switch repositories.",
            "Carry out the intended actions in order. Each one is a tool call: a name and its input.",
            "When the input has argv, run that command. When it has path and content, write that file.",
            "Every other call is yours to perform with the tools you have.",
          ].join(" "),
    ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/brief-workspace.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/brief.ts tests/brief-workspace.test.ts
git commit -m "feat(brief): tell a workspace runtime the branch rules"
```

---

### Task 5: Terminal queue failure and git writeback

**Files:**
- Modify: `src/queue.ts` (`CompleteQueuedOptions`, `completeQueued`)
- Modify: `src/tasks.ts` (`writeTaskManifestDelivery`, `deliverGitTaskManifest`, `deliverGitTaskFromQueueItem`)
- Modify: `src/connectors.ts` (`DeliverOutcome`, `deliverTaskOutcome`)
- Test: `tests/workspace-delivery.test.ts`

**Interfaces:**
- Consumes: `WorkspaceResult` from `src/workspace.ts`, `QueuedTask`, `deliverGitTaskManifest`
- Produces:
  - `CompleteQueuedOptions.terminal?: boolean`. When `ok` is false and `terminal` is true, status becomes `dead` on the first failure. No `pending` retry.
  - `deliverGitTaskManifest` writes `spec.result.branch`, `spec.result.commit`, `spec.result.remote`, and `spec.result.error`
  - `DeliverOutcome.workspace?: WorkspaceResult` and `DeliverOutcome.error?: string`

- [ ] **Step 1: Write the failing test**

Create `tests/workspace-delivery.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deliverTaskOutcome } from "../src/connectors.ts";
import { emptyState } from "../src/controller.ts";
import { completeQueued, enqueueTask } from "../src/queue.ts";
import { deliverGitTaskManifest } from "../src/tasks.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workspace delivery", () => {
  it("dead-letters a terminal failure without retry", () => {
    const state = emptyState();
    const queued = enqueueTask(state, { id: "greeting", agent: "builder", prompt: "add greeting" }, "cli");
    queued.status = "claimed";
    queued.attempts = 1;
    const updated = completeQueued(state, queued.id, false, "rejected", { terminal: true });
    expect(updated?.status).toBe("dead");
    expect(updated?.error).toBe("rejected");
    expect(state.queue.some((item) => item.status === "pending")).toBe(false);
  });

  it("writes branch, commit, and remote onto a git task file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ropex-task-"));
    temps.push(dir);
    const manifestPath = join(dir, "greeting.yaml");
    writeFileSync(
      manifestPath,
      `apiVersion: ropex.dev/v1
kind: Task
metadata:
  name: greeting
spec:
  agent: builder
  prompt: add a greeting
  status: pending
  delivery:
    mode: git
`,
    );
    deliverGitTaskManifest(
      { id: "greeting", agent: "builder", prompt: "add a greeting", manifestPath, delivery: { mode: "git" } },
      {
        ok: true,
        output: "done",
        workerId: "builder-0",
        workspace: { branch: "ropex/greeting", commit: "abc", remote: "origin", pushed: true },
      },
    );
    const text = readFileSync(manifestPath, "utf8");
    expect(text).toContain("status: done");
    expect(text).toContain("branch: ropex/greeting");
    expect(text).toContain("commit: abc");
    expect(text).toContain("remote: origin");
  });

  it("writes the publish error when the queue item is dead", () => {
    const dir = mkdtempSync(join(tmpdir(), "ropex-task-"));
    temps.push(dir);
    const manifestPath = join(dir, "greeting.yaml");
    writeFileSync(
      manifestPath,
      `apiVersion: ropex.dev/v1
kind: Task
metadata:
  name: greeting
spec:
  agent: builder
  prompt: add a greeting
  delivery:
    mode: git
`,
    );
    const state = emptyState();
    const queued = enqueueTask(
      state,
      { id: "greeting", agent: "builder", prompt: "add a greeting", manifestPath, delivery: { mode: "git" } },
      "git",
    );
    queued.status = "claimed";
    queued.attempts = 1;
    const updated = completeQueued(state, queued.id, false, "rejected", { terminal: true });
    deliverTaskOutcome(state, updated!, {
      output: "failed",
      error: "rejected",
      workspace: { branch: "ropex/greeting", commit: "abc", remote: "origin", pushed: false },
    });
    const text = readFileSync(manifestPath, "utf8");
    expect(text).toContain("status: failed");
    expect(text).toContain("error: rejected");
    expect(text).toContain("branch: ropex/greeting");
    expect(text).toContain("remote: origin");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/workspace-delivery.test.ts`

Expected: FAIL. `completeQueued` ignores `terminal`, and the manifest has no `branch`.

- [ ] **Step 3: Write the minimal implementation**

Add `terminal?: boolean` to `CompleteQueuedOptions`.

In `completeQueued`, change the retry condition from:

```ts
  if (item.attempts > 0 && item.attempts < maxAttempts) {
```

to:

```ts
  if (!opts.terminal && item.attempts > 0 && item.attempts < maxAttempts) {
```

Extend `writeTaskManifestDelivery` and `deliverGitTaskManifest` outcomes with:

```ts
    workspace?: {
      branch: string;
      commit?: string;
      remote: string;
      pushed: boolean;
    };
```

When building the `result` object written to the file:

```ts
  spec.set("result", {
    output: outcome.output?.slice(0, 2000),
    workerId: outcome.workerId,
    completedAt: new Date().toISOString(),
    error: outcome.error,
    ...(outcome.workspace
      ? {
          branch: outcome.workspace.branch,
          commit: outcome.workspace.commit,
          remote: outcome.workspace.remote,
        }
      : {}),
  });
```

`deliverGitTaskFromQueueItem` takes an optional third argument, or replaces `output?: string` with an object. Use an object so the workspace is not dropped:

```ts
export function deliverGitTaskFromQueueItem(
  item: QueuedTask,
  outcome: {
    output?: string;
    workspace?: { branch: string; commit?: string; remote: string; pushed: boolean };
  } = {},
): boolean {
  if (!item.task.manifestPath) return false;
  if (item.status === "done") {
    deliverGitTaskManifest(item.task, {
      ok: true,
      output: outcome.output,
      workerId: item.workerId,
      workspace: outcome.workspace,
    });
    return true;
  }
  if (item.status === "dead") {
    deliverGitTaskManifest(item.task, {
      ok: false,
      output: outcome.output,
      workerId: item.workerId,
      error: item.error,
      workspace: outcome.workspace,
    });
    return true;
  }
  return false;
}
```

Update the previous call sites of `deliverGitTaskFromQueueItem(item, output)` to `deliverGitTaskFromQueueItem(item, { output })`.

On `DeliverOutcome`:

```ts
  error?: string;
  workspace?: { branch: string; commit?: string; remote: string; pushed: boolean };
```

In the git branch of `deliverTaskOutcome`:

```ts
      deliverGitTaskFromQueueItem(item, { output: outcome.output, workspace: outcome.workspace });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/workspace-delivery.test.ts tests/native-tasks.test.ts`

Expected: PASS. The only existing caller is `deliverGitTaskFromQueueItem(item, outcome.output)` in `src/connectors.ts`. It must become `deliverGitTaskFromQueueItem(item, { output: outcome.output, workspace: outcome.workspace })`.

- [ ] **Step 5: Commit**

```bash
git add src/queue.ts src/tasks.ts src/connectors.ts tests/workspace-delivery.test.ts
git commit -m "feat(delivery): record a workspace branch and fail it without retry"
```

---

### Task 6: Run the spine in the workspace

**Files:**
- Modify: `src/runtime.ts`
- Modify: `src/scheduler.ts`
- Test: `tests/workspace-run.test.ts`

**Interfaces:**
- Consumes: `prepareWorkspace`, `publishWorkspace`, `cleanupWorkspace`, `sandboxSpecForWorkspace`, `composeBrief` `workspace` option, `CompleteQueuedOptions.terminal`, `DeliverOutcome.workspace`
- Produces: `RunTaskOptions.git?: GitRunner`. `runTask` sets `worker.worktree` to the prepared worktree, passes `sandboxSpecForWorkspace` into `acquireSandbox`, calls `publishWorkspace` at the start of deliver, passes the branch into `composeBrief`, and always cleans up in `finally`. Delete the local branch only when publish did not set `keepBranch`. `workspaceError` makes `drainQueue` call `completeQueued` with `terminal: true` and passes `workspace` into `deliverTaskOutcome`.

- [ ] **Step 1: Write the failing test**

Create `tests/workspace-run.test.ts`. The no-workspace case uses the same embedded run shape as `tests/harness-commit.test.ts`.

```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyState } from "../src/controller.ts";
import { expandWorkers, runTask } from "../src/runtime.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import type { GitRunner } from "../src/workspace.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.ROPEX_LLM;
  delete process.env.ROPEX_IN_SESSION;
});
beforeEach(() => {
  process.env.ROPEX_LLM = "embedded";
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ropex-ws-"));
  temps.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Dev"], { cwd: dir });
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "hello.ts"), "export const hi = 1;\n");
  execFileSync("git", ["add", "src/hello.ts"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

describe("runTask workspace", () => {
  it("does not call the git runner when the agent has no workspace", async () => {
    const repo = initRepo();
    const desired = expandDesired(
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: none
    learning: false
    skills: []
`),
    );
    const worker = expandWorkers(desired[0])[0];
    worker.status = "running";
    const state = emptyState();
    state.desired = desired;
    state.workers = [worker];
    let calls = 0;
    const git: GitRunner = () => {
      calls += 1;
      return { code: 0, stdout: "", stderr: "" };
    };
    await runTask(state, worker, { id: "look", agent: "builder", prompt: "look around" }, {
      worktreeRoot: repo,
      git,
    });
    expect(calls).toBe(0);
  });

  it("fails a clean workspace run, deletes the branch, and still learns", async () => {
    const repo = initRepo();
    const root = mkdtempSync(join(tmpdir(), "ropex-ctrl-"));
    temps.push(root);
    const desired = expandDesired(
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  runtime:
    kind: dsh
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: none
    learning: false
    skills: []
  workspace:
    path: ${repo}
    remote: origin
    base: main
`),
    );
    const worker = expandWorkers(desired[0])[0];
    worker.status = "running";
    const state = emptyState();
    state.desired = desired;
    state.workers = [worker];
    execFileSync("git", ["init", "--bare", join(root, "bare")]);
    execFileSync("git", ["remote", "add", "origin", join(root, "bare")], { cwd: repo });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo });
    const result = await runTask(
      state,
      worker,
      { id: "look", agent: "builder", prompt: "look around" },
      { root },
    );
    expect(result.workspaceError).toBe("no changes on ropex/look");
    expect(result.workspaceResult).toBeUndefined();
    expect(git(repo, ["branch", "--list", "ropex/look"])).toBe("");
  });

  it("deletes the branch when the sandbox is refused after prepare", async () => {
    process.env.ROPEX_IN_SESSION = "1";
    const repo = initRepo();
    const root = mkdtempSync(join(tmpdir(), "ropex-ctrl-"));
    temps.push(root);
    const bare = join(root, "bare");
    execFileSync("git", ["init", "--bare", bare]);
    execFileSync("git", ["remote", "add", "origin", bare], { cwd: repo });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo });
    const desired = expandDesired(
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  runtime:
    kind: dsh
  sandbox:
    provider: docker
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: none
    learning: false
    skills: []
  workspace:
    path: ${repo}
    remote: origin
    base: main
`),
    );
    const worker = expandWorkers(desired[0])[0];
    worker.status = "running";
    const state = emptyState();
    state.desired = desired;
    state.workers = [worker];
    await expect(
      runTask(state, worker, { id: "look", agent: "builder", prompt: "look around" }, { root }),
    ).rejects.toThrow(/ROPEX_IN_SESSION/);
    expect(git(repo, ["branch", "--list", "ropex/look"])).toBe("");
    expect(() => git(bare, ["rev-parse", "--verify", "refs/heads/ropex/look"])).toThrow();
  });
});
```

The prompt `look around` has no fenced file blocks and does not match `/test|fix|implement/i`, so `planCalls` emits one `fs` read and the worktree stays clean.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/workspace-run.test.ts`

Expected: FAIL. `RunTaskOptions` has no `git`, and the workspace run does not set `workspaceError`.

- [ ] **Step 3: Write the minimal implementation**

Add to `RunTaskOptions` in `src/runtime.ts`:

```ts
  git?: GitRunner;
```

Import `GitRunner`, `cleanupWorkspace`, `prepareWorkspace`, `publishWorkspace`, `sandboxSpecForWorkspace`, and `PreparedWorkspace` from `./workspace.ts`.

Restructure `runTask` so prepare happens before `acquireSandbox`, and cleanup happens in `finally`:

```ts
  const root = opts.worktreeRoot ?? opts.root ?? process.cwd();
  let prepared: PreparedWorkspace | undefined;
  const settlement = { published: false, keepBranch: false };
  let sandbox: Sandbox | undefined;
  try {
    if (agent.spec.workspace) {
      prepared = prepareWorkspace({
        root,
        agent,
        taskId: task.id,
        git: opts.git,
        fileExists: opts.authProbe?.fileExists,
        homedir: opts.authProbe?.homedir,
      });
      worker.worktree = prepared.worktree;
    }
    const container = sandboxProvider(agent.spec.sandbox) !== "local";
    const auth = prepareRuntimeAuth(agent.spec, {
      env: process.env,
      container,
      fileExists: opts.authProbe?.fileExists,
      homedir: opts.authProbe?.homedir,
    });
    sandbox = await acquireSandbox(sandboxSpecForWorkspace(agent.spec.sandbox, Boolean(prepared)), {
      root,
      worker,
      taskId: task.id,
      policies: state.policies,
      docker: opts.sandboxDocker,
      authMounts: auth?.mount ? [auth.mount] : undefined,
    });
    if (needsHostWorktree(sandboxSpecForWorkspace(agent.spec.sandbox, Boolean(prepared)))) {
      worker.worktree = sandbox.hostCwd;
    }
    return await executeTask(state, worker, task, { agent, workflow, root, sandbox, auth, prepared, settlement }, opts);
  } finally {
    if (sandbox) await releaseSandbox(state, worker, task, agent, sandbox);
    if (prepared) {
      cleanupWorkspace(prepared, {
        deleteBranch: !(settlement.published && settlement.keepBranch),
        git: opts.git,
      });
    }
  }
```

Remove the old `acquireSandbox` call and the old inner `try/finally` that only released the sandbox, so release happens once.

Extend `executeTask`'s `run` argument with `prepared?: PreparedWorkspace` and `settlement: { published: boolean; keepBranch: boolean }`.

Change the `composeBrief` call to:

```ts
  const brief = composeBrief(
    workflow,
    hermes,
    task,
    planned,
    run.prepared ? { workspace: { branch: run.prepared.branch, base: run.prepared.base } } : {},
  );
```

Immediately before the existing deliver journal block:

```ts
  let workspaceResult: RunResult["workspaceResult"];
  let workspaceError: string | undefined;
  if (run.prepared) {
    const outcome = publishWorkspace({ prepared: run.prepared, taskId: task.id, git: opts.git });
    run.settlement.published = true;
    run.settlement.keepBranch = outcome.keepBranch;
    workspaceResult = outcome.result;
    workspaceError = outcome.error;
  }
```

Add `workspaceResult` and `workspaceError` to the `result` object. Learn stays after this block. Do not throw on `workspaceError`.

`executeTask` needs `opts` so it can pass `opts.git`. It already receives `opts`.

In `src/scheduler.ts`, replace the success-only `completeQueued` call:

```ts
          const failed = Boolean(result.workspaceError);
          const updated = completeQueued(state, c.queueId, !failed, result.workspaceError, {
            maxAttempts: opts.maxAttempts,
            root: opts.root,
            terminal: failed,
          });
          if (updated)
            deliverTaskOutcome(state, updated, {
              output: result.output,
              delivery: result.delivery,
              worker: result.worker,
              imageDigest: result.imageDigest,
              workspace: result.workspaceResult,
              error: result.workspaceError,
            });
```

An execute throw still hits the existing `catch` and may retry. That is correct because `finally` already deleted the branch.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/workspace-run.test.ts tests/harness-commit.test.ts tests/workspace-publish.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runtime.ts src/scheduler.ts tests/workspace-run.test.ts
git commit -m "feat(runtime): run a task in the agent workspace and publish the branch"
```

---

### Task 7: Workspace check command

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/workspace-cli.test.ts`

**Interfaces:**
- Consumes: `prepareWorkspace` with `dryRun: true`, `loadState`
- Produces: `ropex workspace check <agent>` prints `workspace ok <path>` and exits 0, or prints the `WorkspaceError` message and exits 1. It does not call `worktree`.

- [ ] **Step 1: Write the failing test**

Create `tests/workspace-cli.test.ts`. Export the command handler if `main` is not exported. Prefer a small exported function over spawning the CLI:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceCheck } from "../src/cli.ts";
import { emptyState, saveState } from "../src/controller.ts";
import type { GitRunner } from "../src/workspace.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workspace check", () => {
  it("reports a dry-run success and does not add a worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-cli-"));
    temps.push(root);
    const state = emptyState();
    state.desired = [
      {
        apiVersion: "ropex.dev/v1",
        kind: "Agent",
        metadata: { name: "builder" },
        spec: {
          replicas: 1,
          harness: { profile: "minimal", plugins: [] },
          hermes: { memory: "shared", learning: false, skills: [] },
          workspace: { path: "/tmp/app", remote: "origin", base: "main" },
        },
      },
    ];
    saveState(root, state);
    const calls: string[][] = [];
    const git: GitRunner = (args) => {
      calls.push(args);
      const key = args.join(" ");
      if (key === "rev-parse --is-inside-work-tree") return { code: 0, stdout: "true\n", stderr: "" };
      if (key === "remote get-url origin") return { code: 0, stdout: "ok\n", stderr: "" };
      if (key === "rev-parse --verify main^{commit}") return { code: 0, stdout: "abc\n", stderr: "" };
      if (key.startsWith("show-ref")) return { code: 1, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: key };
    };
    const lines: string[] = [];
    const code = workspaceCheck(root, ["check", "builder"], {
      git,
      fileExists: () => true,
      log: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("workspace ok /tmp/app");
    expect(calls.some((args) => args[0] === "worktree")).toBe(false);
  });

  it("exits 1 when the agent has no workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-cli-"));
    temps.push(root);
    const state = emptyState();
    state.desired = [
      {
        apiVersion: "ropex.dev/v1",
        kind: "Agent",
        metadata: { name: "builder" },
        spec: {
          replicas: 1,
          harness: { profile: "minimal", plugins: [] },
          hermes: { memory: "shared", learning: false, skills: [] },
        },
      },
    ];
    saveState(root, state);
    const errors: string[] = [];
    const code = workspaceCheck(root, ["check", "builder"], { error: (line) => errors.push(line) });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("has no spec.workspace");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/workspace-cli.test.ts`

Expected: FAIL. `workspaceCheck` is not exported.

- [ ] **Step 3: Write the minimal implementation**

Add this export to `src/cli.ts` and call it from `case "workspace"`.

```ts
export function workspaceCheck(
  root: string,
  args: string[],
  io: {
    git?: GitRunner;
    fileExists?: (file: string) => boolean;
    log?: (line: string) => void;
    error?: (line: string) => void;
  } = {},
): number {
  const log = io.log ?? ((line) => console.log(line));
  const error = io.error ?? ((line) => console.error(line));
  if (args[0] !== "check" || !args[1]) {
    error("usage: ropex workspace check <agent>");
    return 1;
  }
  const agent = loadState(root).desired.find((item) => item.metadata.name === args[1]);
  if (!agent) {
    error(`unknown agent: ${args[1]}`);
    return 1;
  }
  if (!agent.spec.workspace) {
    error(`agent ${args[1]} has no spec.workspace`);
    return 1;
  }
  try {
    prepareWorkspace({
      root,
      agent,
      taskId: "check",
      dryRun: true,
      git: io.git,
      fileExists: io.fileExists,
    });
    log(`workspace ok ${agent.spec.workspace.path}`);
    return 0;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
```

In the switch:

```ts
    case "workspace":
      return workspaceCheck(root, rest);
```

Add this line to the help text next to `ropex sandboxes`:

```ts
  ropex workspace check <agent>   Check runtime, checkout, remote, and base. Creates no branch.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/workspace-cli.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/workspace-cli.test.ts
git commit -m "feat(cli): add workspace check"
```

---

### Task 8: Local bare-repo push

**Files:**
- Test: `tests/workspace-git.test.ts`

**Interfaces:**
- Consumes: `prepareWorkspace`, `publishWorkspace`, `cleanupWorkspace`, `defaultGitRunner`
- Produces: no new production API. Proves a real local git worktree can be committed and pushed to a bare remote on disk.

- [ ] **Step 1: Write the failing test**

Create `tests/workspace-git.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expandDesired, parseManifests } from "../src/spec.ts";
import { cleanupWorkspace, prepareWorkspace, publishWorkspace } from "../src/workspace.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("workspace git", () => {
  it("pushes a committed worktree to a local bare remote", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-git-"));
    temps.push(root);
    const repo = join(root, "app");
    const bare = join(root, "bare.git");
    mkdirSync(repo);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Dev"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "hello\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
    execFileSync("git", ["init", "--bare", bare]);
    execFileSync("git", ["remote", "add", "origin", bare], { cwd: repo });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo });
    const agent = expandDesired(
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  replicas: 1
  runtime:
    kind: dsh
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: shared
    learning: false
    skills: []
  workspace:
    path: ${repo}
    remote: origin
    base: main
`),
    )[0];
    const prepared = prepareWorkspace({ root, agent, taskId: "greeting" });
    writeFileSync(join(prepared.worktree, "README.md"), "hello world\n");
    const outcome = publishWorkspace({ prepared, taskId: "greeting" });
    cleanupWorkspace(prepared, { deleteBranch: false });
    expect(outcome.result).toMatchObject({
      branch: "ropex/greeting",
      remote: "origin",
      pushed: true,
    });
    expect(git(bare, ["rev-parse", "refs/heads/ropex/greeting"])).toBe(outcome.result?.commit);
    expect(git(repo, ["show", "ropex/greeting:README.md"])).toBe("hello world");
    expect(git(bare, ["rev-parse", "refs/heads/main"])).toBe(git(repo, ["rev-parse", "main"]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/workspace-git.test.ts`

Expected: FAIL only if Task 3 is incomplete. If Task 3 is already committed, this test should PASS on the first run. If it passes immediately, do not change production code. Commit the test alone.

- [ ] **Step 3: Write the minimal implementation**

No production change when the test passes. If `git commit` fails because the worktree has no user identity, the commit must still succeed through `GIT_AUTHOR_*` and `GIT_COMMITTER_*` from `publishWorkspace`. Fix `publishWorkspace` only if those variables are not passed through `defaultGitRunner`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/workspace-git.test.ts`

Expected: PASS, with no network.

- [ ] **Step 5: Commit**

```bash
git add tests/workspace-git.test.ts src/workspace.ts
git commit -m "test(workspace): push a worktree to a local bare remote"
```

---

### Task 9: Docs and example fleet

**Files:**
- Create: `fleets/examples/workspace-local.yaml`
- Modify: `docs/forge-neutral.md`
- Modify: `docs/sandboxes.md`
- Test: `tests/workspace-spec.test.ts` (append one case)

**Interfaces:**
- Consumes: the workspace field and `ropex workspace check`
- Produces: an example fleet that parses, and docs that describe the field, the check, and the push result

- [ ] **Step 1: Write the failing test**

Append to `tests/workspace-spec.test.ts`:

```ts
import { readFileSync } from "node:fs";

it("parses the workspace example fleet", () => {
  const text = readFileSync(new URL("../fleets/examples/workspace-local.yaml", import.meta.url), "utf8");
  const agents = expandDesired(parseManifests(text));
  expect(agents.map((agent) => agent.metadata.name)).toContain("builder");
  const builder = agents.find((agent) => agent.metadata.name === "builder");
  expect(builder?.spec.workspace).toEqual({
    path: "/home/you/my-app",
    remote: "origin",
    base: "main",
  });
});
```

Use a path relative to the test file that resolves to `fleets/examples/workspace-local.yaml`. `new URL` from `tests/` needs `../fleets/examples/workspace-local.yaml`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/workspace-spec.test.ts`

Expected: FAIL because the example file does not exist.

- [ ] **Step 3: Write the minimal implementation**

Create `fleets/examples/workspace-local.yaml`:

```yaml
apiVersion: ropex.dev/v1
kind: Policy
metadata:
  name: default-guardrails
spec:
  maxReplicas: 4
  permissions:
    deny: []
    requireApproval: []
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: onDemand
  maxConcurrent: 1
  idleTTLMs: 0
  replicas: 1
  runtime:
    kind: dsh
  workspace:
    path: /home/you/my-app
    remote: origin
    base: main
  harness:
    profile: standard
    plugins: [fs, shell]
  hermes:
    memory: shared
    learning: true
    skills: []
```

In `docs/forge-neutral.md`, add a section after "Two git roles":

```md
## Workspace — edit a checkout you already have

An agent may set `spec.workspace` to a local git checkout. That block is not part of the agent image. Apply the fleet, then check it:

```sh
npx tsx src/cli.ts workspace check builder
```

The check confirms the runtime, the checkout, the remote, and the base branch. It creates nothing.

Submit a Task whose `spec.agent` is that agent. Drain cuts `ropex/<task-id>` from `base`, runs the spine in a worktree, and `git push -u` sends the branch to `remote`. The Task file's `spec.result` then includes `branch`, `commit`, and `remote`. A run that changes nothing fails and does not push. Ropex does not fetch and does not call GitHub.
```

In `docs/sandboxes.md`, add a paragraph after the `workspace: mount` paragraph:

```md
When the agent also sets `spec.workspace`, the prepared task worktree is the directory a Docker sandbox mounts. The container does not clone `sandbox.repo`. Publish runs on the host, in that worktree, and uses the checkout's existing remote.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/workspace-spec.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fleets/examples/workspace-local.yaml docs/forge-neutral.md docs/sandboxes.md tests/workspace-spec.test.ts
git commit -m "docs: describe the agent workspace checkout and branch push"
```

---

## Self-review notes

Spec coverage is mapped as follows:

- Workspace field, defaults, fleet copy, digest exclusion: Task 1
- Prepare order, runtime check, dry run, branch slug, detached HEAD, docker mount: Task 2
- Publish outcomes, commit identity, no force, cleanup: Task 3
- Brief rules: Task 4
- Terminal failure and Task YAML fields: Task 5
- Spine wiring, no-workspace path, learn after a clean failure: Task 6
- `ropex workspace check`: Task 7
- Local bare-repo push: Task 8
- Example fleet and docs: Task 9

A publish failure keeps the branch and is not retried. An execute throw still uses the existing retry path because cleanup has already deleted the branch.
