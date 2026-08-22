# Ropex HTTP API (v1)

Stable routes from `API_ROUTES` in `src/contracts.ts`. All JSON unless noted. Network-free control plane; no auth in the local stub.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/v1/health` | Worker probes + backlog SLO (`ok` / HTTP 503) |
| GET | `/api/v1/view` | Full control-plane UI model |
| GET | `/api/v1/workers` | Live worker views |
| GET | `/api/v1/memory` | Shared memory (`?worker=`) |
| GET | `/api/v1/queue` | Queue summary + items + dead letters |
| GET | `/api/v1/metrics` | JSON snapshot (`?format=prometheus`) |
| GET | `/api/v1/deliveries` | Delivery journal |
| GET | `/api/v1/outbound` | Outbound webhook intents (`?status=`) |
| GET | `/api/v1/skills` | Learned + registry skills |
| GET | `/api/v1/trajectories` | Trajectories (`?format=jsonl`) |
| GET | `/api/v1/approvals` | Approval requests |
| GET | `/api/v1/audit` | Audit trail (`?kind=&format=jsonl`) |
| GET | `/api/v1/autoscale` | GitOps scale recommendations |
| GET | `/api/v1/budget` | Policy.budget spend windows |
| GET | `/api/v1/drift` | Live vs desired config drift report |
| GET | `/api/v1/fairness` | Queue latency + LRU fairness report |
| GET | `/api/v1/clone` | Last GitRepo clone progress / fail-closed status |
| GET | `/api/v1/affinity` | Sticky worker affinity bindings |
| GET | `/api/v1/ratelimits` | Active webhook rate-limit buckets |
| GET/PUT/POST | `/api/v1/drain` | Drain status / set concurrency / run drain |
| POST | `/api/v1/queue` | Operator actions: `pause` \| `resume` \| `retry` |
| GET/POST | `/api/v1/policy/simulate` | Fleet policy dry-run (optional custom prompt) |
| POST | `/api/v1/approvals` | Decide pending approval (`{ id, decision }`) |

Serve with `ropex ui` (static UI + these routes on one port).
