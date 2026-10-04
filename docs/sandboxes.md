# Sandboxes — where the execute stage runs

A **sandbox** is the isolated place an agent's `execute` stage runs commands. Hermes still composes, plans, remembers and learns on the control plane, and delivery, policy and memory are unchanged. Only the place the executor runs moves.

| Provider | What it is | Default |
| --- | --- | --- |
| `local` | The worker's git worktree on the host (`sandbox/worktrees/<worker>`). | yes |
| `docker` | One container per task, built from a recipe you configure, with the repo checked out and tokens forwarded. Works with Podman too. | no |

Omit `spec.sandbox` and nothing changes: the agent runs in its worktree exactly as before, and its image digest is unchanged.

```text
spec.sandbox ──► acquireSandbox ──► provider
                    │ policy gate         ├─ local   worktree on the host
                    │ (fails closed)      └─ docker  env image ─► (warm snapshot) ─► container
                                                                     │
                                          exec ◄── runtime CLI (codex, claude -p, copilot -p)
                                                                     │
                                       git commit (optional) ─► push or bundle
                                                                     │
                                       dispose  or  snapshot ─► dispose      store: .ropex/sandboxes
```

## Declaring a sandbox

```yaml
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  runtime: { kind: codex }
  sandbox:
    provider: docker                  # local (default) | docker
    image:
      base: node:22-bookworm          # default node:22-bookworm
      tools: [git, gh, curl, codecs]  # presets that expand to apt packages
      apt: [jq]
      npm: ["@openai/codex"]
      pip: []
      setup: ["corepack enable"]      # extra single-line RUN commands
      # dockerfile: docker/agent.Dockerfile   # escape hatch, exclusive with the recipe
    repo:
      url: https://github.com/org/repo.git
      ref: main
      depth: 1
      tokenEnv: GITHUB_TOKEN          # the NAME of an env var, never a token
      workspace: clone                # clone (default) | mount
    env: { CI: "1" }                  # non-secret, baked into the container config
    secrets: [OPENAI_API_KEY]         # forwarded per exec, never baked
    resources: { cpus: 2, memory: 4g, pids: 512, network: bridge }
    lifecycle:
      after: dispose                  # dispose (default) | snapshot
      warmSnapshot: true
      keep: 3
      ttlMs: 604800000
    git:
      commit: true                    # commit workspace changes after a successful execute
      branch: "ropex/{taskId}"        # default
      push: false                     # true pushes the branch to origin before dispose
```

A runnable version is in [`fleets/examples/docker-sandbox.yaml`](../fleets/examples/docker-sandbox.yaml). The whole block is part of the agent **image digest**, so editing it rolls the agent's workers like any other spec change.

### Tool presets

`image.tools` names presets that expand to apt packages. They assume a Debian or Ubuntu base. Use `apt`, `npm`, `pip` and `setup` for anything else.

| Preset | apt packages |
| --- | --- |
| `git` | `git` |
| `gh` | `gh` |
| `curl` | `curl`, `ca-certificates` |
| `web` | `curl`, `wget`, `ca-certificates` |
| `ffmpeg` | `ffmpeg` |
| `codecs` | `ffmpeg`, `libavcodec-extra` |
| `python` | `python3`, `python3-pip` |
| `build` | `build-essential` |
| `jq`, `ripgrep`, `chromium` | the package of the same name |

`git` and `ca-certificates` are always installed because the checkout needs them. Package names are validated against per-ecosystem patterns and `setup` lines must be a single line, so a recipe cannot inject extra Dockerfile instructions.

## The docker lifecycle

1. **Environment image.** The recipe renders to a Dockerfile and is tagged `ropex-env:<digest>` of that text. If the image exists the build is skipped. Identical recipes across agents and restarts share one image. `ropex sandbox build <agent>` builds it ahead of time.
2. **Warm snapshot** (`lifecycle.warmSnapshot`). The first run checks the repo out into the container and commits it as `ropex-snap:warm-<key>`. The key is the environment digest, repo URL, ref and depth. Later runs start from that snapshot and only run `git fetch`, `checkout` and `clean`.
3. **Container.** `docker run -d` with `--init`, `--security-opt no-new-privileges`, a pids limit (default 512), your cpus, memory and network limits, and labels `ropex.sandbox=1`, `ropex.worker`, `ropex.agent`, `ropex.task`. The working directory is `/workspace`.
4. **Checkout.** `git init`, `remote add`, `fetch`, `checkout --detach FETCH_HEAD`. This works for branches, tags and commit SHAs.
5. **Execute.** The runtime CLI runs through `docker exec -i -w /workspace`. The brief goes in over stdin. Timeout and kill escalation are the same as every other subprocess.
6. **Commit.** When `git.commit` is set and the task succeeded, dirty files are committed on `git.branch` (default `ropex/{taskId}`). The author is `Ropex <ropex@localhost>` for that commit only. Control-plane marker files (`.ropex-worker.json`, `README.ropex`) are left out. A clean tree is not an error. A failed execute does not commit. `git.push: true` then runs `git push -u origin <branch>` before the container is removed. Without a push, a cloned workspace is exported as a git bundle under `.ropex/sandboxes/commits/` so disposing the container does not delete the commit. A `mount` workspace and the local provider commit straight into the host repository, which already keeps the commit.
7. **Finish.** With `after: snapshot` the container is committed as a task snapshot first. The container is then always removed, including when the task failed or timed out. A killed `docker exec` client does not stop the process inside, but removing the container does.

`workspace: mount` skips the clone and bind-mounts the worker's host worktree at `/workspace`. Use it when the control plane runs on the host. Do not use it when the control plane itself runs in a container, because the path would be wrong. Files the container writes are owned by the container user.

## Tokens and secrets

- The container is **created with no secrets**.
- Each `docker exec` forwards secrets by name (`-e NAME`). The value is read from the docker client's own environment, so it never appears on an argv, in `docker inspect`, or in a `docker commit` snapshot.
- `repo.tokenEnv` also drives git auth. A credential helper reads `$ROPEX_GIT_TOKEN`, so the token is not in the remote URL or `.git/config`. The same token is forwarded under its own name (for example `GITHUB_TOKEN`) so `gh` works inside the container.
- The runtime's own credentials (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …) are forwarded the same way.
- A declared `tokenEnv` or `secrets` entry that is not set on the control plane fails the task before any container starts.

## Snapshots and storage

Snapshots live under `ROPEX_SANDBOX_DIR` (default `.ropex/sandboxes`).

| File | Purpose |
| --- | --- |
| `catalog.json` | Index: key, kind (`warm` or `task`), image ref, tarball, bytes, created and last-used times, labels |
| `<key>.tar.gz` | `docker save` of the snapshot, so it survives `docker image prune` and a fresh host |

If a snapshot's image is gone, the tarball is `docker load`ed. If both are gone the entry is dropped and the run falls back to a clean checkout. A failed warm-snapshot write never fails the task.

Retention (`lifecycle.keep`, `lifecycle.ttlMs`, and `Policy.spec.sandbox.maxSnapshotBytes`) is applied after every snapshot. `keep` is per environment image. `ttlMs` is idle time. The byte cap evicts least recently used first. Evicting removes the tarball, runs `rmi`, and drops the catalog entry. `ropex sandbox prune` applies the same rules by hand.

## Policy

`Policy.spec.sandbox` caps what agents may ask for. It fails closed at enqueue (`admitTask`) and again when the sandbox is acquired.

```yaml
kind: Policy
spec:
  maxReplicas: 8
  sandbox:
    allowProviders: [local, docker]
    allowBaseImages: ["node:*", "debian:*"]   # `*` wildcard
    maxSnapshotBytes: 8589934592
```

A restricted `allowBaseImages` also rejects `image.dockerfile`, because the base cannot be verified. One sandbox belongs to one worker, so `maxConcurrent ∩ Policy.maxReplicas` still bounds the number of containers.

## Runtimes

- **CLI runtimes** (`claude-code`, `codex`, `copilot`) run inside the sandbox. The binary must exist in the image (add it to `image.npm`, or `setup`). If it does not, the task fails with a message naming `spec.sandbox.image`. Binary resolution happens inside the container, so `PATH` on the host does not matter.
- **`dsh` embedded** has stub fs and shell tools, so it only receives the sandbox's host directory.
- **`dsh` live** cannot run in a docker sandbox, because the dsh package lives on the control plane. It fails closed with a message saying so.

## Operations

| Command | Effect |
| --- | --- |
| `ropex sandboxes [--json]` | Providers, agents with sandboxes, snapshots, live containers |
| `ropex sandbox build <agent>` | Build or reuse the agent's environment image |
| `ropex sandbox prune [--keep N] [--ttl-ms N]` | Evict snapshots; with no flags, all of them |
| `ropex gc` | Also removes sandbox containers and scratch directories whose worker is gone |

`GET /api/v1/sandboxes` returns the same report. `ropex gc`, `ropex hygiene gc` and the tick `gc` option remove orphan containers. A worker that is `running` or `pending` keeps its container. GC never touches docker unless a desired agent or worker uses a docker sandbox, because the containers on a shared host may belong to another control plane.

## Relation to container sessions

[Ephemeral sessions](./ephemeral-sessions.md) (`ROPEX_EXECUTOR=container`) run a whole **pipeline** in one `ropex-session` container with Hermes inside. A sandbox is per **task** and keeps Hermes on the control plane. Pick one. Inside a session (`ROPEX_IN_SESSION=1`) there is no nested Docker, so a `docker` sandbox fails closed there.

## Adding another provider

A provider is one file implementing `SandboxProvider` in `src/sandbox/`, registered in `src/sandbox/index.ts`, plus a member of `SANDBOX_PROVIDER_KINDS_LIST` in `src/types.ts` and a registry entry. SSH hosts and VMs fit the same contract.

| Member | Contract |
| --- | --- |
| `probe(env)` | Report availability without spawning anything |
| `acquire(spec, ctx)` | Return a `Sandbox`, or throw. Called after the policy gate |
| `Sandbox.exec(bin, args, opts)` | Run a command and return `{ code, stdout, stderr, timedOut }`. `opts.env` values are sensitive, so forward them without placing them on a command line |
| `Sandbox.resolveBin(bin)` | Locate an executable inside the isolate |
| `Sandbox.snapshot(label)` | Persist the isolate, or return `undefined` if the provider cannot |
| `Sandbox.copyOut(src, dest)` | Copy a path to the host |
| `Sandbox.dispose()` | Release it. Idempotent. Called in `finally` |

## Files

| Path | Role |
| --- | --- |
| `src/sandbox/index.ts` | Provider contract, registry, `acquireSandbox`, `sandboxReport` |
| `src/sandbox/local.ts` | The worktree provider |
| `src/sandbox/docker.ts` | Container lifecycle, git checkout, token forwarding, orphan GC |
| `src/sandbox/git.ts` | Commit workspace changes onto a branch, optional push, bundle export |
| `src/sandbox/image.ts` | Recipe to Dockerfile, digest tag, build-if-missing |
| `src/sandbox/store.ts` | Catalog, tarball export and restore, retention |
| `src/sandbox/spec.ts` | Validation, tool presets, canonical form, policy checks |
| `src/sandbox/client.ts` | Docker client (injectable in tests) |

Tests use an in-memory fake docker (`tests/sandbox/fake-docker.ts`) and need no container runtime. `ROPEX_TEST_DOCKER=1 npx vitest run tests/sandbox/integration.test.ts` runs a smoke test against a real runtime.
