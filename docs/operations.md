# Operations — spin up, spin down, deploy

How to run the Ropex control plane locally or in a container. **First-time operators:** [quickstart.md](./quickstart.md) (embedded + live mode). For architecture see [system-architecture.md](./system-architecture.md).

## One-click (recommended)

```bash
npm install
npm run up      # Podman Compose → http://127.0.0.1:7780
npm run down    # tear down
```

`scripts/stack-up.sh` prefers **Podman Compose**, falls back to **Docker Compose**, then runs `ropex up --serve` locally if neither is available.

## CLI stack commands

```bash
# Apply default fleet, resume queue, run one drain tick
npx tsx src/cli.ts up fleets/examples/github-control-plane.yaml

# Same + serve dashboard (blocks until killed)
npx tsx src/cli.ts up fleets/examples/github-control-plane.yaml --serve --port 7780

# Pause queue, destroy idle on-demand workers
npx tsx src/cli.ts down
```

| Command | Effect |
| --- | --- |
| `stack up` | `apply` manifest → `resume` queue → optional `tick` drain |
| `stack down` | `pause` queue → sweep idle on-demand workers |

State is tracked in `.ropex/state.json` under `stack.status` (`up` \| `down` \| `starting` \| `stopping`).

## Dashboard controls

Open http://127.0.0.1:7780 and use **Start** / **Stop** in the top bar. These call `POST /api/v1/stack` with `{ "action": "up" | "down" }`.

## Podman / Docker Compose

```bash
podman compose -f podman-compose.yml up --build -d
podman compose -f podman-compose.yml down
```

| File | Role |
| --- | --- |
| `Containerfile` | Node 22 image; CMD runs `ropex up --serve` |
| `podman-compose.yml` | Service on port 7780, volume `ropex-state` for `.ropex/` |

Environment: `ROPEX_PORT` (default `7780`). Compose also forwards `ROPEX_HERMES_BACKEND`, `ROPEX_DSH_BACKEND`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, and `ROPEX_PIPELINE_PLANNER` (the default image still runs **embedded** backends).

## API

```bash
curl -s http://127.0.0.1:7780/api/v1/stack | jq .

curl -s -X POST http://127.0.0.1:7780/api/v1/stack \
  -H 'content-type: application/json' \
  -d '{"action":"up","tick":false}' | jq .

curl -s -X POST http://127.0.0.1:7780/api/v1/stack \
  -H 'content-type: application/json' \
  -d '{"action":"down"}' | jq .
```

## Live mode (host process)

The Compose image is **embedded-only**. To plan with `hermes-agent` and execute with `@deepseek-ai/dsh`:

```bash
npm install @deepseek-ai/dsh@^0.1.1-rc.2 hermes-agent@^0.20.5
export OPENAI_API_KEY=sk-...
npm run live -- --check
npm run live            # forge-local.yaml → http://127.0.0.1:7780
```

`scripts/live-up.sh` sets `ROPEX_HERMES_BACKEND=live` and `ROPEX_DSH_BACKEND=live` and skips Compose so host `node_modules` are used. Full steps: [quickstart.md](./quickstart.md).

Compose still forwards those env vars if you bake live peers into a custom image (`ROPEX_HERMES_BACKEND`, `ROPEX_DSH_BACKEND`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`).

## Typical local workflow

```bash
npm install
npm test
npm run up
# dashboard → Start if stack shows Stopped
npx tsx src/cli.ts pipeline "Summarize fleet layout"
npx tsx src/cli.ts drain --concurrency 2
npm run down
```

## Related

- [Quick start](./quickstart.md) — embedded run + live mode
- [Control-plane UI](./control-plane-ui.md) — dashboard tabs, teal live refresh
- [HTTP API](./api.md) — full route list
- [Architecture](./architecture.md) — what “up” reconciles
