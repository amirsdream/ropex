# Forge-neutral Ropex

Ropex does not require GitHub. **Any git server** (or local git) can hold both fleet config and the work queue.

## Two git roles

| Role | What lives in git | Ropex command |
| --- | --- | --- |
| **Desired state** | `Agent`, `Fleet`, `Policy`, `GitRepo` YAML | `ropex apply`, `ropex watch` |
| **Work queue** | `Task` YAML under `tasks/` | `ropex tasks sync`, `ropex drain` |

GitHub is an optional ingress/delivery adapter. The core loop is:

```text
commit Task YAML (status: pending)
  → ropex tasks sync
  → ropex drain
  → Task YAML updated (status: done, result: …)
  → git commit the result
```

## Task manifest

```yaml
apiVersion: ropex.dev/v1
kind: Task
metadata:
  name: update-readme
spec:
  agent: docbot
  prompt: "Review README for clarity"
  priority: 1
  status: pending          # pending | done | failed | cancelled
  delivery:
    mode: git                # write result back to this file
```

After a worker finishes, Ropex sets `spec.status` and `spec.result` on the same file (git-native delivery).

## Local workflow

```sh
npm install
npx tsx src/cli.ts apply fleets/examples
npx tsx src/cli.ts apply fleets/examples/forge-local.yaml
mkdir -p tasks
cp fleets/examples/tasks/update-readme.yaml tasks/
npx tsx src/cli.ts tasks sync
npx tsx src/cli.ts drain
cat tasks/update-readme.yaml   # status: done, result block filled in
```

## Git hook (any remote)

Copy `scripts/git-hook-post-receive.sh` to `.git/hooks/post-receive` on your git server or local bare repo. On push it runs:

1. `ropex tasks sync --repos` (or `tasks sync` for `$ROPEX_ROOT/tasks`)
2. `ropex drain`

Set `ROPEX_ROOT` to the checkout that holds `.ropex/state.json`.

## GitRepo task inbox

For each declared `GitRepo`, tasks are read from `<repo-path>/tasks/` by default, or `spec.tasksPath`:

```yaml
kind: GitRepo
spec:
  url: file:///srv/fleet.git
  path: fleets/
  tasksPath: tasks
```

## vs GitHub ingress

| | Git tasks | GitHub webhooks |
| --- | --- | --- |
| Forge | Any git | GitHub (optional) |
| Work item | YAML in repo | Issue / PR event |
| Delivery | Update Task YAML | Comment / check / PR |
| Offline tests | Yes | Simulated |

Use git tasks for air-gapped, self-hosted, or Gitea/GitLab workflows. Keep GitHub adapters when issues and PRs are already your inbox.
