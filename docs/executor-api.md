# Ropex executor API

Engine-neutral HTTP + SSE contract for external orchestrators (e.g. [Magentic](https://github.com/amirsdream/Magentic)). Ropex remains the execution control plane; clients stay in separate repos and call this API.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/v1/pipeline` | Submit a prompt (optional explicit stages) |
| `POST` | `/api/v1/pipeline` `{ "action":"drain", "pipelineId" }` | Scoped sequential drain |
| `GET` | `/api/v1/pipeline?id=<uuid>` | Fetch pipeline status + persisted events |
| `GET` | `/api/v1/pipeline` | List recent pipelines (omit `id`) |
| `GET` | `/api/v1/events?pipelineId=<uuid>` | SSE stream of executor events |
| `GET` | `/api/v1/events?pipelineId=<uuid>&format=ui` | SSE with Magentic-compatible `{ type, data }` payloads |

Start the server with `ropex ui` (default port `7780`).

## Submit pipeline

```http
POST /api/v1/pipeline
Content-Type: application/json

{
  "prompt": "Compare React vs Vue for a dashboard",
  "drain": true,
  "agents": ["researcher", "synthesizer"],
  "stages": [
    { "id": "research", "agent": "researcher", "role": "researcher", "prompt": "Gather sources…" }
  ]
}
```

- **`prompt`** (required on submit): user task; used by the built-in heuristic planner when `stages` is omitted.
- **`stages`** (optional): explicit stage list; skips heuristic planning. Each `agent` must match a fleet `metadata.name`.
- **`drain`** (default `true`): run stages **sequentially** before returning.
- **`drain: false`**: plan only; call `{ "action": "drain", "pipelineId" }` later.

### Async drain (Magentic adapter)

```http
POST /api/v1/pipeline
{ "prompt": "…", "drain": false }

POST /api/v1/pipeline
{ "action": "drain", "pipelineId": "<uuid>" }
```

Drain claims only queue items whose task id starts with `<pipelineId>:` — other queue work is untouched.

## Sequential stages + context handoff

Stages run **one at a time**. Each stage's prompt is extended with prior stage outputs:

```
--- Prior stage outputs ---
[research/researcher]
…output…
```

## Event stream

Native executor events (`kind`):

| `kind` | Meaning |
|--------|---------|
| `pipeline.start` | Run accepted |
| `pipeline.plan` | Stage plan ready (includes `meta.agents` JSON for UIs) |
| `stage.start` | Stage enqueued / running |
| `stage.log` | Mid-stage log line |
| `stage.complete` | Stage finished |
| `stage.failed` | Stage dead-lettered |
| `pipeline.complete` | All stages done |
| `pipeline.error` | Run failed |
| `pipeline.end` | SSE stream terminal (closes subscribers) |

With `format=ui`, events map to Magentic WebSocket names (`plan`, `agent_start`, `agent_complete` with `error: true` on failure, `complete`, `error`, `stream_end`).

Events are persisted on `pipeline.events` (capped) in cluster state.

## Planners

| `ROPEX_PIPELINE_PLANNER` | Behavior |
|--------------------------|----------|
| `heuristic` (default) | Regex multi-stage planner in `src/pipeline.ts` |
| `hermes` | Seed stages from Hermes offline `plan()` on the first fleet agent |

Per-task execution still runs Hermes → harness inside `runTask()`. Progress hooks emit `stage.log` **before** `stage.complete` during drain.

## Magentic integration

```env
EXECUTION_ENGINE=ropex
ROPEX_BASE_URL=http://127.0.0.1:7780
```

Magentic submits with `drain: false`, opens SSE, then calls scoped pipeline drain. LangGraph is not used when configured.

## CLI

```bash
ropex apply fleets/
ropex pipeline "Implement auth middleware tests"
ropex pipeline "Plan only" --no-drain
```
