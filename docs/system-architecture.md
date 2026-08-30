# Ropex system architecture (visual)

Visual reference for how Ropex is structured today. Diagrams render in GitHub, VS Code, and `ropex ui` markdown viewers.

For narrative detail see [architecture.md](./architecture.md). For API contracts see [api.md](./api.md) and [executor-api.md](./executor-api.md).

---

## At a glance

Ropex is a **GitOps control plane for agent fleets**:

- **Git** holds agent definitions, policy caps, tasks, and memory — not warm replica inventory.
- The **controller** reconciles immutable agent images (content-addressed digests).
- The **queue** admits work, spawns ephemeral workers on demand, and destroys them when idle.
- Each task runs a fixed **Hermes → DeepSeek** workflow: plan/remember/learn vs execute/deliver.
- **Memory and skills** survive worker death on a scoped shared bus.

```mermaid
flowchart LR
  GIT["Git YAML"] --> CTRL["Controller"]
  CTRL --> STATE[".ropex/state.json"]
  INGRESS["Work ingress"] --> QUEUE["Queue"]
  QUEUE --> WORKER["Ephemeral worker"]
  WORKER --> WF["Hermes + DeepSeek"]
  WF --> DELIVER["Comment / check / PR"]
  WF --> LEARN["Memory + skills"]
```

---

## Repository layout

```mermaid
flowchart TB
  subgraph Repo["ropex/"]
    FLEETS["fleets/**/*.yaml"]
    TASKS["tasks/*.yaml"]
    MEMORY["memory/*.yaml"]
    SRC["src/ — TypeScript control plane"]
    UI["src/ui/ — dashboard"]
    TESTS["tests/ — vitest suite"]
    DOCS["docs/ — guides"]
    INTEG["integrations/magentic/"]
    STATE[".ropex/state.json"]
    CLI["src/cli.ts → ropex"]
  end

  FLEETS -->|"desired state"| SRC
  TASKS -->|"work items"| SRC
  MEMORY -->|"shared facts"| SRC
  SRC --> STATE
  SRC --> UI
  CLI --> SRC
```

| Path | Role |
| --- | --- |
| `fleets/**/*.yaml` | `Agent`, `Fleet`, `Policy`, `GitRepo` manifests |
| `tasks/*.yaml` | Forge-neutral work inbox |
| `memory/*.yaml` | Git-declared shared memory facts |
| `src/` | Control plane implementation (~58 modules) |
| `src/ui/` | Static control-plane dashboard (`ropex ui`) |
| `.ropex/state.json` | Local cluster state (etcd stand-in) |
| `integrations/magentic/` | External UI adapter notes |

---

## End-to-end system

```mermaid
flowchart TB
  subgraph Git["Git — source of truth"]
    GR["GitRepo"]
    AG["Agent / Fleet"]
    PO["Policy"]
    TK["Task YAML"]
    MF["Memory YAML"]
  end

  subgraph Ingress["Work ingress"]
    GH["GitHub webhooks"]
    TSK["tasks sync"]
    CLI_IN["CLI enqueue"]
    EXT["POST /api/v1/pipeline"]
  end

  subgraph Control["Ropex control plane"]
    PARSE["parse + expand<br/>spec.ts"]
    IMG["buildAgentImage<br/>image.ts"]
    REC["reconcile<br/>controller.ts"]
    Q["queue + scheduler<br/>queue.ts · scheduler.ts"]
    SCALE["spawn / destroy<br/>scale.ts"]
    EXEC["pipelines + SSE<br/>executor.ts · pipeline.ts"]
    TICK["heartbeat<br/>tick.ts"]
    API["HTTP + UI<br/>api.ts · ui/"]
    STATE[".ropex/state.json"]
  end

  subgraph Worker["Ephemeral worker"]
    WT["isolated worktree<br/>worktree.ts"]
    RT["runTask<br/>runtime.ts"]
    WF["5-stage workflow<br/>workflow.ts"]
    H["Hermes<br/>hermes.ts"]
    DSH["DeepSeek Harness<br/>dsh.ts · plugins.ts"]
  end

  subgraph Durable["Survives worker death"]
    MEMBUS["SharedMemoryStore<br/>memory.ts"]
    SKILLS["skill registry<br/>skills.ts"]
    TRAJ["trajectories<br/>trajectory.ts"]
    JOURNAL["delivery journal<br/>journal.ts"]
    AUDIT["audit trail<br/>audit.ts"]
  end

  Git --> PARSE --> IMG --> REC --> STATE
  GH --> Q
  TSK --> Q
  CLI_IN --> Q
  EXT --> EXEC --> Q
  REC --> SCALE
  Q -->|"claim or spawn"| SCALE
  SCALE --> WT --> RT --> WF
  WF --> H
  WF --> DSH
  RT --> MEMBUS
  RT --> SKILLS
  RT --> TRAJ
  DSH --> JOURNAL
  Q --> AUDIT
  TICK --> Q
  API --> STATE
  API --> EXEC
```

---

## Five layers

```mermaid
flowchart TB
  subgraph L1["Layer 1 — GitOps desired state"]
    YAML["fleets/**/*.yaml"]
    SPEC["spec.ts"]
    CTRL["controller.ts"]
    IMAGE["image.ts"]
    WT["worktree.ts"]
    WATCH["watch.ts · gitrepo.ts · clone.ts"]
  end

  subgraph L2["Layer 2 — Scheduling + scale"]
    QUEUE["queue.ts"]
    SCH["scheduler.ts"]
    SCALE["scale.ts"]
    PLACE["placement.ts"]
    FANOUT["fanout.ts"]
    AFF["affinity.ts"]
  end

  subgraph L3["Layer 3 — Single-task runtime"]
    RT["runtime.ts"]
    WF["workflow.ts"]
    HERMES["hermes.ts"]
    DSH["dsh.ts · harness.ts · plugins.ts"]
  end

  subgraph L4["Layer 4 — Multi-stage executor"]
    PIPE["pipeline.ts"]
    EXEC["executor.ts"]
  end

  subgraph L5["Layer 5 — Surfaces"]
    CLI["cli.ts"]
    API["api.ts"]
    UI["ui/"]
    DEMO["demo.ts"]
  end

  subgraph GOV["Governance + ops (cross-cutting)"]
    ADM["admission · approval · policy"]
    BUD["budget.ts"]
    CAN["canary · snapshot · drift"]
    OBS["metrics · health · audit · trajectory"]
    LIFE["lifecycle · hygiene · tick"]
  end

  YAML --> SPEC --> CTRL
  CTRL --> IMAGE --> SCALE
  QUEUE --> SCH --> RT
  RT --> WF --> HERMES
  RT --> DSH
  PIPE --> EXEC --> QUEUE
  API --> CTRL
  API --> EXEC
  UI --> API
  CLI --> CTRL
  CLI --> EXEC
```

| Layer | Key modules | Responsibility |
| --- | --- | --- |
| 1 — GitOps | `spec`, `controller`, `image`, `worktree` | Parse YAML, expand fleets, stamp digests, reconcile |
| 2 — Schedule | `queue`, `scheduler`, `scale`, `placement` | Enqueue, claim/spawn, fair drain, leases, DLQ |
| 3 — Runtime | `runtime`, `workflow`, `hermes`, `dsh` | One task: compose → plan → execute → deliver → learn |
| 4 — Executor | `pipeline`, `executor` | Multi-agent sequential pipelines + SSE |
| 5 — Surfaces | `cli`, `api`, `ui` | Operate and observe without touching internals |

---

## Capacity model

Default scale is **on-demand**: workers spawn when work arrives and destroy when idle (`idleTTLMs: 0`). Opt into standing pools with `scale: static`.

```mermaid
flowchart LR
  subgraph GitDeclares["Git declares"]
    DEF["Agent definition<br/>soul · skills · harness"]
    CAP["maxConcurrent<br/>idleTTLMs: 0"]
    POL["Policy.maxReplicas<br/>cluster ceiling"]
  end

  subgraph Reconcile["controller.ts"]
    EXP["expand Fleet → DesiredAgent"]
    DIG["imageDigest<br/>sha256 canonical"]
    RECON["reconcile definitions<br/>no idle pool by default"]
  end

  subgraph OnClaim["queue claim"]
    ADMIT["admission + budget + placement"]
    SPAWN["spawnWorker if under cap"]
    CLAIM["claim idle worker"]
    RUN["runTask"]
    DESTROY["destroyWorker<br/>promote memory"]
  end

  DEF --> EXP --> DIG --> RECON
  CAP --> SPAWN
  POL --> SPAWN
  ADMIT --> SPAWN
  ADMIT --> CLAIM
  SPAWN --> RUN
  CLAIM --> RUN
  RUN --> DESTROY
```

| Mode | Git field | Reconcile | Claim |
| --- | --- | --- | --- |
| `onDemand` (default) | `maxConcurrent`, `idleTTLMs` | Definitions only | Spawn if under cap |
| `static` (opt-in) | `replicas` | Standing warm pool | Pick idle worker |

`Policy.maxReplicas` is the cluster ceiling on **live** workers — never uncapped spawn.

---

## Per-task workflow

Ropex does not invent a third agent loop. It schedules a fixed pipeline:

```mermaid
flowchart LR
  subgraph Hermes["Hermes — brain"]
    C["1 compose<br/>SOUL · memory · skills"]
    P["2 plan<br/>tool program"]
    L["5 learn<br/>trajectory → skill"]
  end

  subgraph DeepSeek["DeepSeek Harness — kernel"]
    X["3 execute<br/>Cordis loop · tools"]
    D["4 deliver<br/>comment · check · PR"]
  end

  C --> P --> X --> D --> L
```

| Stage | Owner | Module |
| --- | --- | --- |
| compose | Hermes | `hermes.ts` |
| plan | Hermes | `hermes.ts` |
| execute | DeepSeek | `dsh.ts`, `plugins.ts` |
| deliver | DeepSeek | `dsh.ts`, `journal.ts` |
| learn | Hermes | `hermes.ts`, `skills.ts` |

---

## Two work ingress paths

```mermaid
flowchart TB
  subgraph PathA["Path A — single task"]
    A1["GitHub event / Task YAML / CLI"]
    A2["enqueueTask"]
    A3["drainQueue"]
    A4["runTask"]
    A1 --> A2 --> A3 --> A4
  end

  subgraph PathB["Path B — multi-stage pipeline"]
    B1["POST /api/v1/pipeline"]
    B2["planPipeline"]
    B3["enqueue pipelineId:stageId"]
    B4["scoped drainQueue"]
    B5["SSE events"]
    B1 --> B2 --> B3 --> B4 --> B5
    B4 --> A4
  end

  MAG["Magentic / ropex ui"] --> B1
  GH2["GitHub webhook"] --> A1
```

**Path A** — one task, one worker, standard queue drain.

**Path B** — external orchestrator submits a prompt; Ropex plans sequential stages, drains only tasks matching `<pipelineId>:*`, and streams SSE events until `pipeline.end`.

---

## Worker lifecycle

```mermaid
stateDiagram-v2
  [*] --> pending: create(digest=D)
  pending --> idle: reconcile
  idle --> running: claim / spawn
  running --> idle: task done (static pool)
  running --> retired: onDemand destroy
  idle --> retired: scale down OR digest roll
  running --> failed: error
  failed --> retired: reconcile
  retired --> [*]
```

Each live worker gets an isolated **worktree** under `sandbox/worktrees/`. Digest drift fails closed — `runTask` requires worker digest == desired image digest.

---

## Cluster state

Everything operational lives in `.ropex/state.json`:

```mermaid
flowchart TB
  STATE["ClusterState"]
  STATE --> DES["desired[]<br/>agent definitions"]
  STATE --> WRK["workers[]<br/>pending · idle · running · retired"]
  STATE --> QUE["queue[]<br/>pending · claimed · done · dead"]
  STATE --> MEM["memory[]<br/>scoped facts"]
  STATE --> SK["skillRegistry[]"]
  STATE --> DEL["deliveries[]"]
  STATE --> TR["trajectories[]"]
  STATE --> AUD["audit[]"]
  STATE --> POL["policies[]"]
  STATE --> BUD["budgets[]"]
  STATE --> PIPE["pipelines[]<br/>+ pipeline.events"]
  STATE --> MISC["affinity · webhookSeen<br/>gitRepoStatus · metrics"]
```

---

## Kubernetes mapping

Ropex is GitOps-inspired, not a Kubernetes clone:

| Kubernetes | Ropex |
| --- | --- |
| Deployment / ReplicaSet | `Fleet` / `Agent` |
| Pod | Worker (one replica slot) |
| Container image digest | Agent image digest |
| etcd | `.ropex/state.json` |
| Admission / ResourceQuota | `Policy` (maxReplicas + denylist + budget) |
| kubelet | `runtime.ts` (`runTask`) |
| Ingress | GitHub events, Task YAML, executor API |

---

## External integrations

```mermaid
flowchart LR
  subgraph Clients
    GH["GitHub<br/>webhooks + delivery"]
    MAG["Magentic UI"]
    RUI["ropex ui :7780"]
    CLI2["ropex CLI"]
  end

  subgraph Ropex
    WH["webhook.ts"]
    API["api.ts /api/v1/*"]
    EX["executor.ts"]
  end

  subgraph Backends["Backends (embedded by default)"]
    H2["Hermes<br/>embedded / live seam"]
    D2["DeepSeek dsh<br/>embedded / live seam"]
  end

  GH --> WH --> API
  MAG --> API --> EX
  RUI --> API
  CLI2 --> API
  EX --> H2
  EX --> D2
```

Live backends are optional seams — see [hermes.md](./hermes.md) and [dsh.md](./dsh.md).

---

## Module quick reference

| Area | Files |
| --- | --- |
| Spec / reconcile | `spec.ts`, `controller.ts`, `image.ts`, `worktree.ts`, `watch.ts`, `gitrepo.ts`, `clone.ts`, `tick.ts`, `canary.ts`, `snapshot.ts`, `drift.ts` |
| Brain / execute | `hermes.ts`, `dsh.ts`, `harness.ts`, `plugins.ts`, `workflow.ts`, `runtime.ts` |
| Executor API | `pipeline.ts`, `executor.ts` |
| Memory / skills | `memory.ts`, `skills.ts`, `gitmemory.ts`, `contracts.ts` |
| Queue / scale | `queue.ts`, `scheduler.ts`, `scale.ts`, `fanout.ts`, `admission.ts`, `approval.ts`, `autoscale.ts`, `budget.ts`, `placement.ts`, `fairness.ts` |
| Ingress / audit | `webhook.ts`, `ratelimit.ts`, `journal.ts`, `deliver.ts`, `trajectory.ts`, `metrics.ts`, `health.ts`, `audit.ts` |
| Lifecycle | `lifecycle.ts`, `hygiene.ts`, `chaos.ts` |
| Surfaces | `api.ts`, `ui/`, `cli.ts`, `demo.ts` |

---

## View locally

```bash
# Open in browser after starting the control plane
npx tsx src/cli.ts apply fleets/examples/github-control-plane.yaml
npx tsx src/cli.ts ui    # http://127.0.0.1:7780
```

On GitHub, open this file directly — Mermaid diagrams render in the file preview.
