# Ropex documentation

GitOps control plane for agent fleets — **Hermes plans, DeepSeek executes**, git holds desired state. License: [MIT](../LICENSE).

## Start here

| Doc | What you'll learn |
| --- | --- |
| [**Operations**](./operations.md) | **One-click `npm run up/down`**, Podman Compose, stack API |
| [**System architecture (visual)**](./system-architecture.md) | Diagrams — layers, ingress, workflow, state, module map |
| [Architecture](./architecture.md) | Control plane vs data plane, immutable workers, the start → transform → result spine, queue, executor |
| [Control-plane UI](./control-plane-ui.md) | React SPA — live monitoring, Hermes/DeepSeek console, pipelines, live SSE |
| [HTTP API (v1)](./api.md) | All `/api/v1/*` routes including `/stack` |
| [Executor API](./executor-api.md) | Multi-stage pipelines, SSE, Magentic integration |
| [Forge-neutral tasks](./forge-neutral.md) | Task YAML inbox without GitHub |
| [Hermes wiring](./hermes.md) | Embedded brain vs live `hermes-agent` |
| [DeepSeek (dsh) wiring](./dsh.md) | Embedded harness vs live `@deepseek-ai/dsh` |
| [Magentic integration](../integrations/magentic/README.md) | External UI → Ropex executor |
| [Ideas log](./ideas.md) | Shipped features and open seams |

## Mental model

```text
Git YAML (desired)  →  Controller  →  On-demand workers (immutable digests)
GitHub / Task YAML  →  Queue       →  Drain  →  Hermes → DeepSeek → Deliver → Learn
External UI         →  Executor API →  Pipeline stages (sequential, scoped drain)

Every run is one spine:  Start (compose·plan)  →  Transform (execute)  →  Result (deliver·learn)
                         pipeline: input        →  stages              →  result
```

**Default scale:** `onDemand` — spawn on claim, destroy when idle (`idleTTLMs: 0`).  
**Default backends:** `embedded` Hermes + embedded Cordis harness (network-free tests).  
**Optional live:** `ROPEX_HERMES_BACKEND=live`, `ROPEX_DSH_BACKEND=live` + API keys.

## Quick commands

```bash
npm install
npm run up                              # Podman/Docker or local → :7780
npm run down

npx tsx src/cli.ts apply fleets/examples/github-control-plane.yaml
npx tsx src/cli.ts up --serve           # without compose
npx tsx src/cli.ts pipeline "Compare React vs Vue"
npx tsx src/cli.ts drain --concurrency 4
npx tsx src/cli.ts trajectories --jsonl
```

## Repository layout

| Path | Role |
| --- | --- |
| `fleets/**/*.yaml` | Desired state — agents, fleets, policies, tasks, memory |
| `src/stack.ts` | One-click stack up/down (`ropex up` / `/api/v1/stack`) |
| `src/controller.ts` | Reconcile workers from git |
| `src/scheduler.ts` | Fair queue drain with leases |
| `src/runtime.ts` | Per-task Hermes → DeepSeek workflow (always coupled) |
| `src/executor.ts` | Multi-stage pipeline API + SSE |
| `src/api.ts` | HTTP control plane + UI view model |
| `web/` | Control-plane dashboard — Vite + React + TS SPA (built to `dist/ui`) |
| `Containerfile` / `podman-compose.yml` | Container deploy |
| `scripts/stack-up.sh` / `stack-down.sh` | `npm run up` / `down` |
| `integrations/magentic/` | Magentic adapter notes |
| `.ropex/state.json` | Local cluster state (etcd stand-in) |
