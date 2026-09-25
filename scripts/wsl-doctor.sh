#!/usr/bin/env bash
# Ropex — diagnose a WSL development environment. Read-only; changes nothing.
#
#   bash scripts/wsl-doctor.sh
#
# Exit 0 = ready, 1 = at least one hard failure. Warnings never fail the run.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FAIL=0
WARN=0
pass() { printf '  \033[32m✓\033[0m %-26s %s\n' "$1" "${2-}"; }
warn() { printf '  \033[33m!\033[0m %-26s %s\n' "$1" "${2-}"; WARN=$((WARN + 1)); }
fail() { printf '  \033[31m✗\033[0m %-26s %s\n' "$1" "${2-}"; FAIL=$((FAIL + 1)); }
section() { printf '\n\033[1;36m%s\033[0m\n' "$1"; }

section "WSL"
if [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
  pass "kernel" "$(uname -r)${WSL_DISTRO_NAME:+  distro=$WSL_DISTRO_NAME}"
else
  warn "kernel" "not WSL — the checks below still apply to a plain Linux host"
fi

if [[ -f /etc/wsl.conf ]]; then
  if grep -qE '^\s*systemd\s*=\s*true' /etc/wsl.conf; then
    if [[ -d /run/systemd/system ]]; then
      pass "/etc/wsl.conf" "systemd enabled and running"
    else
      warn "/etc/wsl.conf" "systemd=true but not running — 'wsl --shutdown' then reopen"
    fi
  else
    warn "/etc/wsl.conf" "systemd not enabled — rootless podman may not work"
  fi
else
  warn "/etc/wsl.conf" "missing — run: bash scripts/wsl-setup.sh"
fi

section "Filesystem"
case "$REPO_ROOT" in
  /mnt/*) fail "repo location" "$REPO_ROOT is on the Windows drive — clone under ~ instead" ;;
  *)      pass "repo location" "$REPO_ROOT" ;;
esac
AVAIL="$(df -Pk . 2>/dev/null | awk 'NR==2 {printf "%.1f", $4/1048576}')"
if [[ -n "$AVAIL" ]] && awk "BEGIN{exit !($AVAIL < 3)}"; then
  warn "free disk" "${AVAIL} GiB — node_modules + dist want ~3 GiB"
else
  pass "free disk" "${AVAIL:-?} GiB"
fi

section "Toolchain"
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
  MAJOR="$(node -v | sed 's/^v//; s/\..*//')"
  case "$NODE_BIN" in
    /mnt/*) fail "node" "$(node -v) at $NODE_BIN is the Windows build — install Node inside WSL" ;;
    *) if (( MAJOR >= 20 )); then pass "node" "$(node -v)  $NODE_BIN"
       else fail "node" "$(node -v) — package.json requires >= 20"; fi ;;
  esac
else
  fail "node" "not found — run: bash scripts/wsl-setup.sh"
fi

if command -v npm >/dev/null 2>&1; then
  case "$(command -v npm)" in
    /mnt/*) fail "npm" "resolves to the Windows npm — open a new shell after setup" ;;
    *) pass "npm" "$(npm -v)" ;;
  esac
else
  fail "npm" "not found"
fi

command -v git >/dev/null 2>&1 && pass "git" "$(git --version | awk '{print $3}')" || fail "git" "not found"
for b in curl jq make cc; do
  command -v "$b" >/dev/null 2>&1 && pass "$b" "$(command -v "$b")" || warn "$b" "not found — apt install build-essential curl jq"
done

section "Git checkout hygiene"
AUTOCRLF="$(git config --get core.autocrlf || echo unset)"
[[ "$AUTOCRLF" == "true" ]] && fail "core.autocrlf" "true — CRLF will break scripts/*.sh" || pass "core.autocrlf" "$AUTOCRLF"
if [[ -f scripts/stack-up.sh ]]; then
  if grep -qU $'\r' scripts/stack-up.sh 2>/dev/null; then
    fail "line endings" "scripts/stack-up.sh has CRLF — re-clone inside WSL"
  else
    pass "line endings" "LF"
  fi
  [[ -x scripts/stack-up.sh ]] && pass "exec bits" "scripts/*.sh executable" \
    || warn "exec bits" "scripts/stack-up.sh not executable — chmod +x scripts/*.sh"
fi

section "Dependencies"
[[ -d node_modules ]] && pass "node_modules" "present" || fail "node_modules" "missing — npm ci"
[[ -d web/node_modules ]] && pass "web/node_modules" "present" || warn "web/node_modules" "missing — npm --prefix web install"
[[ -f dist/cli.js ]] && pass "dist/cli.js" "built" || warn "dist/cli.js" "not built — npm run build"
[[ -d dist/ui ]] && pass "dist/ui" "built" || warn "dist/ui" "not built — npm run build:web"
[[ -f .env ]] && pass ".env" "present (source it: set -a && . .env && set +a)" \
  || warn ".env" "missing — cp scripts/wsl/env.example .env"

section "Container runtime (npm run up)"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker info >/dev/null 2>&1 && pass "docker compose" "$(docker compose version --short 2>/dev/null)" \
    || warn "docker compose" "CLI present but the daemon is unreachable — start Docker Desktop and enable WSL integration"
elif command -v podman >/dev/null 2>&1 && { podman compose version >/dev/null 2>&1 || command -v podman-compose >/dev/null 2>&1; }; then
  # `podman compose` shells out to the first docker-compose/podman-compose on
  # PATH, so a Windows Docker Desktop shim pulled in by appendWindowsPath can
  # shadow a working native podman-compose and make the plain check false-negative.
  pass "podman compose" "$(podman --version | awk '{print $3}')"
else
  warn "compose" "none — 'npm run up' falls back to the local Node stack (fine for dev)"
fi

section "Ports"
port_busy() { { command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null; } | grep -qE "[:.]$1 "; }
for p in "${ROPEX_PORT:-7780}" 5173; do
  port_busy "$p" && warn "port $p" "already in use" || pass "port $p" "free"
done
if [[ -f /etc/wsl.conf ]] || [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
  printf '  \033[36mi\033[0m %-26s %s\n' "windows access" \
    "needs localhostForwarding=true in %UserProfile%\\.wslconfig (see scripts/wsl/.wslconfig)"
fi

section "Result"
if (( FAIL )); then
  printf '  \033[31m%d failure(s)\033[0m, %d warning(s) — run: bash scripts/wsl-setup.sh\n\n' "$FAIL" "$WARN"
  exit 1
fi
printf '  \033[32mready\033[0m — %d warning(s)\n\n' "$WARN"
