# Workspace branch push

Ropex can edit a git checkout the operator already has. A fleet declares that checkout on the agent. A Task prompt is the work. The run creates a branch, lets the runtime edit it, and pushes the branch to the checkout's existing remote.

This slice does not call `gh` or the GitHub API. It does not open a pull request or comment on an issue. Those can sit on the same workflow later.

Base branch for the implementation: `cursor/sandbox-task-commit-75e8`.

## Decisions

- The checkout is `Agent.spec.workspace`, not a `GitRepo` and not a per-task repo field. One agent edits one checkout. A second checkout is a second agent.
- Tasks stay the unit of work. The prompt arrives through the existing inbox: Task YAML, `ropex tasks submit`, or the API.
- The CLI stays thin. The only new command is a dry-run check.
- Before execute, Ropex creates a worktree on a new branch cut from `base`.
- The runtime may commit on that branch. It must not push, switch branches, or change remotes.
- After execute, Ropex commits a dirty tree, then pushes when the branch is ahead of `base`. A clean tree that is not ahead is a failed task and is not pushed.
- Push uses the remote already configured in the checkout. Ropex does not fetch, inject credentials, or rewrite the remote URL.
- `workspace` is not part of the agent image digest.

## Operator flow

1. Install Ropex and apply a fleet whose agent sets `runtime` and `workspace`.
2. `ropex workspace check <agent>` confirms the runtime, the checkout, the remote, and `base`. It creates no branch.
3. Submit a Task whose `spec.agent` is that agent and whose `spec.prompt` is the change.
4. Drain runs the existing spine in the new worktree: compose, plan, execute, deliver, learn.
5. Deliver pushes `ropex/<task-id>` to `remote`. The Task result records the branch, commit, and remote.

```yaml
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: onDemand
  maxConcurrent: 1
  replicas: 1
  runtime:
    kind: codex
  workspace:
    path: /home/you/my-app
    remote: origin
    base: main
  harness:
    profile: standard
    plugins: [fs, shell]
  hermes:
    soul: souls/builder.md
    memory: shared
    learning: true
    skills: []
```

`path` is required when `workspace` is present. `remote` defaults to `origin`. `base` is optional.

## What is left out of the image

`agentImagePayload` in `src/image.ts` is an allowlist. Do not add `workspace` to it. Changing the path, remote, or base must not change the digest and must not roll workers.

## Prepare

New module `src/workspace.ts`. `runTask` calls it only when `spec.workspace` is set, and it calls it before `acquireSandbox`.

Prepare checks, in order:

1. The agent's runtime is usable.
2. `path` exists and `git -C <path> rev-parse --is-inside-work-tree` succeeds.
3. `git remote get-url <remote>` succeeds.
4. The base commit resolves locally. There is no fetch.
5. The branch name `ropex/<slug>` does not already exist.

Any failure stops the run before a branch or worktree is created.

### Runtime check

- `dsh` with the embedded backend passes. That is the default.
- `dsh` with `ROPEX_DSH_BACKEND=live` passes only when `resolveDshBin()` returns a path. Live `dsh` in a Docker sandbox still fails closed, as it does today.
- `claude-code`, `codex`, and `copilot` pass only when `prepareRuntimeAuth` succeeds and the path from `resolveRuntimeBin` exists on disk.

`ropex workspace check <agent>` runs the same runtime and git checks with `dryRun: true`. Exit code is non-zero on failure. It does not create a branch, a worktree, or a worker.

### Base, branch, and worktree

When `base` is omitted, use the branch checked out in the main working tree (`git rev-parse --abbrev-ref HEAD`). If that output is `HEAD` (detached), fail before creating a branch.

The branch name is `ropex/<slug>`. `<slug>` is the task id with every character outside `[A-Za-z0-9._-]` replaced by `-`, collapsed to a single `-`, and truncated to 80 characters. Prepare treats the name as taken when that branch exists in the local checkout. A second task with the same slug fails prepare. The operator deletes the local branch or uses a new task id to run again. A branch that exists only on the remote is not visible to prepare; the later push fails, and the local branch is kept.

The worktree path is `<control-plane-root>/.ropex/workspace/<agent>/<slug>`. Create it with `git -C <checkout> worktree add -b <branch> <path> <base>`. The user's checkout gains git worktree metadata only. It does not gain a `.ropex` directory of files.

The worker's current directory and the sandbox host directory are this worktree. Agents without `workspace` keep today's control-plane worktree.

When the agent also has a Docker sandbox, that sandbox bind-mounts this worktree. It does not clone a second copy, even if `sandbox.repo.workspace` is `clone`. Publish still runs on the host, against the worktree, so the host's existing git credentials are the ones that push.

## Brief

When a workspace is set, `composeBrief` adds these rules to the working-directory section:

- You are on branch `ropex/<slug>`, cut from `<base>`.
- You may commit on this branch.
- You must not push, switch branches, or change remotes.

## Publish

Publish runs on the host at the start of the deliver stage, before the existing comment / check / pull-request journal. Learn runs after the publish attempt when execute itself finished.

Publish's git commands use the worktree as their current directory. `runTask` wraps execute and publish in `finally` so a thrown execute still removes the worktree and deletes the task branch.

Commit identity is `Ropex <ropex@localhost>` through `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, with `commit.gpgsign=false`. The commit message is exactly `ropex: <task-id>`. A dirty tree is staged with `git add -A`. Ignored files stay unstaged. There is no `git add --force`.

"Ahead" means `git rev-list --count <base>..<head>` is greater than zero after any Ropex commit. When that count is greater than zero, publish runs `git push -u <remote> <branch>` from the worktree. The push never includes `--force` or `--force-with-lease`.

A normal push is not the `force-push` permission. This slice adds no policy gate.

### Outcomes

| State after execute | Push | Local branch | Worktree directory | Task |
| --- | --- | --- | --- | --- |
| Prepare failed | no | not created | not created | failed |
| Execute threw | no | deleted | removed | failed, learn does not run |
| Clean, not ahead of `base` | no | deleted | removed | failed, learn runs |
| Dirty, commit fails | no | kept | removed | failed, learn runs |
| Ahead, push fails | attempted | kept | removed | failed, learn runs |
| HEAD is not `ropex/<slug>` | no | kept, including any other branch | removed | failed, learn runs |
| Ahead, push succeeds | yes | kept | removed | done, learn runs |

HEAD is checked before any commit or push. A wrong branch is not committed onto and is not pushed. Publish does not delete a branch the runtime switched to.

The run result gains `workspaceResult`:

```ts
{
  branch: string;
  commit?: string;
  remote: string;
  pushed: boolean;
}
```

`commit` is the full SHA when a commit exists on the task branch. `pushed` is true only after `git push` exits 0. `workspaceResult` is omitted when prepare fails and no branch was created. It is present with `pushed: false` whenever a local branch was kept or a push was attempted.

For `delivery.mode: git`, `deliverGitTaskManifest` writes `branch`, `commit`, and `remote` onto `spec.result` next to the existing output fields. On failure it also writes `spec.result.error` with the git or prepare message. Other delivery modes still carry `workspaceResult` on the in-memory run result.

## Files

| Path | Change |
| --- | --- |
| `src/types.ts` | `WorkspaceSpec` on `AgentSpec`. `workspaceResult` on the run result. Result fields on the Task manifest. |
| `src/spec.ts` | Validate `workspace.path`. Default `remote` to `origin` in `normalizeAgentSpec`. `cloneAgentSpec` copies `workspace` so a fleet template keeps it. |
| `src/image.ts` | No change to the payload. A test locks the exclusion. |
| `src/workspace.ts` | Prepare, dry-run check, publish, worktree removal. Git commands go through an injected runner. |
| `src/runtime.ts` | Call prepare before the sandbox. Point the sandbox at the worktree. Call publish at the start of deliver. |
| `src/brief.ts` | Add the three branch rules when a workspace run is active. |
| `src/tasks.ts` | Write `branch`, `commit`, `remote`, and `error` on git delivery. |
| `src/cli.ts` | `ropex workspace check <agent>`. |
| `fleets/examples/workspace-local.yaml` | One agent whose `workspace.path` is `/home/you/my-app`. Documentation only. Tests do not apply this file against a real home directory. |
| `docs/forge-neutral.md` | Document the workspace field, the check, and the push result. |
| `docs/sandboxes.md` | Note that a workspace worktree is what a Docker sandbox mounts. |

## Testing

Tests under `tests/` stay free of network, API keys, and real coding CLIs. `src/workspace.ts` takes an injected git runner. The fake runner covers:

- A dirty tree produces one `ropex: <task-id>` commit, then `git push -u <remote> <branch>`.
- A branch already ahead of `base` is pushed and is not committed again.
- A missing runtime, a non-git path, a missing remote, a missing `base`, a detached HEAD when `base` is omitted, or an existing branch name never creates a branch.
- An execute failure deletes the worktree and the local branch and does not push.
- A clean tree that is not ahead fails the task, deletes the branch, and does not push.
- A failed commit or a failed push keeps the local branch and the recorded command has no `--force`.
- HEAD on any other branch is not pushed and is not committed onto.
- Two different `workspace` values produce the same `agentImagePayload`.
- An agent with no workspace does not call prepare or publish.
- The brief for a workspace run contains the three branch rules.
- A git-mode Task file receives `branch`, `commit`, and `remote`.
- `ropex workspace check` creates no branch.

One test uses real local git: a temp repo and a bare remote on disk. It adds the worktree, commits, and pushes to that bare repo. Nothing leaves the machine.

## Later

Push, pull request, and issue comment through `gh` or a token are a later slice. The deliver stage is where they attach. This slice's publish result is the input they will read. Do not add that adapter now.
