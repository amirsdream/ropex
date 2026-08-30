# Operations — spin up, spin down, deploy

How to run the Ropex control plane locally or in a container. For architecture see [system-architecture.md](./system-architecture.md).

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

Environment: `ROPEX_PORT` (default `7780`).

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

- [Control-plane UI](./control-plane-ui.md) — dashboard tabs, teal live refresh
- [HTTP API](./api.md) — full route list
- [Architecture](./architecture.md) — what “up” reconciles
