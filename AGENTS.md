# Ropex agent notes

This repo is a GitOps control plane for agent fleets.

## Core rules

- Desired state lives in `fleets/**/*.yaml` as agent/fleet **definitions** + policy caps — not warm replica inventory.
- **Default scale is on-demand:** admit → spawn under `maxConcurrent` ∩ `Policy.maxReplicas` → run → destroy (`idleTTLMs: 0`). Opt into standing pools only with `scale: static`.
- The controller reconciles definitions; the queue spawns ephemeral workers. Do not hard-code replica lists.
- Memory and skills outlive workers: write to agent/fleet/cluster scopes (`src/memory.ts`, `src/gitmemory.ts`, skill registry). Worker-local facts are promoted on destroy.
- **Hermes is always coupled to the executor:** `bootHermes` → `bootWorker({ hermes })` → `runTask`. No simulation shortcuts. Hermes owns compose/plan/learn for every runtime; only the `execute` stage is pluggable via `spec.runtime` (`dsh` by default, or the Claude Code / Codex / Copilot CLIs — see `docs/worker-runtimes.md`).
- Default backends are **embedded** (in-process); live CLI adapters are optional (`ROPEX_*_BACKEND=live`, `npm run live`).
- Every run has one **start → transform → result** spine: `workflow.ts` phases (`intake`/`execute`/`result` via `workflowPhases()`); the executor `PipelineRun` mirrors it with typed `input`/`stages`/`result` (`pipelinePhase()` in `src/executor.ts`). Keep the spine intact when adding stages or ingress.
- GitHub events, Task YAML, CLI, and **executor API** are work ingress (`src/github.ts`, `src/webhook.ts`, `src/tasks.ts`, `src/executor.ts`).
- Delivery is comment / check / pull request / git writeback (`src/journal.ts`).
- Policy is mandatory for scale: never spawn uncapped fleets (`src/admission.ts`, `src/scale.ts`, `src/approval.ts`).
- Keep the CLI thin. New behavior belongs in spec, controller, or runtime.
- Tests in `tests/` must stay runnable without network or API keys.
- License: **MIT** (`LICENSE`).

## Run the control plane

```bash
npm install && npm run up    # → http://127.0.0.1:7780
npm run live                 # live Hermes + dsh on the host (docs/quickstart.md)
npm run down
```

See [docs/quickstart.md](./docs/quickstart.md) and [docs/operations.md](./docs/operations.md).

## Cursor Cloud specific instructions

`.cursor/environment.json` is the Cloud Agent environment for this repo.

- **`install`** (`npm install && npm run build`) runs during a Build. It must finish. Never put a server here.
- **`start`** (`bash scripts/cloud-agent-start.sh`) must **exit in seconds**. Cursor holds the desktop on **Starting remote server** and will not open the `ropex-ui` terminal until `start` returns. Do not put `npm run build:web`, `ropex ui`, or `npm run up` in `start`.
- **`terminals` → `ropex-ui`** is the dashboard: `npx tsx src/cli.ts up fleets/examples/github-control-plane.yaml --serve --port 7780` → http://127.0.0.1:7780
- Embedded backends need no secrets. Live mode needs `OPENAI_API_KEY` in Cloud Agent secrets, then `npm run live` (not Compose).

If a Cloud Agent is stuck on Starting remote server, the usual cause is a blocking `start` command from an older environment.json. Start a **new** agent after this file is on the branch you selected.

## Module map

| Area | Files |
| --- | --- |
| Spec / reconcile | `spec.ts`, `controller.ts`, `image.ts`, `worktree.ts`, `watch.ts`, `gitrepo.ts`, `clone.ts`, `tick.ts`, `canary.ts`, `snapshot.ts`, `drift.ts` |
| Brain / execute | `hermes.ts`, `dsh.ts`, `harness.ts`, `plugins.ts`, `workflow.ts`, `runtime.ts`, `brief.ts` |
| Worker runtimes | `worker-runtime.ts` (registry + boot dispatch), `cli-runtimes.ts` (per-CLI descriptors), `proc.ts` (subprocess primitive) |
| Executor API | `pipeline.ts`, `executor.ts` — multi-stage pipelines, SSE, scoped drain |
| Memory / skills | `memory.ts`, `skills.ts`, `gitmemory.ts`, `contracts.ts` |
| Queue / scale | `queue.ts`, `scheduler.ts`, `scale.ts` (on-demand spawn/destroy), `fanout.ts`, `admission.ts`, `approval.ts`, `autoscale.ts`, `budget.ts`, `placement.ts`, `fairness.ts` |
| Stack / deploy | `stack.ts`, `session.ts`, `Containerfile`, `Containerfile.worker`, `podman-compose.yml`, `scripts/stack-*.sh`, `scripts/live-up.sh` |
| Dev environment | `scripts/wsl-setup.sh`, `scripts/wsl-doctor.sh`, `scripts/wsl-bootstrap.ps1`, `scripts/wsl/`, `.gitattributes` |
| Ingress / audit | `webhook.ts`, `ratelimit.ts`, `journal.ts`, `deliver.ts`, `connectors.ts`, `trajectory.ts`, `metrics.ts`, `health.ts`, `audit.ts` |
| Lifecycle | `lifecycle.ts` (cordon/evict), `hygiene.ts`, `chaos.ts` |
| Surfaces | `api.ts` (serves the SPA), `web/` (Vite + React + TS dashboard → `dist/ui`), `cli.ts`, `demo.ts` |

## Documentation

- [README.md](./README.md) — overview + system diagram
- [docs/quickstart.md](./docs/quickstart.md) — step-by-step run + live mode
- [docs/operations.md](./docs/operations.md) — one-click up/down, Podman Compose
- [docs/wsl.md](./docs/wsl.md) — WSL 2 development environment on Windows
- [docs/system-architecture.md](./docs/system-architecture.md) — visual diagrams
- [docs/architecture.md](./docs/architecture.md) — layered architecture, executor, Magentic
- [docs/control-plane-ui.md](./docs/control-plane-ui.md) — UI deep-dive, stack buttons, live SSE
- [docs/api.md](./docs/api.md) — HTTP routes including `/api/v1/stack`
- [docs/executor-api.md](./docs/executor-api.md) — pipeline contract
- [docs/worker-runtimes.md](./docs/worker-runtimes.md) — pluggable executors (dsh, Claude Code, Codex, Copilot)
- [integrations/magentic/README.md](./integrations/magentic/README.md) — external UI adapter

## Overnight orthodoxy

Ship small, testable slices. Prefer durable cluster-state contracts over dashboards. Prefer immutable worker rolls (digest change) over in-place mutation. **Update docs when behavior changes** — especially `docs/operations.md`, `docs/api.md`, and `docs/README.md`.
