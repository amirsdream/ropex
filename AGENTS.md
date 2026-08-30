# Ropex agent notes

This repo is a GitOps control plane for agent fleets.

## Core rules

- Desired state lives in `fleets/**/*.yaml` as agent/fleet **definitions** + policy caps — not warm replica inventory.
- **Default scale is on-demand:** admit → spawn under `maxConcurrent` ∩ `Policy.maxReplicas` → run → destroy (`idleTTLMs: 0`). Opt into standing pools only with `scale: static`.
- The controller reconciles definitions; the queue spawns ephemeral workers. Do not hard-code replica lists.
- Memory and skills outlive workers: write to agent/fleet/cluster scopes (`src/memory.ts`, `src/gitmemory.ts`, skill registry). Worker-local facts are promoted on destroy.
- **Hermes + DeepSeek are always coupled:** `bootHermes` → `bootDsh({ hermes })` → `runTask`. No simulation shortcuts.
- Default backends are **embedded** (in-process); live CLI adapters are optional (`ROPEX_*_BACKEND=live`).
- GitHub events, Task YAML, CLI, and **executor API** are work ingress (`src/github.ts`, `src/webhook.ts`, `src/tasks.ts`, `src/executor.ts`).
- Delivery is comment / check / pull request / git writeback (`src/journal.ts`).
- Policy is mandatory for scale: never spawn uncapped fleets (`src/admission.ts`, `src/scale.ts`, `src/approval.ts`).
- Keep the CLI thin. New behavior belongs in spec, controller, or runtime.
- Tests in `tests/` must stay runnable without network or API keys.
- License: **MIT** (`LICENSE`).

## Run the control plane

```bash
npm install && npm run up    # → http://127.0.0.1:7780
npm run down
```

See [docs/operations.md](./docs/operations.md).

## Module map

| Area | Files |
| --- | --- |
| Spec / reconcile | `spec.ts`, `controller.ts`, `image.ts`, `worktree.ts`, `watch.ts`, `gitrepo.ts`, `clone.ts`, `tick.ts`, `canary.ts`, `snapshot.ts`, `drift.ts` |
| Brain / execute | `hermes.ts`, `dsh.ts`, `harness.ts`, `plugins.ts`, `workflow.ts`, `runtime.ts` |
| Executor API | `pipeline.ts`, `executor.ts` — multi-stage pipelines, SSE, scoped drain |
| Memory / skills | `memory.ts`, `skills.ts`, `gitmemory.ts`, `contracts.ts` |
| Queue / scale | `queue.ts`, `scheduler.ts`, `scale.ts` (on-demand spawn/destroy), `fanout.ts`, `admission.ts`, `approval.ts`, `autoscale.ts`, `budget.ts`, `placement.ts`, `fairness.ts` |
| Stack / deploy | `stack.ts`, `Containerfile`, `podman-compose.yml`, `scripts/stack-*.sh` |
| Ingress / audit | `webhook.ts`, `ratelimit.ts`, `journal.ts`, `deliver.ts`, `connectors.ts`, `trajectory.ts`, `metrics.ts`, `health.ts`, `audit.ts` |
| Lifecycle | `lifecycle.ts` (cordon/evict), `hygiene.ts`, `chaos.ts` |
| Surfaces | `api.ts`, `ui/` (control-plane + deep-dive drawer), `cli.ts`, `demo.ts` |

## Documentation

- [README.md](./README.md) — overview + system diagram
- [docs/operations.md](./docs/operations.md) — one-click up/down, Podman Compose
- [docs/system-architecture.md](./docs/system-architecture.md) — visual diagrams
- [docs/architecture.md](./docs/architecture.md) — layered architecture, executor, Magentic
- [docs/control-plane-ui.md](./docs/control-plane-ui.md) — UI deep-dive, stack buttons, live SSE
- [docs/api.md](./docs/api.md) — HTTP routes including `/api/v1/stack`
- [docs/executor-api.md](./docs/executor-api.md) — pipeline contract
- [integrations/magentic/README.md](./integrations/magentic/README.md) — external UI adapter

## Overnight orthodoxy

Ship small, testable slices. Prefer durable cluster-state contracts over dashboards. Prefer immutable worker rolls (digest change) over in-place mutation. **Update docs when behavior changes** — especially `docs/operations.md`, `docs/api.md`, and `docs/README.md`.
