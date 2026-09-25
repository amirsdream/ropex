#!/usr/bin/env bash
# Cloud Agent `start` hook.
# Must exit quickly. Cursor waits for this to finish before it opens terminals
# or finishes "Starting remote server". Do not serve the dashboard here.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -d node_modules ]]; then
  echo "ropex cloud start: missing node_modules (install did not complete)" >&2
  exit 1
fi

if [[ ! -f dist/ui/index.html ]]; then
  echo "ropex cloud start: dist/ui missing — building dashboard once"
  npm run build:web
fi

echo "ropex cloud start ok — dashboard is the ropex-ui terminal on :7780"
exit 0
