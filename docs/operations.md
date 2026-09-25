# Operations — spin up, spin down, deploy

How to run the Ropex control plane locally or in a container. **First-time operators:** [quickstart.md](./quickstart.md). On Windows, provision the environment first with [wsl.md](./wsl.md). For architecture see [system-architecture.md](./system-architecture.md).

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
# Docker uses the same shape:
docker compose -f docker-compose.yml up --build -d
```

| File | Role |
| --- | --- |
| `Containerfile` | Control-plane image. `ROPEX_EXECUTOR=container`. CMD is `ropex up --serve` |
| `Containerfile.worker` | Base image `ropex-worker:latest`. Sessions are thin layers on top of it |
| `docker-compose.yml` | `worker` builds the base and exits; `control-plane` serves :7780 |
| `podman-compose.yml` | Same stack, for `podman compose` |

`npm run up` tries Podman Compose, then Docker Compose, then a local `tsx` process.

The control plane mounts the container socket and builds `ropex-session:<id>` per plan. That image is deleted after learn. The base image stays. Full walkthrough: [ephemeral sessions](./ephemeral-sessions.md). Compose forwards `ROPEX_HERMES_BACKEND`, `ROPEX_DSH_BACKEND`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, and `ROPEX_PIPELINE_PLANNER`. The control-plane image still omits the live CLI packages.

### Container sessions without Compose

Compose is optional. On a machine that already has Podman or Docker:

```bash
podman machine start    # macOS Podman only; skip when the machine is already running
podman build -t ropex-worker:latest -f Containerfile.worker .

# .env — restart after editing. Enabling the flag does not build the image.
# ROPEX_EXECUTOR=container

npx tsx src/cli.ts up fleets/examples/github-control-plane.yaml --serve --port 7780
```

`ROPEX_CONTAINER_BIN` forces `docker` or `podman`. Unset, Ropex uses whichever binary is on `PATH`, Docker first.

### Environment

| Variable | Effect |
| --- | --- |
| `ROPEX_PORT` / `--port` | Dashboard port (default 7780) |
| `ROPEX_EXECUTOR` | `container` for one image per plan. Unset or anything else stays in-process |
| `ROPEX_WORKER_IMAGE` | Base image (default `ropex-worker:latest`) |
| `ROPEX_CONTAINER_BIN` | `docker` or `podman` |
| `ROPEX_HERMES_BACKEND` | `embedded` (default) or `live` |
| `ROPEX_DSH_BACKEND` | `embedded` (default) or `live` |
| `OPENAI_API_KEY` | Preferred model key. Forwarded into the session. Never baked into the image |
| `DEEPSEEK_API_KEY` | Fallback key |
| `OPENAI_MODEL`, `OPENAI_BASE_URL` | Override the chat model and endpoint |

`hermes-agent` and `@deepseek-ai/dsh` are `optionalDependencies`. `npm install` may pull them. `npm install --omit=optional` and the control-plane image (`npm ci --omit=optional`) skip them. Embedded Hermes and the embedded harness still run. Live CLI mode is documented in [hermes.md](./hermes.md) and [dsh.md](./dsh.md).

`.env` is loaded at startup and is not committed. Restart the process after changing it.

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

`scripts/live-up.sh` sets `ROPEX_HERMES_BACKEND=live` and `ROPEX_DSH_BACKEND=live` and skips Compose so host `node_modules` are used. It does not turn off `ROPEX_EXECUTOR=container` if that is already in `.env`: plans still get a session, and Hermes memory still stays on the control plane. Full steps: [quickstart.md](./quickstart.md).

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
- [Ephemeral sessions](./ephemeral-sessions.md) — one image per plan
- [WSL setup](./wsl.md) — Windows dev environment, `npm run wsl:setup`
- [Control-plane UI](./control-plane-ui.md) — dashboard tabs, teal live refresh
- [HTTP API](./api.md) — full route list
- [Architecture](./architecture.md) — what “up” reconciles
