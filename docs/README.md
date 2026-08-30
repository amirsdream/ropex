# Ropex documentation

GitOps control plane for agent fleets — Hermes plans, DeepSeek executes, git holds desired state.

## Start here

| Doc | What you'll learn |
| --- | --- |
| [Architecture](./architecture.md) | Control plane vs data plane, immutable workers, the start → transform → result spine, queue, executor API |
| [Control-plane UI](./control-plane-ui.md) | `ropex ui` — pipelines, trajectories, Hermes/DeepSeek drill-down, live SSE |
| [HTTP API (v1)](./api.md) | All `/api/v1/*` routes |
| [Executor API](./executor-api.md) | Multi-stage pipelines, SSE events, Magentic integration |
| [Forge-neutral tasks](./forge-neutral.md) | Task YAML inbox without GitHub |
| [Hermes live wiring](./hermes.md) | Offline brain vs live `hermes-agent` seam |
| [DeepSeek (dsh) wiring](./dsh.md) | Profile packs, simulated vs live harness |
| [Magentic integration](../integrations/magentic/README.md) | External UI → Ropex executor |
| [Ideas log](./ideas.md) | Shipped features and open seams |

## Mental model

```text
Git YAML (desired)  →  Controller  →  Workers (immutable image digests)
GitHub / Task YAML  →  Queue       →  Drain  →  Hermes → DeepSeek → Deliver → Learn
External UI         →  Executor API →  Pipeline stages (sequential, scoped drain)

Every run is one spine:  Start (compose·plan)  →  Transform (execute)  →  Result (deliver·learn)
                         pipeline: input        →  stages              →  result
```

## Quick commands

```bash
ropex apply fleets/examples/github-control-plane.yaml
ropex ui                              # http://127.0.0.1:7780
ropex pipeline "Compare React vs Vue"
ropex drain --concurrency 4
ropex trajectories --jsonl
```

## Repository layout

| Path | Role |
| --- | --- |
| `fleets/**/*.yaml` | Desired state — agents, fleets, policies, tasks, memory |
| `src/controller.ts` | Reconcile workers from git |
| `src/scheduler.ts` | Fair queue drain with leases |
| `src/runtime.ts` | Per-task Hermes → DeepSeek workflow |
| `src/executor.ts` | Multi-stage pipeline API + SSE |
| `src/api.ts` | HTTP control plane + UI view model |
| `src/ui/` | Static control-plane dashboard |
| `integrations/magentic/` | Magentic adapter notes |
| `.ropex/state.json` | Local cluster state (etcd stand-in) |
