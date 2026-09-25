# Quick start — run Ropex, then live mode

This is the step-by-step operator guide. Default backends are **embedded** (in-process, no network, no API keys). **Live mode** swaps in the real `hermes-agent` CLI and `@deepseek-ai/dsh` harness.

Hermes and DeepSeek stay **coupled** in every mode: `bootHermes` → `bootDsh({ hermes })` → `runTask`. There is no simulation shortcut.

| Mode | When to use | Extra packages | API key |
| --- | --- | --- | --- |
| **Embedded** (default) | First run, tests, demos, CI | none | no |
| **Live** (optional) | Real plan + headless execute | `hermes-agent`, `@deepseek-ai/dsh` | **`OPENAI_API_KEY`** (preferred) or `DEEPSEEK_API_KEY` |

Related: [operations.md](./operations.md) (compose / stack API), [hermes.md](./hermes.md), [dsh.md](./dsh.md), [control-plane-ui.md](./control-plane-ui.md).

---

## Prerequisites

1. **Node.js 20+** (22 is what the container image uses). Check with `node -v`.
2. **npm** and **git**.
3. Optional for one-click containers: **Podman** or **Docker** with Compose.
4. Live mode only: an OpenAI key (or DeepSeek as fallback).

Clone the repo and work from the root:

```bash
git clone <this-repo-url> ropex
cd ropex
```

---

## Part 1 — Run the project (embedded)

Embedded mode is the supported default. It exercises the real control plane (apply → queue → drain → Hermes plan → DeepSeek execute → deliver) without calling an LLM.

### 1. Install core dependencies

`npm install` only pulls Ropex’s small tree (`yaml`, TypeScript, vitest). It does **not** install live backends.

```bash
npm install
```

If install hangs (usually a leftover optional `@deepseek-ai/dsh` tree), cancel (`Ctrl+C`) and bootstrap:

```bash
bash scripts/bootstrap.sh
```

### 2. Run the test suite (network-free)

```bash
npm test
```

Tests must pass without API keys. They always use embedded Hermes + embedded harness.

### 3. End-to-end sandbox (no dashboard)

```bash
npx tsx src/cli.ts demo --root /tmp/ropex-demo
```

You should see `demo complete` with worker / drain / delivery counts.

### 4. Start the control plane + dashboard

**One-click** (Podman Compose → Docker Compose → local `ropex up --serve`):

```bash
npm run up          # http://127.0.0.1:7780
```

Stop with:

```bash
npm run down
```

**Local process** (no container). `ropex up` without a path applies `fleets/examples/forge-local.yaml` (`docbot`):

```bash
npm run build:web   # Vite SPA → dist/ui (needed once for the dashboard)
npx tsx src/cli.ts up --serve --port 7780
```

`npm run up` via Compose uses `fleets/examples/github-control-plane.yaml` instead. Both are valid; forge-local is the simpler first fleet (no GitHub events).

Open:

- Dashboard: http://127.0.0.1:7780
- API view: http://127.0.0.1:7780/api/v1/view
- Health: http://127.0.0.1:7780/api/v1/health

In the UI, **Start** / **Stop** in the top bar map to `POST /api/v1/stack`. The **Run** tab shows Hermes and DeepSeek as `embedded` until you turn the live backends on.

### 5. Submit one unit of work

Scale is **on-demand**: apply writes agent *definitions*, then drain **spawns** a worker, runs the spine, and **destroys** it (`idleTTLMs: 0`). Prefer submit + drain over `ropex run` (that command needs an already-live worker).

```bash
# Apply the local fleet if you have not already (`up` does this)
npx tsx src/cli.ts apply fleets/examples/forge-local.yaml

# Native inbox → spawn → Hermes → DeepSeek → destroy
npx tsx src/cli.ts tasks submit --agent docbot --drain "Summarize the repo layout"

# Or a multi-stage pipeline (executor API)
npx tsx src/cli.ts pipeline "Summarize the repo layout"
```

From the dashboard: open **Run**, type a prompt, and press **Run prompt** (streams over SSE). **Simple pipeline** reuses the pinned triage and reviewer pair.

### 6. Inspect

```bash
npx tsx src/cli.ts status
npx tsx src/cli.ts queue
npx tsx src/cli.ts health
npx tsx src/cli.ts trajectories --jsonl
npx tsx src/cli.ts metrics --prometheus
```

---

## Part 2 — Quick start in live mode

Live mode is **opt-in and local**. The default Compose image does **not** ship `hermes-agent` or `@deepseek-ai/dsh` (those trees are huge and would stall `npm install`). Use `npm run live` (or the env vars below) on the host.

Live **fails closed**: missing package or missing API key throws instead of silently falling back. Hermes `plan()` is the exception — if the live CLI errors mid-plan it records the failure and uses the embedded planner so the rest of the spine can still run.

### 1. Finish Part 1 first

You need a working `npm install` and `npm test` before adding live peers.

### 2. Install live peers (optional, slow)

Do **not** add these to CI. `@deepseek-ai/dsh` can make `npm install` look stuck for minutes.

```bash
npm install @deepseek-ai/dsh@^0.1.1-rc.2 hermes-agent@^0.20.5
```

### 3. Export credentials and backends

```bash
export OPENAI_API_KEY=sk-...          # preferred — used when both are set
# export DEEPSEEK_API_KEY=...         # optional fallback

export ROPEX_HERMES_BACKEND=live      # plan() via hermes-agent CLI
export ROPEX_DSH_BACKEND=live         # execute via dsh --profile headless
```

Default harness model when YAML omits `harness.model` is `gpt-4o-mini`. `fleets/examples/github-control-plane.yaml` sets `gpt-4o` on some agents — override in YAML or keep the OpenAI key that can call that model.

Optional: `export ROPEX_PIPELINE_PLANNER=hermes` so executor pipelines seed stages from the Hermes brain instead of the heuristic planner.

### 4. Confirm readiness (no server)

```bash
npm run live -- --check
```

This checks Node ≥ 20, `node_modules`, both live packages, and an API key. Exit `0` means you can boot live; exit `1` prints the next missing step.

Equivalent without the script: open the dashboard **Run** tab later, or:

```bash
curl -s http://127.0.0.1:7780/api/v1/view | jq '{dsh, hermesLive}'
```

You want `backend: "live"`, `packageInstalled: true`, and for DeepSeek `apiKeyPresent: true` / `liveReady: true`.

### 5. Boot the live control plane

**One command** (skips Compose so the host `node_modules` and env vars are used):

```bash
npm run live
# → http://127.0.0.1:7780
# → http://127.0.0.1:7780/#services  (the Run tab)
```

That is `scripts/live-up.sh`: sets `ROPEX_HERMES_BACKEND=live` and `ROPEX_DSH_BACKEND=live`, applies `fleets/examples/forge-local.yaml`, serves the dashboard.

**Manual equivalent:**

```bash
npm run build:web
npx tsx src/cli.ts up fleets/examples/forge-local.yaml --serve --port 7780
```

Do **not** expect `npm run up` to run the live CLIs. The Compose image omits those packages and stays on the embedded harness. Plans still use one session image when `ROPEX_EXECUTOR=container`. Use `npm run live` on the host when you want the live Hermes and DeepSeek CLIs.

### 6. Prove one live path

With the live server running (another terminal, same env vars):

```bash
npx tsx src/cli.ts tasks submit --agent docbot --drain "List the top-level directories and say what each is for"
```

Or from **Run**: paste the same prompt → **Run prompt**. You should see a Hermes plan and a DeepSeek observation on the follow strip.

```bash
npx tsx src/cli.ts pipeline "Compare the embedded and live backend split in README"
npx tsx src/cli.ts trajectories --jsonl | tail -n 1
```

Trajectory steps from live dsh use plugin id `dsh-live`.

### 7. Switch back to embedded

```bash
unset ROPEX_HERMES_BACKEND ROPEX_DSH_BACKEND
# or:
export ROPEX_HERMES_BACKEND=embedded
export ROPEX_DSH_BACKEND=embedded
```

Leave the live npm packages installed; they are unused until backends are `live` again.

---

## Which command starts what

| Command | Backends | Fleet applied | Process |
| --- | --- | --- | --- |
| `npm test` | embedded | (none) | vitest |
| `npx tsx src/cli.ts demo` | embedded | sandbox demo | one-shot |
| `npm run up` | embedded in the default image | `github-control-plane.yaml` | Compose, else local `--serve` |
| `npx tsx src/cli.ts up --serve` | from env (default embedded) | `forge-local.yaml` | local dashboard |
| `npm run live` | **live** (fails closed) | `forge-local.yaml` | local dashboard |
| `npm run down` | — | — | Compose down, or pause + sweep |

Port: `ROPEX_PORT` (default `7780`).

---

## Environment reference

| Variable | Values | Effect |
| --- | --- | --- |
| `ROPEX_HERMES_BACKEND` | `embedded` (default) \| `live` | Hermes `plan()` via in-process brain or `hermes-agent` CLI |
| `ROPEX_DSH_BACKEND` | `embedded` (default) \| `live` | Harness via in-process Cordis or `dsh --profile headless` |
| `OPENAI_API_KEY` | secret | Preferred live LLM key |
| `DEEPSEEK_API_KEY` | secret | Live key fallback if OpenAI unset |
| `ROPEX_PIPELINE_PLANNER` | `heuristic` (default) \| `hermes` | How `POST /api/v1/pipeline` seeds stages |
| `ROPEX_PORT` | `7780` | Dashboard / API port |

Live dsh **requires** a key. Live Hermes does not use those keys directly (the hermes-agent CLI uses its own config); you still need a key for the coupled DeepSeek execute step.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `npm install` hangs | `Ctrl+C`, then `bash scripts/bootstrap.sh`. Do not install `@deepseek-ai/dsh` until you want live mode. |
| `dsh live backend unavailable` | `npm install @deepseek-ai/dsh@^0.1.1-rc.2` and set `ROPEX_DSH_BACKEND=live`. |
| `dsh live backend requires OPENAI_API_KEY…` | Export `OPENAI_API_KEY` or `DEEPSEEK_API_KEY`. |
| `hermes live backend unavailable` | `npm install hermes-agent@^0.20.5` and set `ROPEX_HERMES_BACKEND=live`. |
| `no live worker for agent …` on `ropex run` | On-demand fleets have no standing pool. Use `tasks submit --agent <name> --drain "…"` or `pipeline`. |
| Compose dashboard is still `embedded` | Expected. `npm run up` image has no live peers. Use `npm run live` on the host. |
| Dashboard is a blank API JSON page | Run `npm run build:web` so `dist/ui` exists, then restart `up` / `live`. |
| Port already in use | `ROPEX_PORT=7781 npm run live` (or `--port 7781`). |
| Tests suddenly hit the network | Unset `ROPEX_*_BACKEND=live` and API keys in the test shell. CI must stay embedded. |

---

## What “live” does not change

- Desired state still lives in `fleets/**/*.yaml` (definitions + policy caps, not replica lists).
- `Policy.maxReplicas` still caps spawn. Never run uncapped.
- Memory and skills still outlive workers (`src/memory.ts`, skill registry).
- Ingress is still GitHub / Task YAML / CLI / executor API; delivery is still comment / check / PR / git writeback.
- `npm test` stays network-free. Do not make live packages a hard dependency.
