# Ropex

Git is the control plane. Agents are the workload. **The queue is pluggable** — native UI/API inbox (no external forge), git Task YAML, CLI, optional GitHub webhooks, or the **executor API** for external orchestrators like Magentic.

The name is from **RoPE** (rotary position embeddings) — the trick that lets a transformer keep many tokens in one coherent sequence. Ropex does the same for agents: one git sequence, many workers in position.

Each worker is **DeepSeek Harness** (Cordis plugin kernel) plus **Hermes** (soul, memory, skills, closed learning loop). You declare desired state in git; a controller derives immutable workers; they reconcile toward it.

## System architecture

![Ropex architecture — git desired state → ingress → control plane → ephemeral workers → the start · transform · result spine → delivery](./docs/architecture.png)

> Source: [`docs/architecture.excalidraw`](./docs/architecture.excalidraw) — open in [Excalidraw](https://excalidraw.com) to edit. Regenerate the PNG with `node scripts/gen-arch-excalidraw.mjs`.

Top to bottom: git desired state → work ingress (GitHub webhooks with **HMAC + rate limit**, CLI, executor API) → control plane (controller · queue · executor · tick) → ephemeral workers claimed by a **bounded drain** → the **start → transform → result** spine → delivery.

**An interaction resolves a fleet, then runs it.** If a definition already exists, the run reuses it — that is how a repeatable task keeps its agents, caps, and Hermes memory. If none exists, the run mints an in-flight fleet and throws the workers away when it finishes. Pinning writes the definition back to git so the next run reuses it. Git is that reflection, not a form you fill in before the first prompt.

**Scale is a concurrency commit:** raise `maxConcurrent` (on-demand) or `replicas` (static). `Policy.maxReplicas` caps blast radius. Workers spawn on request and destroy when idle — memory stays on the agent/fleet bus. With `ROPEX_EXECUTOR=container`, each plan is one session image that every step shares; the image is deleted after learn. Operators pause, drain, run pipelines, and follow Hermes against DeepSeek from CLI or [`ropex ui`](./docs/control-plane-ui.md). The lifetimes are written up in [architecture](./docs/architecture.md#three-lifetimes).

## Why this exists

Coding agents today are single-player. Ropex combines three proven ideas:

| Layer | Source | Ropex role |
| --- | --- | --- |
| Composable kernel | [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (Cordis) | Execute tool loops with profile packs |
| Durable brain | [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Plan, remember, learn skills |
| Fleet operations | GitOps (not a K8s clone) | Declare agent defs + concurrency caps; spawn/destroy on demand |

Ropex is the control plane that multiplies those runtimes across repos and optional GitHub — the way Kubernetes multiplied containers across clusters.

## Quick start

**Full step-by-step (embedded + live mode):** [docs/quickstart.md](./docs/quickstart.md).

**On Windows?** Provision WSL 2 first — one script installs the distro, Node, a
container runtime, dependencies, and runs the tests:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\wsl-bootstrap.ps1 -InstallWslConfig
```

Already inside a distro: `npm run wsl:setup`, then `npm run wsl:doctor`.
Details in [docs/wsl.md](./docs/wsl.md).

If `npm install` hangs, use the bootstrap script (skips the huge live DeepSeek tree):

Embedded (no network, no API keys):

```bash
npm install
npm test
npx tsx src/cli.ts demo --root /tmp/ropex-demo
npm run up                               # dashboard → http://127.0.0.1:7780
npm run down
```

If `npm install` hangs, cancel (`Ctrl+C`) and run `bash scripts/bootstrap.sh` (skips the huge live DeepSeek tree).

Live Hermes + DeepSeek (optional, local process — not the Compose image):

```bash
npm install @deepseek-ai/dsh@^0.1.1-rc.2 hermes-agent@^0.20.5
export OPENAI_API_KEY=sk-...             # preferred; DEEPSEEK_API_KEY is fallback
npm run live -- --check                  # fail-closed: packages + key
npm run live                             # http://127.0.0.1:7780  (forge-local.yaml)
```

```bash
# After the stack is up — executor API, git tasks, observability
npx tsx src/cli.ts pipeline "Summarize the repo layout"
npx tsx src/cli.ts apply fleets/examples/forge-local.yaml
npx tsx src/cli.ts tasks submit --agent docbot --drain "Review README for clarity"
npx tsx src/cli.ts trajectories --jsonl
npx tsx src/cli.ts health
```

`apply` reads YAML, expands fleets, applies policy, and writes `.ropex/state.json`. Soul/skills/harness edits change the **agent image digest** → reconcile retires old workers and boots new ones (immutable roll, not in-place mutation).

## Documentation

| Guide | Topics |
| --- | --- |
| [**Quick start**](./docs/quickstart.md) | Step-by-step run + **live mode** (`npm run live`) |
| [**Operations**](./docs/operations.md) | One-click `npm run up/down`, Podman or Docker, container sessions |
| [**Ephemeral sessions**](./docs/ephemeral-sessions.md) | One image per plan. Hermes plans, DeepSeek runs, the session is deleted |
| [**System architecture (visual)**](./docs/system-architecture.md) | Diagrams — layers, ingress, workflow, state, module map |
| [**Architecture**](./docs/architecture.md) | Kubernetes mapping, image digests, queue, workflow, executor layer |
| [**Control-plane UI**](./docs/control-plane-ui.md) | Now, Run, Plans, Fleet, and Results — follow Hermes against DeepSeek |
| [**HTTP API**](./docs/api.md) | All `/api/v1/*` routes |
| [**Executor API**](./docs/executor-api.md) | Pipelines, SSE events, Magentic contract |
| [**Forge-neutral tasks**](./docs/forge-neutral.md) | Task YAML without GitHub |
| [**Hermes wiring**](./docs/hermes.md) | Embedded brain vs live `hermes-agent` |
| [**DeepSeek wiring**](./docs/dsh.md) | Embedded harness vs live `@deepseek-ai/dsh` |
| [**Worker runtimes**](./docs/worker-runtimes.md) | Swap the execute stage: dsh, Claude Code, Codex, Copilot |
| [**Magentic integration**](./integrations/magentic/README.md) | External chat UI → Ropex executor |
| [**Docs index**](./docs/README.md) | Full table of contents |

## Manifests

```yaml
apiVersion: ropex.dev/v1
kind: Fleet
metadata:
  name: pr-factory
spec:
  scale: onDemand
  maxConcurrent: 8
  idleTTLMs: 0
  template:
    spec:
      harness:
        profile: code          # minimal | code | standard | creator
        model: gpt-4o
        plugins: [github, fs, shell]
      hermes:
        soul: souls/builder.md
        memory: shared          # sqlite | none | shared
        share:
          read: [agent, fleet]
          write: agent
        learning: true
        skills: [implement-issue, open-pr]
      github:
        events: [issues.labeled]
        deliver: pull_request
      selector:
        matchLabels:
          org: acme
```

| Kind | Role |
| --- | --- |
| `GitRepo` | Where the controller pulls desired state |
| `Agent` | One named agent definition (Hermes + harness); `scale: onDemand` or `static` |
| `Fleet` | Template + concurrency (onDemand → one def; static → N derived agents) |
| `Policy` | Max live workers, permission denylist, optional budget |
| `Task` | Git-native work item ([forge-neutral](./docs/forge-neutral.md)) |
| `Memory` | Git-declared shared memory fact |

Example fleets: `fleets/examples/github-control-plane.yaml`, `forge-local.yaml`.

## Runtime split

**Hermes** (`src/hermes.ts`) — compose, plan, remember, learn. Soul + skills + scoped `MemoryPort`.

**DeepSeek Harness** (`src/dsh.ts`, `src/plugins.ts`) — Cordis-shaped kernel: loop mode, tools, permissions, delivery plugin. The default worker runtime.

**Pluggable executors** (`src/worker-runtime.ts`, `src/cli-runtimes.ts`) — `spec.runtime.kind` swaps the `execute` stage for an external headless coding agent (`claude -p`, `codex exec`, `copilot -p`) running in the worker worktree. Hermes still composes, plans, and learns; Ropex policy is translated into each CLI's own permission flags and fails closed when a runtime cannot express a denial. `ropex runtimes` reports what is usable. See [worker-runtimes.md](./docs/worker-runtimes.md).

**Ropex glue** — `src/runtime.ts` runs the fixed workflow; `src/scale.ts` + `src/queue.ts` spawn/destroy on-demand workers; `src/controller.ts` reconciles definitions; `src/executor.ts` runs multi-stage pipelines for external orchestrators.

**One spine, start → transform → result** — every run has an unambiguous shape: `compose`+`plan` (**Start**) → `execute` (**Transform**) → `deliver`+`learn` (**Result**). `workflowPhases()` groups the five stages onto that spine, and the executor pipeline mirrors it with typed boundaries — `input` (Start), `stages` (Transform), `result` (Result) — with `pipelinePhase(run)` reporting the live phase.

**Shared memory** — scoped (`worker` | `agent` | `fleet` | `cluster`) with `hermes.share` policy. Contracts in `src/contracts.ts`; store in `src/memory.ts`.

```mermaid
flowchart LR
  subgraph Hermes["Hermes — brain"]
    C["compose"] --> P["plan"]
    P --> L["learn"]
  end
  subgraph DS["DeepSeek — kernel"]
    X["execute"] --> D["deliver"]
  end
  P --> X --> D --> L
```

## Executor API + external UI

Ropex exposes an engine-neutral HTTP + SSE contract so **Magentic** (or any client) can orchestrate without embedding LangGraph:

```bash
ropex ui   # POST /api/v1/pipeline + GET /api/v1/events on :7780
```

Flow: submit prompt → plan stages → scoped sequential drain → stream `{ type, data }` events → terminal `pipeline.end`.

See [executor-api.md](./docs/executor-api.md) and [integrations/magentic/README.md](./integrations/magentic/README.md).

The built-in **control-plane UI** is a Vite + React SPA. **Run** follows Hermes handing each step to DeepSeek. **Plans** shows whether the fleet was reused or minted. **Fleet** keeps the pin and the memory. **Results** is what the plan sent back. See [control-plane-ui.md](./docs/control-plane-ui.md).

![Run — Hermes learning while DeepSeek has finished deliver](./docs/img/dashboard-follow.png)

## GitHub as optional agent OS

1. Human opens an issue (or labels it).
2. Controller matches `github.events` + selectors.
3. Idle worker runs Hermes→DeepSeek workflow.
4. Delivery writes comment, check, or pull request.
5. Hermes learning persists a skill for the next replica.

GitHub provides auth, review, CI, and blame. Ropex uses that instead of inventing another agent console. For non-GitHub forges, use [Task YAML](./docs/forge-neutral.md).

## Project layout

```
fleets/           Desired state YAML
Containerfile     Container image for control plane
podman-compose.yml
scripts/          stack-up.sh, stack-down.sh, bootstrap.sh, live-up.sh
src/
  stack.ts        One-click up/down
  controller.ts   GitOps reconciler
  scheduler.ts    Queue drain + leases
  runtime.ts      Per-task workflow
  executor.ts     Pipeline API + SSE
  api.ts          HTTP control plane + serves built SPA
  hermes.ts       Brain contract
  dsh.ts          Harness adapter
  contracts.ts    Shared types for CLI/API/UI
web/              Control-plane dashboard — Vite + React + TS SPA (→ dist/ui)
tests/            Network-free vitest suite
docs/             Architecture, API, wiring guides
integrations/     Magentic adapter notes
.ropex/           Local cluster state
```

## Status

| Area | Shipped |
| --- | --- |
| Immutable workers + image digests | yes |
| Hermes plan/learn + DeepSeek execute/deliver | yes (embedded backends) |
| Scoped shared memory + git sync/export | yes |
| Fair queue, leases, DLQ, retry, pause, affinity | yes |
| HMAC webhooks + rate limits | yes |
| Policy admission, budget, fan-out | yes |
| Trajectories, skills registry, audit trail | yes |
| Health probes + backlog SLO | yes |
| Control-plane UI (React SPA: monitoring + Hermes/DeepSeek console) | yes |
| **One-click stack** (`npm run up`, `ropex up/down`, UI Start/Stop) | yes |
| **Podman Compose** deploy (`Containerfile`, `podman-compose.yml`) | yes |
| **Executor API** (pipelines, SSE, scoped drain) | yes |
| **UI deep-dive** (pipelines, trajectories, agent surfaces) | yes |
| **UI live pipeline SSE** | yes |
| Remote git clone | yes (`--remote`) |
| Live `@deepseek-ai/dsh` / Hermes process | yes (`npm run live`; not default) |

Full capability matrix: [architecture.md](./docs/architecture.md). Roadmap log: [ideas.md](./docs/ideas.md).

## Policy for scale

Never spawn uncapped fleets. Always declare `Policy.maxReplicas`. The controller derives workers — do not hard-code replica lists in application code.

## License

[MIT](./LICENSE)
