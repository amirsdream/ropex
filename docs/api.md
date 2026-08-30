# Ropex HTTP API (v1)

Stable routes from `API_ROUTES` in `src/contracts.ts`. All JSON unless noted. The local control plane has no auth — add authentication before exposing beyond localhost.

Serve everything with `ropex ui` or `npm run up` (teal dashboard + API on one port, default **7780**).

## Core routes

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/v1/health` | Worker probes + backlog SLO (`ok` / HTTP 503) |
| GET | `/api/v1/view` | Full control-plane UI model (`buildControlPlaneView`) |
| GET | `/api/v1/stack` | Stack lifecycle status (`up` / `down` / `starting` / `stopping`) |
| POST | `/api/v1/stack` | `{ "action": "up" \| "down", "manifest"?, "tick"? }` |
| GET | `/api/v1/workers` | Live worker views |
| GET | `/api/v1/memory` | Shared memory (`?worker=`) |
| POST | `/api/v1/memory` | Sync / export / promote actions |
| GET | `/api/v1/tasks` | Task git inbox summary |
| GET | `/api/v1/queue` | Queue summary + items + dead letters |
| GET | `/api/v1/metrics` | JSON snapshot (`?format=prometheus`) |
| GET | `/api/v1/deliveries` | Delivery journal |
| GET | `/api/v1/outbound` | Outbound webhook intents (`?status=`) |
| GET | `/api/v1/skills` | Learned + registry skills |
| POST | `/api/v1/skills` | Promote/share (`{ action, name, to? }`) |
| GET | `/api/v1/trajectories` | List trajectories (`?agent=&limit=`) |
| GET | `/api/v1/trajectories?id=<id>` | **Single trajectory** (plan, steps, output) |
| GET | `/api/v1/trajectories?format=jsonl` | NDJSON export |
| GET | `/api/v1/approvals` | Approval requests |
| POST | `/api/v1/approvals` | Decide (`{ id, decision: approved\|rejected }`) |
| GET | `/api/v1/audit` | Audit trail (`?kind=&format=jsonl`) |
| GET | `/api/v1/autoscale` | GitOps scale recommendations |
| GET | `/api/v1/budget` | Policy.budget spend windows |
| GET | `/api/v1/drift` | Live vs desired config drift |
| GET | `/api/v1/fairness` | Queue latency + LRU fairness |
| GET | `/api/v1/clone` | GitRepo clone progress |
| GET | `/api/v1/affinity` | Sticky worker bindings |
| GET | `/api/v1/ratelimits` | Webhook rate-limit buckets |
| GET | `/api/v1/canary` | Digest canary rollout progress |
| GET/POST | `/api/v1/hygiene` | Pool report; run reclaim\|gc\|age\|all |
| GET/POST | `/api/v1/policy/simulate` | Fleet policy dry-run |

## Queue operator

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/v1/drain` | Drain status (concurrency, pending, paused) |
| PUT | `/api/v1/drain` | `{ "concurrency": N }` — persist preference |
| POST | `/api/v1/drain` | `{ "concurrency": N }` — run drain now |
| POST | `/api/v1/queue` | `{ "action": "pause" \| "resume" \| "retry", "id"?: "…" }` |

## Executor API (pipelines)

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/v1/pipeline` | Submit `{ prompt, drain?, stages?, agents? }` |
| POST | `/api/v1/pipeline` | Drain `{ "action": "drain", "pipelineId": "…" }` |
| GET | `/api/v1/pipeline` | List recent pipelines |
| GET | `/api/v1/pipeline?id=<uuid>` | Full pipeline + stages + persisted events |
| GET | `/api/v1/events?pipelineId=<uuid>` | SSE executor events (native `kind`) |
| GET | `/api/v1/events?pipelineId=<uuid>&format=ui` | SSE Magentic-shaped `{ type, data }` |

Full semantics: [executor-api.md](./executor-api.md).

### Example: submit and fetch

```bash
curl -s -X POST http://127.0.0.1:7780/api/v1/pipeline \
  -H 'content-type: application/json' \
  -d '{"prompt":"Compare React vs Vue","drain":true}' | jq .

curl -s 'http://127.0.0.1:7780/api/v1/pipeline?id=<uuid>' | jq .
```

### Example: SSE (UI / Magentic)

```bash
curl -N 'http://127.0.0.1:7780/api/v1/events?pipelineId=<uuid>&format=ui'
```

## View model highlights

`GET /api/v1/view` aggregates everything the UI renders:

| Field | Content |
| --- | --- |
| `stack` | Lifecycle: status, manifest, message, `queuePaused` |
| `workflow` | Fixed 5-stage pipeline owners |
| `workers` | Live replicas, digests, harness, worktrees |
| `hermes` / `harness` | Per-agent surface config |
| `hermesLive` / `dsh` | Backend readiness + scaffold hints |
| `queue` / `drain` | Pending items, concurrency, pause |
| `pipelines` | Recent executor runs |
| `trajectories` | Recent Hermes→DeepSeek runs |
| `memory` | Scoped facts |
| `drift` / `fairness` / `health` | Ops panels |

See [control-plane-ui.md](./control-plane-ui.md) for UI mapping.

## CLI equivalents

| API | CLI |
| --- | --- |
| `POST /api/v1/stack` `{ action: "up" }` | `ropex up [manifest]` |
| `POST /api/v1/stack` `{ action: "down" }` | `ropex down` |
| `npm run up` / `npm run down` | `scripts/stack-up.sh` / `stack-down.sh` (Podman Compose) |
| `POST /api/v1/pipeline` | `ropex pipeline "<prompt>"` |
| `POST /api/v1/drain` | `ropex drain --concurrency N` |
| `GET /api/v1/trajectories?format=jsonl` | `ropex trajectories --jsonl` |
| `GET /api/v1/health` | `ropex health` |
| `GET /api/v1/metrics?format=prometheus` | `ropex metrics --prometheus` |

## Related

- [Operations](./operations.md) — one-click up/down, Podman Compose
- [Architecture](./architecture.md)
- [Executor API](./executor-api.md)
- [Control-plane UI](./control-plane-ui.md)
