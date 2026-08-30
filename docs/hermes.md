# Hermes wiring

Ropex plans through `createHermes` (`src/hermes.ts`) — soul, MemoryPort, skills, and a closed learn loop. The **embedded** brain implements `HermesContract` so UI, tests, and runtime share one interface.

`bootDsh` **requires** a Hermes instance — plan and execute are always coupled.

## Contract

| Piece | Role |
| --- | --- |
| `createHermes(spec)` | Embedded brain (default; network-free) |
| `bootHermes(spec)` | Same; fails closed for `live` when package missing |
| `HermesContract` | `plan` / `remember` / `learn` + MemoryPort |
| `liveHermesScaffold()` | Checklist for optional `hermes-agent` CLI |
| DeepSeek execute | Hermes plans; `bootDsh({ hermes })` runs tools (see [dsh.md](./dsh.md)) |

## Backends

| Mode | Env | Behavior |
| --- | --- | --- |
| **embedded** (default) | — | In-process `createHermes()` |
| **live** (optional) | `ROPEX_HERMES_BACKEND=live` | Spawns `hermes-agent` CLI for `plan()` |

Live hermes-agent is an **optional seam**. CI and `npm test` use embedded only.

## Install

```bash
npm install          # embedded Hermes — no extra packages
```

```bash
npm install hermes-agent   # only for live mode
export ROPEX_HERMES_BACKEND=live
```

## Steps to wire live

1. Optional peer: `npm install hermes-agent`.
2. Set `ROPEX_HERMES_BACKEND=live`.
3. `bootHermes()` invokes hermes-agent CLI for `plan()`; harness still executes via dsh.
4. Bridge MemoryPort to `SharedMemoryStore` (same scopes as embedded).
5. Prove plan→learn parity with embedded brain in sandbox.

## Env

```
ROPEX_HERMES_BACKEND=embedded|live
HERMES_AGENT_BIN=(live only)
```

## Surfaces

- Control-plane UI Hermes section (`view.hermesLive`)
- `liveHermesScaffold()` for docs/CLI checks

See [architecture.md](./architecture.md), [control-plane-ui.md](./control-plane-ui.md), [dsh.md](./dsh.md), and [operations.md](./operations.md).
