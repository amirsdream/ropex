# Live DeepSeek Harness (dsh) wiring

Ropex executes Hermes plans through `bootDsh` (`src/dsh.ts`). Today the default backend is **simulated** so every test and `ropex demo` stays network-free.

## Contract

| Piece | Role |
| --- | --- |
| `DSH_PROFILE_PACKS` | Canonical minimal/code/standard/creator packs (tools + Cordis plugin ids) |
| `bootDsh(spec, { backend })` | Returns `DshAdapter` — same shape for simulated and future live |
| `liveDshScaffold()` | Checklist + env hints; `liveReady: false` until live lands |
| Policy admission | Deny / requireApproval stay in front of tools (permissions plugin) |

`backend: "live"` **fails closed** with an error that points at the next scaffold step. Do not call network APIs from tests.

## Install

```bash
npm install          # small footprint — simulated backends only
npm test
```

Do **not** install `@deepseek-ai/dsh` unless you need live mode. That package pulls dozens of nested modules and can make `npm install` appear hung for minutes.

```bash
# live only (optional, after core install works)
npm install @deepseek-ai/dsh@^0.1.1-rc.2
```

## Steps to wire live

1. Install optional peer: `npm install @deepseek-ai/dsh` (never a hard CI dependency).
2. Implement `bootLiveDsh(spec)` returning `{ backend: "live", pack, kernel, execute }`.
3. Map `DSH_PROFILE_PACKS[profile].plugins` onto Cordis pack loaders.
4. Mount Policy deny/requireApproval before tool execution.
5. Prove one path: `ropex run --root sandbox` with `ROPEX_DSH_BACKEND=live`.
6. Keep `simulated` as the default for demos and vitest.

## Env

```
ROPEX_DSH_BACKEND=simulated|live
DEEPSEEK_API_KEY=(live only)
```

## Surfaces

- Control-plane UI **DeepSeek harness** section (from `/api/v1/view`.dsh)
- `liveDshScaffold()` for CLI/docs/programmatic checks

See also [architecture.md](./architecture.md), [control-plane-ui.md](./control-plane-ui.md), and [executor-api.md](./executor-api.md).
