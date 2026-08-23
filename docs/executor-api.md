# Ropex executor API

Engine-neutral HTTP + SSE contract for external orchestrators (e.g. [Magentic](https://github.com/amirsdream/Magentic)). Ropex remains the execution control plane; clients stay in separate repos and call this API.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/v1/pipeline` | Submit a prompt (optional explicit stages) |
| `GET` | `/api/v1/pipeline?id=<uuid>` | Fetch pipeline status |
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
  "concurrency": 2,
  "agents": ["researcher", "synthesizer"],
  "stages": [
    { "id": "research", "agent": "researcher", "role": "researcher", "prompt": "Gather sources…" }
  ]
}
```

- **`prompt`** (required): user task; used by the built-in heuristic planner when `stages` is omitted.
- **`stages`** (optional): explicit stage list; skips heuristic planning.
- **`drain`** (default `true`): run queued stages before returning.
- **`concurrency`**: parallel drain workers (bounded by policy).

Response:

```json
{
  "ok": true,
  "pipeline": {
    "id": "…",
    "status": "done",
    "stages": [ … ],
    "output": "…"
  },
  "drained": 3
}
```

## Event stream

Native executor events (`kind`):

| `kind` | Meaning |
|--------|---------|
| `pipeline.start` | Run accepted |
| `pipeline.plan` | Stage plan ready |
| `stage.start` | Stage enqueued / running |
| `stage.log` | Mid-stage log line |
| `stage.complete` | Stage finished |
| `pipeline.complete` | All stages done |
| `pipeline.error` | Run failed |

With `format=ui`, events map to Magentic WebSocket names:

| Ropex `kind` | UI `type` |
|--------------|-----------|
| `pipeline.plan` | `plan` |
| `stage.start` | `agent_start` |
| `stage.log` | `agent_log` |
| `stage.complete` | `agent_complete` |
| `pipeline.complete` | `complete` |
| `pipeline.error` | `error` |

## Magentic integration

Set in Magentic `.env`:

```env
EXECUTION_ENGINE=ropex
ROPEX_BASE_URL=http://127.0.0.1:7780
```

Magentic relays SSE → WebSocket; LangGraph is not used when `EXECUTION_ENGINE=ropex`.

## CLI

```bash
ropex apply fleets/
ropex pipeline "Implement auth middleware tests"
```
