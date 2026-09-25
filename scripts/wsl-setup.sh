#!/usr/bin/env bash
# Ropex — provision a WSL 2 distro for development. Idempotent: safe to re-run.
#
#   bash scripts/wsl-setup.sh            # full setup
#   bash scripts/wsl-setup.sh --help     # flags
#
# Installs /etc/wsl.conf, apt build deps, Node via nvm, a container runtime,
# npm deps for the CLI and the web SPA, then builds and tests.
# See docs/wsl.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NODE_VERSION="22"
DO_APT=1
DO_WSLCONF=1
DO_NODE=1
DO_CONTAINER=1
DO_INSTALL=1
DO_BUILD=1
DO_TEST=1
FORCE=0
ALLOW_MNT=0

usage() {
  cat <<'USAGE'
Ropex WSL setup

Usage: bash scripts/wsl-setup.sh [flags]

  --node-version <n>   Node major to install via nvm (default: 22, min: 20)
  --skip-apt           Do not touch apt packages
  --skip-wsl-conf      Do not write /etc/wsl.conf
  --skip-node          Use the Node already on PATH
  --skip-container     Do not install or check Podman/Docker
  --skip-install       Do not run npm install
  --skip-build         Do not run npm run build (tsc + Vite SPA)
  --skip-tests         Do not run npm test
  --minimal            = --skip-container --skip-build --skip-tests
  --allow-mnt          Proceed even if the repo lives on /mnt/<drive> (slow)
  --force              Proceed even when not running under WSL
  -h, --help           This message
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node-version) NODE_VERSION="${2:?--node-version needs a value}"; shift 2 ;;
    --skip-apt) DO_APT=0; shift ;;
    --skip-wsl-conf) DO_WSLCONF=0; shift ;;
    --skip-node) DO_NODE=0; shift ;;
    --skip-container) DO_CONTAINER=0; shift ;;
    --skip-install) DO_INSTALL=0; shift ;;
    --skip-build) DO_BUILD=0; shift ;;
    --skip-tests) DO_TEST=0; shift ;;
    --minimal) DO_CONTAINER=0; DO_BUILD=0; DO_TEST=0; shift ;;
    --allow-mnt) ALLOW_MNT=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$NODE_VERSION" =~ ^v?([0-9]+) ]] && (( BASH_REMATCH[1] < 20 )); then
  echo "!! Ropex needs Node >= 20 (package.json engines); got --node-version $NODE_VERSION" >&2
  exit 2
fi

step()  { printf '\n\033[1;36m→ %s\033[0m\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()   { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
NOTES=()
note()  { NOTES+=("$*"); }

SUDO=""
if [[ $EUID -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 && SUDO="sudo"
fi

# A driver with no TTY (wsl-bootstrap.ps1 runs this via `wsl.exe -d <Distro> --
# bash <script>`) can't answer a sudo password prompt, so an uncached sudo
# ticket here would hang forever rather than fail. Degrade to the existing
# "no sudo" paths instead; a real interactive `bash scripts/wsl-setup.sh` still
# gets a normal password prompt since it has a TTY.
if [[ -n "$SUDO" ]] && [[ ! -t 0 ]] && ! sudo -n true 2>/dev/null; then
  warn "sudo needs a password and this shell has no terminal to ask on — skipping steps that need it"
  note "grant passwordless sudo once (echo '$(id -un) ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/90-wsl-dev), or run 'bash scripts/wsl-setup.sh' yourself in an interactive shell"
  SUDO=""
fi

# --- 0. environment guards -------------------------------------------------
step "Checking the environment"

is_wsl() {
  [[ -n "${WSL_DISTRO_NAME:-}" ]] && return 0
  grep -qiE 'microsoft|wsl' /proc/sys/kernel/osrelease 2>/dev/null && return 0
  grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null
}

if is_wsl; then
  ok "WSL detected${WSL_DISTRO_NAME:+ (distro: $WSL_DISTRO_NAME)}"
else
  if [[ $FORCE -eq 1 ]]; then
    warn "not running under WSL — continuing because --force was given"
  else
    die "not running under WSL. Run this inside the distro, or pass --force."
  fi
fi

case "$REPO_ROOT" in
  /mnt/*)
    if [[ $ALLOW_MNT -eq 1 ]]; then
      warn "repo is on the Windows drive ($REPO_ROOT) — npm and Vite will be slow"
    else
      cat >&2 <<EOF

✗ The repo is on the Windows filesystem: $REPO_ROOT

  9p/DrvFs makes npm install, tsc and Vite file-watching many times slower,
  and inotify events are unreliable. Clone into the Linux filesystem instead:

      cd ~ && mkdir -p src && cd src
      git clone <your-remote> ropex
      cd ropex && bash scripts/wsl-setup.sh

  Or re-run with --allow-mnt to proceed anyway.
EOF
      exit 1
    fi
    ;;
  *) ok "repo is on the Linux filesystem ($REPO_ROOT)" ;;
esac

# --- 1. /etc/wsl.conf ------------------------------------------------------
if [[ $DO_WSLCONF -eq 1 ]] && is_wsl; then
  step "Configuring /etc/wsl.conf"
  TEMPLATE="$REPO_ROOT/scripts/wsl/wsl.conf"
  if [[ ! -f "$TEMPLATE" ]]; then
    warn "template missing: $TEMPLATE"
  elif [[ -f /etc/wsl.conf ]] && cmp -s "$TEMPLATE" /etc/wsl.conf; then
    ok "/etc/wsl.conf already matches the template"
  elif [[ -z "$SUDO" && $EUID -ne 0 ]]; then
    warn "no sudo — copy scripts/wsl/wsl.conf to /etc/wsl.conf yourself"
  else
    if [[ -f /etc/wsl.conf ]]; then
      $SUDO cp /etc/wsl.conf "/etc/wsl.conf.bak.$(date +%Y%m%d%H%M%S)"
      warn "existing /etc/wsl.conf backed up to /etc/wsl.conf.bak.*"
    fi
    $SUDO install -m 0644 "$TEMPLATE" /etc/wsl.conf
    ok "wrote /etc/wsl.conf (systemd on, metadata automount)"
    note "run 'wsl --shutdown' in Windows PowerShell, then reopen the distro, to apply /etc/wsl.conf"
  fi
fi

# --- 2. apt packages -------------------------------------------------------
if [[ $DO_APT -eq 1 ]]; then
  step "Installing system packages"
  if ! command -v apt-get >/dev/null 2>&1; then
    warn "apt-get not found — install the equivalents for your distro manually"
  elif [[ -z "$SUDO" && $EUID -ne 0 ]]; then
    warn "no sudo — skipping apt packages"
  else
    PKGS=(build-essential ca-certificates curl git jq unzip wget python3 pkg-config
          uidmap dbus-user-session)
    MISSING=()
    for p in "${PKGS[@]}"; do
      dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p")
    done
    if ((${#MISSING[@]})); then
      $SUDO apt-get update -qq
      DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y --no-install-recommends "${MISSING[@]}"
      ok "installed: ${MISSING[*]}"
    else
      ok "all system packages already present"
    fi
  fi
fi

# --- 3. Node via nvm -------------------------------------------------------
node_major() { node -v 2>/dev/null | sed 's/^v//; s/\..*//'; }

if [[ $DO_NODE -eq 1 ]]; then
  step "Setting up Node $NODE_VERSION"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    ok "installing nvm into $NVM_DIR"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | PROFILE=/dev/null bash
  else
    ok "nvm already installed"
  fi
  # shellcheck disable=SC1091
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    set +u; . "$NVM_DIR/nvm.sh"; set -u
    nvm install "$NODE_VERSION" >/dev/null
    nvm alias default "$NODE_VERSION" >/dev/null
    nvm use default >/dev/null
    ok "node $(node -v), npm $(npm -v)"
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
      [[ -f "$rc" ]] || continue
      grep -q 'NVM_DIR' "$rc" || cat >>"$rc" <<'RC'

# nvm (added by ropex scripts/wsl-setup.sh)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
RC
    done
  else
    warn "nvm install failed — falling back to the Node already on PATH"
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  die "no node on PATH. Re-run without --skip-node, or install Node >= 20."
fi
NODE_MAJOR="$(node_major)"
if [[ -z "$NODE_MAJOR" || "$NODE_MAJOR" -lt 20 ]]; then
  die "node $(node -v) is too old — Ropex needs >= 20 (package.json engines)."
fi
case "$(command -v node)" in
  /mnt/*) warn "PATH resolves node to Windows ($(command -v node)) — that build cannot run Ropex.
    Open a new shell so nvm wins, or set appendWindowsPath = false in /etc/wsl.conf." ;;
esac

# --- 4. git configuration --------------------------------------------------
step "Configuring git for a Linux checkout"
git config --local core.autocrlf false
git config --local core.eol lf
git config --local core.filemode true
ok "core.autocrlf=false, core.eol=lf (keeps scripts/*.sh LF and executable)"
if [[ -z "$(git config --global user.email || true)" ]]; then
  note "set your identity: git config --global user.name '…' && git config --global user.email '…'"
fi
if command -v git-credential-manager.exe >/dev/null 2>&1 && [[ -z "$(git config --global credential.helper || true)" ]]; then
  note "reuse Windows credentials: git config --global credential.helper \"\$(command -v git-credential-manager.exe)\""
fi

# --- 5. container runtime --------------------------------------------------
if [[ $DO_CONTAINER -eq 1 ]]; then
  step "Checking the container runtime (npm run up)"
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    ok "docker compose available (Docker Desktop WSL integration or engine in-distro)"
  elif command -v podman >/dev/null 2>&1 && { podman compose version >/dev/null 2>&1 || command -v podman-compose >/dev/null 2>&1; }; then
    # `podman compose` shells out to the first `docker-compose`/`podman-compose` on
    # PATH. With interop.appendWindowsPath=true and Docker Desktop installed, a
    # non-functional Windows docker-compose shim can shadow a working native
    # podman-compose — so a plain `podman compose version` can false-negative.
    ok "podman compose available"
  elif command -v apt-get >/dev/null 2>&1 && { [[ -n "$SUDO" ]] || [[ $EUID -eq 0 ]]; }; then
    ok "installing podman + podman-compose"
    $SUDO apt-get update -qq
    if DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y --no-install-recommends podman podman-compose; then
      ok "podman $(podman --version 2>/dev/null | awk '{print $3}') installed"
      if [[ ! -d /run/systemd/system ]]; then
        note "rootless podman wants systemd: /etc/wsl.conf now sets systemd=true — run 'wsl --shutdown' and reopen"
      fi
    else
      warn "podman install failed — 'npm run up' falls back to the local Node stack, which is fine for development"
    fi
  else
    warn "no container runtime — 'npm run up' falls back to 'tsx src/cli.ts up --serve' on the host"
  fi
fi

# --- 6. dependencies -------------------------------------------------------
if [[ $DO_INSTALL -eq 1 ]]; then
  step "Installing npm dependencies"
  if [[ -f package-lock.json ]]; then
    npm ci --no-fund --no-audit || npm install --no-fund --no-audit
  else
    npm install --no-fund --no-audit
  fi
  ok "control plane deps installed"
  npm --prefix web install --no-fund --no-audit
  ok "web SPA deps installed"
fi

# --- 7. local env file -----------------------------------------------------
step "Preparing ./.env"
if [[ -f .env ]]; then
  ok ".env already exists — left untouched"
else
  cp scripts/wsl/env.example .env
  ok "created .env from scripts/wsl/env.example (gitignored)"
fi
BASHRC="$HOME/.bashrc"
MARK="# ropex .env (added by scripts/wsl-setup.sh)"
if [[ -f "$BASHRC" ]] && ! grep -qF "$MARK" "$BASHRC"; then
  cat >>"$BASHRC" <<RC

$MARK
ropex_env() { [ -f "$REPO_ROOT/.env" ] && set -a && . "$REPO_ROOT/.env" && set +a; }
case "\$PWD" in "$REPO_ROOT"|"$REPO_ROOT"/*) ropex_env ;; esac
RC
  ok "added a ropex_env helper to ~/.bashrc (auto-sources .env inside the repo)"
fi

# --- 8. build --------------------------------------------------------------
if [[ $DO_BUILD -eq 1 ]]; then
  step "Building (tsc + Vite SPA → dist/ui)"
  npm run build
  ok "dist/cli.js and dist/ui built"
fi

# --- 9. tests --------------------------------------------------------------
if [[ $DO_TEST -eq 1 ]]; then
  step "Running the test suite (offline, no API keys)"
  npm test
  ok "tests passed"
fi

# --- summary ---------------------------------------------------------------
step "WSL environment ready"
printf '  node      %s\n' "$(node -v)"
printf '  npm       %s\n' "$(npm -v)"
printf '  repo      %s\n' "$REPO_ROOT"
if ((${#NOTES[@]})); then
  printf '\n\033[1;33mFollow-ups\033[0m\n'
  for n in "${NOTES[@]}"; do printf '  • %s\n' "$n"; done
fi
cat <<EOF

Next:
  bash scripts/wsl-doctor.sh          verify the environment
  npm run up                          control plane → http://127.0.0.1:7780
  npm run web:dev                     Vite dev server → http://127.0.0.1:5173
  npx tsx src/cli.ts demo --root /tmp/ropex-demo

Docs: docs/wsl.md · docs/operations.md
EOF
