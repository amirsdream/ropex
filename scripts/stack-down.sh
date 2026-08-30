#!/usr/bin/env bash
# One-click spin down — Podman Compose preferred, Docker Compose fallback.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE_FILE="podman-compose.yml"
if command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
  COMPOSE=(podman compose -f "$COMPOSE_FILE")
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose -f "$COMPOSE_FILE")
else
  echo "→ no compose runtime — stopping local stack"
  exec npx tsx src/cli.ts down
fi

echo "→ stopping ropex control plane…"
"${COMPOSE[@]}" down
echo "→ stack down"
