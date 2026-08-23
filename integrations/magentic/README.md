# Magentic + Ropex integration

Magentic UI talks to Ropex for execution. Repos stay independent — contract is HTTP + SSE only.

## Ropex side

```bash
ropex apply fleets/
ropex ui   # http://127.0.0.1:7780
```

See [executor-api.md](../docs/executor-api.md).

## Magentic side

In Magentic `.env`:

```env
EXECUTION_ENGINE=ropex
ROPEX_BASE_URL=http://127.0.0.1:7780
```

Apply the adapter branch in the Magentic repo (`cursor/ropex-engine-4b15`):

- `src/engines/ropex_executor.py` — submit pipeline, SSE relay, scoped drain
- `src/config.py` — `EXECUTION_ENGINE`, `ROPEX_BASE_URL`
- `src/api.py` — bypass LangGraph when `EXECUTION_ENGINE=ropex`

Flow:

1. `POST /api/v1/pipeline` `{ prompt, drain: false }`
2. `GET /api/v1/events?pipelineId=&format=ui` (SSE)
3. `POST /api/v1/pipeline` `{ action: "drain", pipelineId }`
4. Relay `{ type, data }` events → Magentic WebSocket

## Role → fleet mapping

Ropex stages reference **fleet agent names** (`metadata.name` in Agent YAML), not Magentic display roles. Align names or POST explicit `stages` from Magentic’s coordinator plan.

## Optional planners

| Env | Effect |
|-----|--------|
| `ROPEX_PIPELINE_PLANNER=heuristic` | Default regex planner |
| `ROPEX_PIPELINE_PLANNER=hermes` | Seed stages from Hermes offline brain |
| `ROPEX_HERMES_BACKEND=live` | Per-task live hermes-agent (uses worker worktree cwd) |
