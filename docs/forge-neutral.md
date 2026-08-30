# Forge-neutral Ropex

Ropex does not require GitHub. **Submit tasks in the UI or API**, optionally sync from git, or enable GitHub/webhook connectors.

## Entry points (pick any)

| Ingress | How work arrives | Results |
| --- | --- | --- |
| **Native UI / API** | `POST /api/v1/tasks` `{ action: "submit", agent, prompt }` or control-plane form | Stored in `.ropex/state.json` (`nativeTasks`) and shown in UI |
| **Git tasks** | `Task` YAML under `tasks/` | Same file updated (`status`, `result`) |
| **GitHub** (optional) | Webhook events | Comment / check / PR journal |
| **Webhook** (optional) | Enable connector + `delivery.mode: webhook` | Outbound POST (stub offline) |

Default stack manifest: `fleets/examples/forge-local.yaml` (no GitHub).

## Native submit (no external system)

```sh
npx tsx src/cli.ts apply fleets/examples/forge-local.yaml
npx tsx src/cli.ts tasks submit --agent docbot --drain "Review README for clarity"
# or
curl -s localhost:7780/api/v1/tasks -H 'content-type: application/json' \
  -d '{"action":"submit","agent":"docbot","prompt":"hello","drain":true}'
```

Open the control-plane UI → **Tasks** section to submit and read results without git.

## Connectors

Connectors are optional adapters. The native UI connector is always available; enable others when needed:

```sh
curl -s localhost:7780/api/v1/connectors
curl -s localhost:7780/api/v1/connectors -H 'content-type: application/json' \
  -d '{"id":"github","enabled":true}'
```

Kinds: `ui`, `git`, `webhook`, `github`.

## Two git roles (optional)

| Role | What lives in git | Ropex command |
| --- | --- | --- |
| **Desired state** | `Agent`, `Fleet`, `Policy`, `GitRepo` YAML | `ropex apply`, `ropex watch` |
| **Work queue** | `Task` YAML under `tasks/` | `ropex tasks sync`, `ropex drain` |
| **Shared memory** | `Memory` YAML under `memory/` | `ropex memory sync`, `ropex memory export` |

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

## Memory manifest

Declare durable knowledge in git — all replicas load it on sync:

```yaml
apiVersion: ropex.dev/v1
kind: Memory
metadata:
  name: login-flake-main
spec:
  agent: docbot
  scope: agent              # worker | agent | fleet | cluster
  text: "Login flake on main — check auth middleware first."
  tags: [bug, auth]
```

```sh
npx tsx src/cli.ts memory sync
npx tsx src/cli.ts memory export --all    # write runtime facts back to memory/
npx tsx src/cli.ts memory promote <id> --scope fleet   # auto-exports to git
```

Runtime facts learned during tasks live in `.ropex/state.json` until exported. Git is the durable, reviewable source of truth for institutional memory.

## Local workflow

```sh
npm install
npx tsx src/cli.ts apply fleets/examples
npx tsx src/cli.ts apply fleets/examples/forge-local.yaml
npx tsx src/cli.ts memory sync
mkdir -p tasks
cp fleets/examples/tasks/update-readme.yaml tasks/
npx tsx src/cli.ts tasks sync
npx tsx src/cli.ts drain
cat tasks/update-readme.yaml   # status: done, result block filled in
```

## Git hook (any remote)

Copy `scripts/git-hook-post-receive.sh` to `.git/hooks/post-receive` on your git server or local bare repo. On push it runs:

1. `ropex memory sync --repos` (or `memory sync` for `$ROPEX_ROOT/memory`)
2. `ropex tasks sync --repos` (or `tasks sync` for `$ROPEX_ROOT/tasks`)
3. `ropex drain`

Set `ROPEX_ROOT` to the checkout that holds `.ropex/state.json`.

## GitRepo task inbox

For each declared `GitRepo`, tasks are read from `<repo-path>/tasks/` by default, or `spec.tasksPath`:

```yaml
kind: GitRepo
spec:
  url: file:///srv/fleet.git
  path: fleets/
  tasksPath: tasks
  memoryPath: memory
```

## vs GitHub ingress

| | Git tasks | GitHub webhooks |
| --- | --- | --- |
| Forge | Any git | GitHub (optional) |
| Work item | YAML in repo | Issue / PR event |
| Delivery | Update Task YAML | Comment / check / PR |
| Offline tests | Yes | Simulated |

Use git tasks for air-gapped, self-hosted, or Gitea/GitLab workflows. Keep GitHub adapters when issues and PRs are already your inbox.

See [docs/README.md](./README.md) for the full documentation index.
