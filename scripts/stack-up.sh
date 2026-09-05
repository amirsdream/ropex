#!/usr/bin/env bash
# One-click spin up — Podman Compose preferred, Docker Compose fallback.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE_FILE="podman-compose.yml"
if command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
  COMPOSE=(podman compose -f "$COMPOSE_FILE")
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose -f "$COMPOSE_FILE")
else
  echo "→ no compose runtime — starting local stack (npm)"
  # Live @deepseek-ai/dsh needs Node >=22.19 (zstd zlib APIs). Prefer nvm if present.
  if [[ -z "${ROPEX_NODE:-}" ]]; then
    for cand in \
      "$HOME/.nvm/versions/node/v22.22.2/bin" \
      "$HOME/.nvm/versions/node/v22.19.0/bin"; do
      if [[ -x "$cand/node" ]]; then
        export PATH="$cand:$PATH"
        break
      fi
    done
  else
    export PATH="$ROPEX_NODE:$PATH"
  fi
  echo "→ node $(node -v)"
  npm run build --silent 2>/dev/null || true
  exec npx tsx src/cli.ts up fleets/examples/github-control-plane.yaml --serve --port "${ROPEX_PORT:-7780}"
fi

echo "→ building and starting ropex control plane…"
"${COMPOSE[@]}" up --build -d
echo "→ dashboard http://127.0.0.1:${ROPEX_PORT:-7780}"
echo "→ stop with: npm run down"
