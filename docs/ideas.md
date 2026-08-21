# Ropex idea log

Nightly capture. Newest first. Each entry should be one shippable idea, not a slogan.

## 2026-08-21 — bootstrap

- Git is the control plane; GitHub is the queue; workers = DeepSeek Harness + Hermes.
- Declare `Agent` / `Fleet` / `Policy` / `GitRepo` in YAML. Reconcile replicas like pods.
- Wire live `@deepseek-ai/dsh` (everything is a plugin) and `hermes-agent` (soul, memory, skills, learn-loop).
- GitHub App: issues/PRs as work items; comments/checks/PRs as delivery.
- Watch a real `GitRepo` and scale with a commit to `spec.replicas`.
