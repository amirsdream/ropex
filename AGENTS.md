# Ropex agent notes

This repo is a GitOps control plane for agent fleets.

## Core rules

- Desired state lives in `fleets/**/*.yaml`.
- The controller derives workers; do not hard-code replica lists.
- Hermes plans (`src/hermes.ts`). DeepSeek-style harness executes via `bootDsh` (`src/dsh.ts` → `src/harness.ts`, `src/plugins.ts`).
- GitHub events are the work queue (`src/github.ts`, `src/webhook.ts`). Delivery is comment / check / pull request (`src/journal.ts`).
- Policy is mandatory for scale: never spawn uncapped fleets (`src/admission.ts`, `src/approval.ts`).
- Keep the CLI thin. New behavior belongs in spec, controller, or runtime.
- Tests in `tests/` must stay runnable without network or API keys.

## Module map

| Area | Files |
| --- | --- |
| Spec / reconcile | `spec.ts`, `controller.ts`, `image.ts`, `worktree.ts`, `watch.ts`, `gitrepo.ts` (multi-repo union) |
| Brain / execute | `hermes.ts`, `dsh.ts`, `harness.ts`, `plugins.ts`, `workflow.ts`, `runtime.ts` |
| Memory / skills | `memory.ts`, `skills.ts`, `contracts.ts` |
| Queue / scale | `queue.ts`, `scheduler.ts`, `fanout.ts`, `admission.ts`, `approval.ts`, `autoscale.ts` |
| Ingress / audit | `webhook.ts`, `ratelimit.ts`, `journal.ts`, `trajectory.ts`, `metrics.ts`, `health.ts`, `audit.ts` |
| Surfaces | `api.ts`, `ui/`, `cli.ts`, `demo.ts` |

## Overnight orthodoxy

Ship small, testable slices. Prefer durable cluster-state contracts over dashboards. Prefer immutable worker rolls (digest change) over in-place mutation.
