# Ropex architecture — Kubernetes for agents

Ropex is a GitOps orchestrator for agent fleets. Desired state lives in git. The controller derives **immutable workers** from agent code digests and runs a fixed **Hermes + DeepSeek Harness** workflow on each task.

## Big picture

```mermaid
flowchart TB
  subgraph Desired["Desired state (git)"]
    GR["GitRepo"]
    AG["Agent"]
    FL["Fleet"]
    PO["Policy"]
  end

  subgraph Queue["Work queue (GitHub)"]
    ISS["issues.*"]
    PR["pull_request.*"]
    CHK["checks"]
  end

  subgraph Control["Ropex control plane"]
    PARSE["parse manifests"]
    EXP["expand Fleet → DesiredAgent"]
    CAP["apply Policy.maxReplicas"]
    IMG["buildAgentImage → imageDigest"]
    REC["reconcile workers\ncreate / retire / roll"]
    STATE[".ropex/state.json"]
    PARSE --> EXP --> CAP --> IMG --> REC --> STATE
  end

  subgraph Data["Data plane"]
    W["Worker slot\nagent:replica + imageDigest"]
    RT["runTask"]
    W --> RT
  end

  Desired --> PARSE
  Queue -->|"match events + selectors"| RT
  REC -->|"immutable stamp"| W
  RT -->|"comment / check / PR"| Queue
```

## Control plane mapping

| Kubernetes | Ropex |
| --- | --- |
| Deployment / ReplicaSet | `Fleet` / `Agent` |
| Pod | Worker (one replica) |
| Container image digest | **Agent image digest** (soul + skills + harness + github) |
| etcd / cluster state | `.ropex/state.json` |
| Admission / ResourceQuota | `Policy` (maxReplicas + permission deny) |
| kubelet | Runtime (`runTask`) |
| Ingress / queue | GitHub events |

## Immutable agents (image = code state)

An **agent image** is a content-addressed snapshot of Hermes soul/memory/skills, DeepSeek profile/plugins/model, and GitHub delivery config.

`imageDigest = sha256(canonical payload)[:16]`

```mermaid
flowchart LR
  subgraph Code["Agent code / config"]
    SOUL["souls/*.md"]
    SK["skills[]"]
    HAR["harness.profile\nmodel · plugins"]
    GH["github.events\ndeliver"]
  end

  Code --> HASH["sha256 canonical JSON"]
  HASH --> DIG["imageDigest"]

  DIG --> W0["worker triage:0"]
  DIG --> W1["worker triage:1"]

  EDIT["edit soul or skills"] -.->|"new digest"| ROLL["retire old + create new"]
  ROLL --> W0
```

Reconcile rules:

1. Desired replicas grow → **create** workers stamped with the current digest.
2. Desired replicas shrink → **retire** excess workers.
3. Digest changes → **retire old + create new** under the same slot id (no in-place mutation of harness/plugins/model).
4. Learned skills ride along as a **volume** across rolls; they do not change the digest.

```mermaid
stateDiagram-v2
  [*] --> pending: create(digest=D)
  pending --> running: reconcile
  running --> idle: runTask done
  idle --> running: next task
  idle --> retired: scale down OR digest≠D'
  running --> failed: error
  failed --> retired: reconcile
  retired --> [*]
```

## Workflow — best of Hermes and DeepSeek

Ropex does not invent a third agent loop. It schedules a fixed pipeline that keeps each system's strongest attributes.

```mermaid
flowchart LR
  subgraph Hermes["Hermes — brain"]
    C["1. compose\nSOUL · memory · skills"]
    P["2. plan\nwhat to do"]
    L["5. learn\ntrajectory → skill"]
  end

  subgraph DeepSeek["DeepSeek Harness — kernel"]
    X["3. execute\nCordis loop · tools · profile"]
    D["4. deliver\ncomment · check · PR"]
  end

  C --> P --> X --> D --> L
```

| Stage | Owner | Why |
| --- | --- | --- |
| `compose` | Hermes | SOUL / memory / skills are Hermes pillars |
| `plan` | Hermes | Brain decides *what* to do |
| `execute` | DeepSeek | Cordis loop + tools + profile (`tool-calls` / `code`) |
| `deliver` | DeepSeek | Delivery plugin → comment / check / PR |
| `learn` | Hermes | Distill trajectory → skill for the next replica |

### Task sequence

```mermaid
sequenceDiagram
  autonumber
  participant GH as GitHub
  participant CP as Controller
  participant W as Worker
  participant H as Hermes
  participant DS as DeepSeek Harness

  GH->>CP: issues.labeled
  CP->>W: pick idle worker (digest match)
  W->>H: compose + plan(task)
  H-->>W: tool program
  W->>DS: loop.run(calls) + permissions
  DS-->>W: trajectory
  W->>DS: deliver(summary)
  DS-->>GH: comment / check / PR
  W->>H: learn(trajectory)
  H-->>W: optional learned skill
  W-->>CP: idle + state update
```

## Worker lifecycle

`pending → running → idle → (retired | failed)`

- Reconcile stamps `running` on create.
- `runTask` requires worker digest == desired image digest (drift fails closed).
- After a task, worker returns to `idle`.
- Spec shrink or image roll marks the old worker `retired` (kept in history).

## What is still simulated

Tools, delivery, memory backend, GitRepo watch, live `@deepseek-ai/dsh`, and live Hermes. The contracts above are the seams those live adapters plug into.

## License

Ropex is licensed under the [GNU Affero General Public License v3](../LICENSE) (`AGPL-3.0-only`).
