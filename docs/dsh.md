# Live DeepSeek Harness (dsh) wiring

Ropex executes Hermes plans through `bootDsh` (`src/dsh.ts`). The default backend is **embedded** (in-process Cordis harness) so every test and `ropex demo` runs the real Hermes→DeepSeek split without external packages.

## Contract

| Piece | Role |
| --- | --- |
| `DSH_PROFILE_PACKS` | Canonical minimal/code/standard/creator packs (tools + Cordis plugin ids) |
| `bootDsh(spec, { hermes })` | Returns `DshAdapter` — requires Hermes; embedded or live |
| `liveDshScaffold()` | Checklist + env hints for optional `@deepseek-ai/dsh` CLI |
| Policy admission | Deny / requireApproval stay in front of tools (permissions plugin) |

`backend: "live"` **fails closed** with an error that points at the next scaffold step. Do not call network APIs from tests.

## Install

```bash
npm install          # small footprint — embedded harness only
npm test
```

Do **not** install `@deepseek-ai/dsh` unless you need live mode. That package pulls dozens of nested modules and can make `npm install` appear hung for minutes.

```bash
# live only (optional, after core install works)
npm install @deepseek-ai/dsh@^0.1.1-rc.2
export OPENAI_API_KEY=sk-...          # preferred
# export DEEPSEEK_API_KEY=...         # optional fallback
export ROPEX_DSH_BACKEND=live
```

## Steps to wire live

1. Install optional peer: `npm install @deepseek-ai/dsh` (never a hard CI dependency).
2. Implement `bootLiveDsh(spec)` returning `{ backend: "live", pack, kernel, execute }`.
3. Map `DSH_PROFILE_PACKS[profile].plugins` onto Cordis pack loaders.
4. Mount Policy deny/requireApproval before tool execution.
5. Prove one path: `ropex run --root sandbox` with `ROPEX_DSH_BACKEND=live`.
6. Keep `embedded` as the default for demos and vitest.

## Env

```
ROPEX_DSH_BACKEND=embedded|live
OPENAI_API_KEY=(preferred live key — default for Ropex)
DEEPSEEK_API_KEY=(optional fallback)
```

Live readiness prefers **`OPENAI_API_KEY`**. If both are set, OpenAI wins. Default harness model (when YAML omits `harness.model`) is `gpt-4o-mini`.

Configure non-DeepSeek models in dsh provider settings (`llm-pi-ai`) so headless runs can call OpenAI (or any OpenAI-compatible endpoint).

## Surfaces

- Control-plane UI **DeepSeek harness** section (from `/api/v1/view`.dsh) shows `apiKeySource`
- `liveDshScaffold()` / `resolveLlmApiKey()` for CLI/docs/programmatic checks

See also [architecture.md](./architecture.md), [control-plane-ui.md](./control-plane-ui.md), [hermes.md](./hermes.md), [operations.md](./operations.md), and [executor-api.md](./executor-api.md).
