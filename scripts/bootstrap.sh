#!/usr/bin/env bash
# Fast local bootstrap — installs only Ropex core deps (no live dsh/hermes).
# Use this if plain `npm install` hangs on @deepseek-ai/dsh.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ stripping live optional peers from package.json (if present)"
node <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const path = "package.json";
const pkg = JSON.parse(readFileSync(path, "utf8"));
if (pkg.optionalDependencies) {
  delete pkg.optionalDependencies;
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  console.log("  removed optionalDependencies");
} else {
  console.log("  already clean");
}
NODE

echo "→ wiping node_modules + package-lock.json"
rm -rf node_modules package-lock.json

echo "→ npm install (core only)"
npm install --no-fund --no-audit --loglevel=error

echo "→ ok. Next:"
echo "  npm test"
echo "  npm run dev -- apply fleets/examples/github-control-plane.yaml"
echo "  npm run dev -- ui"
