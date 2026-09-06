#!/usr/bin/env bash
# Live-mode control plane — Hermes + DeepSeek CLI adapters on the host.
# The default Compose image does not include live peers; do not use npm run up for this.
#
#   npm run live              # apply forge-local.yaml, serve http://127.0.0.1:7780
#   npm run live -- --check   # validate packages + API key, then exit
#   bash scripts/live-up.sh [--check] [--no-build]
set -euo pipefail
cd "$(dirname "$0")/.."

CHECK_ONLY=0
NO_BUILD=0
MANIFEST="fleets/examples/forge-local.yaml"
PORT="${ROPEX_PORT:-7780}"

for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --no-build) NO_BUILD=1 ;;
    --help|-h)
      echo "Usage: $0 [--check] [--no-build]"
      echo "  Live Hermes + DeepSeek control plane (local process, not Compose)."
      echo "  Requires: hermes-agent, @deepseek-ai/dsh, OPENAI_API_KEY or DEEPSEEK_API_KEY."
      exit 0
      ;;
    *)
      echo "unknown arg: $arg  (try --help)" >&2
      exit 2
      ;;
  esac
done

ok() { echo "✓ $*"; }
fail() { echo "✗ $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js >= 20 is required"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if (( NODE_MAJOR < 20 )); then
  fail "Node.js >= 20 required (found $(node -v))"
fi
ok "Node $(node -v)"

[[ -d node_modules ]] || fail "run npm install first (or bash scripts/bootstrap.sh)"
ok "core node_modules present"

if [[ ! -d node_modules/hermes-agent ]]; then
  fail "hermes-agent not installed. Run: npm install hermes-agent@^0.20.5"
fi
ok "hermes-agent present"

if [[ ! -d node_modules/@deepseek-ai/dsh ]]; then
  fail "@deepseek-ai/dsh not installed. Run: npm install @deepseek-ai/dsh@^0.1.1-rc.2"
fi
ok "@deepseek-ai/dsh present"

if [[ -z "${OPENAI_API_KEY:-}" && -z "${DEEPSEEK_API_KEY:-}" ]]; then
  fail "set OPENAI_API_KEY (preferred) or DEEPSEEK_API_KEY"
fi
if [[ -n "${OPENAI_API_KEY:-}" ]]; then
  ok "LLM key via OPENAI_API_KEY"
else
  ok "LLM key via DEEPSEEK_API_KEY (fallback)"
fi

export ROPEX_HERMES_BACKEND=live
export ROPEX_DSH_BACKEND=live
ok "ROPEX_HERMES_BACKEND=live ROPEX_DSH_BACKEND=live"

if (( CHECK_ONLY )); then
  echo "live mode ready — start with: npm run live"
  exit 0
fi

if (( ! NO_BUILD )); then
  echo "→ building dashboard (dist/ui)…"
  npm run build:web --silent || echo "  (web build skipped — CLI still works; dashboard needs dist/ui)"
fi

echo "→ starting live stack ($MANIFEST) on :${PORT}"
echo "  dashboard  http://127.0.0.1:${PORT}"
echo "  services   http://127.0.0.1:${PORT}/#services"
echo "  stop with  Ctrl+C, then optionally: npx tsx src/cli.ts down"
exec npx tsx src/cli.ts up "$MANIFEST" --serve --port "$PORT"
