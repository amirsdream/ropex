# Ropex documentation

GitOps control plane for agent fleets — **Hermes plans, DeepSeek executes by default**, and a declared CLI can replace that execute stage. Git holds desired state. License: [MIT](../LICENSE).

## Start here

| Doc | What you'll learn |
| --- | --- |
| [**Quick start**](./quickstart.md) | **Step-by-step run** (embedded) and **live mode** (`npm run live`) |
| [**Operations**](./operations.md) | **One-click `npm run up/down`**, Podman Compose, container sessions, stack API |
| [**Ephemeral sessions**](./ephemeral-sessions.md) | One image per plan, Hermes vs DeepSeek, simple pipeline, follow strip |
| [**WSL setup (Windows)**](./wsl.md) | **One-script WSL 2 environment** — `wsl-bootstrap.ps1`, `wsl-setup.sh`, `wsl-doctor.sh` |
| [**System architecture (visual)**](./system-architecture.md) | Diagrams — layers, ingress, workflow, state, module map |
| [Architecture](./architecture.md) | Control plane vs data plane, immutable workers, the start → transform → result spine, queue, executor |
| [Control-plane UI](./control-plane-ui.md) | React SPA — live monitoring, Hermes/DeepSeek console, pipelines, live SSE |
| [HTTP API (v1)](./api.md) | All `/api/v1/*` routes including `/stack` |
| [Executor API](./executor-api.md) | Multi-stage pipelines, SSE, Magentic integration |
| [Forge-neutral tasks](./forge-neutral.md) | Task YAML inbox without GitHub |
| [Hermes wiring](./hermes.md) | Embedded brain vs live `hermes-agent` |
| [DeepSeek (dsh) wiring](./dsh.md) | Embedded harness vs live `@deepseek-ai/dsh` |
| [Worker runtimes](./worker-runtimes.md) | Swap the execute stage: dsh, Claude Code, Codex, Copilot, Cursor |
| [Manual runtime checks](./manual-runtime-checks.md) | Repeatable local steps for harness commits, auth, and Cursor |
| [More runtime tasks](./manual-runtime-tasks.md) | Extra Cursor and Codex tasks, scripted and open |
| [Sandboxes](./sandboxes.md) | Run the execute stage in a local worktree or a Docker container: image recipe, repo checkout, tokens, snapshots |
| [Magentic integration](../integrations/magentic/README.md) | External UI → Ropex executor |
| [Ideas log](./ideas.md) | Shipped features and open seams |

## Mental model

```text
Git YAML (desired)  →  Controller  →  On-demand workers (immutable digests)
GitHub / Task YAML  →  Queue       →  Drain  →  Hermes → execute (dsh | CLI) → Deliver → Learn
External UI         →  Executor API →  Pipeline stages (sequential, scoped drain)

Every run is one spine:  Start (compose·plan)  →  Transform (execute)  →  Result (deliver·learn)
                         pipeline: input        →  stages              →  result
```

**Default scale:** `onDemand` — spawn on claim, destroy when idle (`idleTTLMs: 0`).  
**Default backends:** `embedded` Hermes + embedded Cordis harness (network-free tests).  
**Optional live:** `npm run live` (or `ROPEX_HERMES_BACKEND=live` + `ROPEX_DSH_BACKEND=live` + API keys). Guide: [quickstart.md](./quickstart.md).

## Quick commands

```bash
npm install
npm run up                              # Podman/Docker or local → :7780
npm run live                            # host process, live Hermes + dsh
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
| `src/runtime.ts` | Per-task Hermes → worker runtime workflow (always coupled) |
| `src/executor.ts` | Multi-stage pipeline API + SSE |
| `src/api.ts` | HTTP control plane + UI view model |
| `web/` | Control-plane dashboard — Vite + React + TS SPA (built to `dist/ui`) |
| `Containerfile` / `Containerfile.worker` | Control plane and the session base image |
| `docker-compose.yml` / `podman-compose.yml` | Compose: build the base, serve the control plane |
| `src/session.ts` | Build, run, and delete one session per plan |
| `scripts/stack-up.sh` / `stack-down.sh` / `live-up.sh` | `npm run up` / `down` / `live` |
| `scripts/wsl-*.sh` / `scripts/wsl/` | WSL 2 provisioning, health check, `wsl.conf` / `.wslconfig` templates |
| `integrations/magentic/` | Magentic adapter notes |
| `.ropex/state.json` | Local cluster state (etcd stand-in) |
