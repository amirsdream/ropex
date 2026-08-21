# Ropex idea log

Nightly capture. Newest first. Each entry should be one shippable idea, not a slogan.

## GitRepo watch loop

Watch declared `GitRepo` paths on an interval, re-parse manifests, reconcile digests, and write state — Flux-style. First slice: `ropex watch --once` / `--interval 5s` over local paths (no remote clone). Prove drift detection: edit YAML → retire+create.

**Shipped (2026-08-21 night):** `watchOnce` / `watchLoop` / `ropex watch` for local manifest trees; digest roll + scale drift covered in tests. Remote clone still open.

## Map harness profiles to live DeepSeek Harness

`harness.profile` (`minimal` | `code` | `standard` | `creator`) should load a real `@deepseek-ai/dsh` plugin pack instead of the simulated kernel. First slice: one adapter that boots dsh headless with the matching preset, runs a single Hermes-planned tool program, and returns the trajectory. Keep Policy denylist as a permissions plugin in front. No GitHub App required for this slice — prove it in `ropex --root sandbox run`.

**Partial (2026-08-21 night):** `bootDsh` + `DSH_PROFILE_PACKS` offline adapter; `backend: "live"` fails closed until `@deepseek-ai/dsh` is wired. Runtime executes through the adapter seam.

## Worktree per worker

Each replica gets its own sandbox under `sandbox/worktrees/<worker-id>/` (git worktree when possible). The harness `fs` and `shell` plugins are chrooted there so a 20-replica `pr-factory` cannot clobber the same files.

**Shipped (2026-08-21 night):** worktree isolation + cwd-chrooted tools + durable queue + HMAC webhook ingress + fair LRU scheduler (`ropex drain` / `webhook simulate`). Workers boot `idle`; claim → `running` → `idle`.

## GitHub App is the queue

Ship a GitHub App that maps `issues.opened` / `issues.labeled` / `pull_request.*` into Ropex tasks. Match `Agent.spec.github.events` + label selectors, pick an idle worker, run Hermes→harness, deliver via comment / check / PR.

**Partial (2026-08-21 night):** webhook HMAC verify + parse + enqueue + drain. Live GitHub App registration still open.

## Immutable agents + Hermes/DeepSeek workflow

**Shipped:** image digest on workers, digest-mismatch rolls, `composeWorkflow` stages, shared memory scopes, control-plane UI.

## 2026-08-21 — bootstrap

- Git is the control plane; GitHub is the queue; workers = DeepSeek Harness + Hermes.
- Declare `Agent` / `Fleet` / `Policy` / `GitRepo` in YAML. Reconcile replicas like pods.
- Wire live `@deepseek-ai/dsh` and `hermes-agent`.
- Watch a real `GitRepo` and scale with a commit to `spec.replicas`.
