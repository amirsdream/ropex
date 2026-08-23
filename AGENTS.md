# Ropex agent notes

This repo is a GitOps control plane for agent fleets.

## Core rules

- Desired state lives in `fleets/**/*.yaml`.
- The controller derives workers; do not hard-code replica lists.
- Hermes plans (`src/hermes.ts`). DeepSeek-style harness executes via `bootDsh` (`src/dsh.ts` → `src/harness.ts`, `src/plugins.ts`).
- GitHub events, Task YAML, CLI, and **executor API** are work ingress (`src/github.ts`, `src/webhook.ts`, `src/tasks.ts`, `src/executor.ts`).
- Delivery is comment / check / pull request / git writeback (`src/journal.ts`).
- Policy is mandatory for scale: never spawn uncapped fleets (`src/admission.ts`, `src/approval.ts`).
- Keep the CLI thin. New behavior belongs in spec, controller, or runtime.
- Tests in `tests/` must stay runnable without network or API keys.

## Module map

| Area | Files |
| --- | --- |
| Spec / reconcile | `spec.ts`, `controller.ts`, `image.ts`, `worktree.ts`, `watch.ts`, `gitrepo.ts`, `clone.ts`, `tick.ts`, `canary.ts`, `snapshot.ts`, `drift.ts` |
| Brain / execute | `hermes.ts`, `dsh.ts`, `harness.ts`, `plugins.ts`, `workflow.ts`, `runtime.ts` |
| Executor API | `pipeline.ts`, `executor.ts` — multi-stage pipelines, SSE, scoped drain |
| Memory / skills | `memory.ts`, `skills.ts`, `gitmemory.ts`, `contracts.ts` |
| Queue / scale | `queue.ts`, `scheduler.ts`, `fanout.ts`, `admission.ts`, `approval.ts`, `autoscale.ts`, `budget.ts`, `placement.ts`, `fairness.ts` |
| Ingress / audit | `webhook.ts`, `ratelimit.ts`, `journal.ts`, `deliver.ts`, `trajectory.ts`, `metrics.ts`, `health.ts`, `audit.ts` |
| Lifecycle | `lifecycle.ts` (cordon/evict), `hygiene.ts`, `chaos.ts` |
| Surfaces | `api.ts`, `ui/` (control-plane + deep-dive drawer), `cli.ts`, `demo.ts` |

## Documentation

- [README.md](./README.md) — overview + system diagram
- [docs/architecture.md](./docs/architecture.md) — layered architecture, executor, Magentic
- [docs/control-plane-ui.md](./docs/control-plane-ui.md) — UI deep-dive, live SSE
- [docs/executor-api.md](./docs/executor-api.md) — pipeline contract
- [integrations/magentic/README.md](./integrations/magentic/README.md) — external UI adapter

## Overnight orthodoxy

Ship small, testable slices. Prefer durable cluster-state contracts over dashboards. Prefer immutable worker rolls (digest change) over in-place mutation.
