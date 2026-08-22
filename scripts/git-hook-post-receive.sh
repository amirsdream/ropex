#!/usr/bin/env bash
# Git post-receive hook for forge-neutral Ropex task inbox.
# Install: cp scripts/git-hook-post-receive.sh .git/hooks/post-receive && chmod +x .git/hooks/post-receive
#
# On each push, sync Task YAML from tasks/ and drain the queue.
# Requires: node, npm install, ropex apply already run for this checkout.

set -euo pipefail

ROOT="${ROPEX_ROOT:-$(git rev-parse --show-toplevel)}"
cd "$ROOT"

if [[ ! -d node_modules ]]; then
  echo "ropex hook: run npm install in $ROOT first" >&2
  exit 1
fi

npx tsx src/cli.ts --root "$ROOT" memory sync --repos 2>/dev/null || npx tsx src/cli.ts --root "$ROOT" memory sync
npx tsx src/cli.ts --root "$ROOT" tasks sync --repos 2>/dev/null || npx tsx src/cli.ts --root "$ROOT" tasks sync
npx tsx src/cli.ts --root "$ROOT" drain --concurrency "${ROPEX_DRAIN_CONCURRENCY:-2}"

echo "ropex hook: memory + tasks synced and drain complete"
