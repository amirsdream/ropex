# Ropex idea log

Nightly capture. Newest first. Each entry should be one shippable idea, not a slogan.

## Immutable agents + Hermes/DeepSeek workflow

Ropex should orchestrate like Kubernetes: provision **immutable workers** from a content-addressed agent image (soul + skills + harness + github), and run a fixed workflow that keeps Hermes for compose/plan/learn and DeepSeek Harness for execute/deliver. First slice: image digest on workers, digest-mismatch rolls (retire+create), `composeWorkflow` stages in `runTask`. No live model required.

## Map harness profiles to live DeepSeek Harness

`harness.profile` (`minimal` | `code` | `standard` | `creator`) should load a real `@deepseek-ai/dsh` plugin pack instead of the simulated kernel. First slice: one adapter that boots dsh headless with the matching preset, runs a single Hermes-planned tool program, and returns the trajectory. Keep Policy denylist as a permissions plugin in front. No GitHub App required for this slice — prove it in `ropex --root sandbox run`.

## Worktree per worker

Each replica gets its own git worktree under `sandbox/worktrees/<worker-id>/`. The harness `fs` and `shell` plugins are chrooted there so a 20-replica `pr-factory` cannot clobber the same files. First slice: create/destroy worktrees in the reconciler (pending → running creates, retired removes) and point `runTask` at that cwd. No extra model required.

## GitHub App is the queue

Ship a GitHub App that maps `issues.opened` / `issues.labeled` / `pull_request.*` into Ropex tasks. Match `Agent.spec.github.events` + label selectors, pick an idle worker, run Hermes→harness, deliver via comment / check / PR. Store deliveries as issue comments so git blame and review stay native. First slice: webhook ingress + HMAC verify + enqueue; no live model required.

## 2026-08-21 — bootstrap

- Git is the control plane; GitHub is the queue; workers = DeepSeek Harness + Hermes.
- Declare `Agent` / `Fleet` / `Policy` / `GitRepo` in YAML. Reconcile replicas like pods.
- Wire live `@deepseek-ai/dsh` (everything is a plugin) and `hermes-agent` (soul, memory, skills, learn-loop).
- GitHub App: issues/PRs as work items; comments/checks/PRs as delivery.
- Watch a real `GitRepo` and scale with a commit to `spec.replicas`.
