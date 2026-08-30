# Live hermes-agent wiring

Ropex plans through `createHermes` (`src/hermes.ts`) — soul, MemoryPort, skills, and a closed learn loop. The offline brain implements `HermesContract` so UI and runtime share one interface.

## Contract

| Piece | Role |
| --- | --- |
| `createHermes(spec)` | Embedded brain (default for tests / demo) |
| `HermesContract` | `plan` / `remember` / `learn` + MemoryPort |
| `liveHermesScaffold()` | Checklist; `liveReady: false` until process/RPC lands |
| DeepSeek execute | Hermes plans; dsh/harness runs tools (see [dsh.md](./dsh.md)) |

Live hermes-agent is a **future process/RPC seam**. Do not require network or the package in CI.

## Install

```bash
npm install          # core only — embedded Hermes by default
```

Install `hermes-agent` only when enabling live mode (`ROPEX_HERMES_BACKEND=live`). It is not part of the default `npm install` (keeps installs fast and network-light).

## Steps to wire live

1. Optional peer: `npm install hermes-agent` (never a hard CI dependency).
2. Implement `createLiveHermes(spec)` returning `HermesContract` over stdio/RPC.
3. Load `hermes.soul` (SOUL.md path) into the live process identity.
4. Bridge MemoryPort to `SharedMemoryStore` with the same scope rules.
5. Prove plan→learn parity against `createHermes()` in a sandbox.
6. Keep offline `createHermes()` as the default.

## Env

```
ROPEX_HERMES_BACKEND=embedded|live
HERMES_AGENT_BIN=(live only)
```

## Surfaces

- Control-plane UI DeepSeek/Hermes section (`view.hermesLive`)
- `liveHermesScaffold()` for docs/CLI checks

See [architecture.md](./architecture.md), [control-plane-ui.md](./control-plane-ui.md), and [dsh.md](./dsh.md).
