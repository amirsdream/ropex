# Ropex agent notes

This repo is a GitOps control plane for agent fleets.

- Desired state lives in `fleets/**/*.yaml`.
- The controller derives workers; do not hard-code replica lists.
- Hermes plans (`src/hermes.ts`). DeepSeek-style harness executes (`src/harness.ts`, `src/plugins.ts`).
- GitHub events are the work queue (`src/github.ts`). Delivery is comment / check / pull request.
- Policy is mandatory for scale: never spawn uncapped fleets.
- Keep the CLI thin. New behavior belongs in spec, controller, or runtime.
- Tests in `tests/` must stay runnable without network or API keys.
