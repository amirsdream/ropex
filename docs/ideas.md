# Ropex idea log

Nightly capture. Newest first. Each entry should be one shippable idea, not a slogan.

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
