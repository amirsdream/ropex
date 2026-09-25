# WSL — Windows development environment

Run the Ropex control plane on Windows through **WSL 2**. One script provisions
the distro; a second verifies it. For running the stack itself see
[operations.md](./operations.md).

| File | Side | Role |
| --- | --- | --- |
| `scripts/wsl-bootstrap.ps1` | Windows | Install WSL + distro, clone the repo, call the setup script |
| `scripts/wsl-setup.sh` | WSL | Provision the distro — packages, Node, container runtime, deps, build, tests |
| `scripts/wsl-doctor.sh` | WSL | Read-only health check of the environment |
| `scripts/wsl/wsl.conf` | WSL | Template for `/etc/wsl.conf` (systemd, automount, interop) |
| `scripts/wsl/.wslconfig` | Windows | Template for `%UserProfile%\.wslconfig` (memory, CPU, localhost forwarding) |
| `scripts/wsl/env.example` | WSL | Template copied to `./.env` |

## Quick start — from Windows

In **PowerShell** (no admin needed unless WSL itself is missing):

```powershell
git clone https://github.com/amirsdream/ropex.git
cd ropex
powershell -ExecutionPolicy Bypass -File scripts\wsl-bootstrap.ps1 -InstallWslConfig
```

That installs WSL 2 and Ubuntu 24.04 if missing, writes the tuned `.wslconfig`,
clones the repo to `~/src/ropex` **inside** the distro, and runs the Linux setup.

If the distro didn't already exist, `wsl --install -d <Distro>` opens an
interactive console for the one-time username/password prompt and blocks until
you finish it and exit that shell — run this script from a real interactive
terminal for a first install. It cannot complete unattended (e.g. from CI or a
non-interactive remote session): it will hang with no output at the clone step
until something supplies that input. Installing into an already-registered
distro (the common case for a re-run) skips this entirely.

Then:

```powershell
wsl --shutdown                        # apply .wslconfig / wsl.conf
wsl -d Ubuntu-24.04
```
```bash
cd ~/src/ropex
```

(`wsl --cd ~/...` resolves `~` against the Windows side, not the distro's
home, and fails or opens the wrong directory — `cd` once you're in the shell
instead, or pass `--cd` an absolute Linux path like `--cd /home/<user>/src/ropex`.)

Useful flags:

```powershell
.\scripts\wsl-bootstrap.ps1 -CheckOnly                  # report only, change nothing
.\scripts\wsl-bootstrap.ps1 -Distro Ubuntu-22.04
.\scripts\wsl-bootstrap.ps1 -TargetDir work/ropex -SetupArgs '--minimal'
```

## Quick start — already inside a distro

```bash
cd ~ && mkdir -p src && cd src
git clone https://github.com/amirsdream/ropex.git
cd ropex
bash scripts/wsl-setup.sh
bash scripts/wsl-doctor.sh
```

Or, from a checkout you already have:

```bash
npm run wsl:setup
npm run wsl:doctor
```

## What `wsl-setup.sh` does

It is idempotent — re-run it after changing Node versions or pulling new deps.

1. **Guards** — refuses to run outside WSL (`--force` overrides) and refuses a
   repo on `/mnt/c` (`--allow-mnt` overrides). See [Keep the repo on ext4](#keep-the-repo-on-ext4).
2. **`/etc/wsl.conf`** — installs `scripts/wsl/wsl.conf` (backing up any
   existing file): `systemd = true` for rootless Podman, `metadata` automount so
   exec bits survive on `/mnt`, interop on so `code .` works.
3. **apt packages** — `build-essential ca-certificates curl git jq unzip wget
   python3 pkg-config uidmap dbus-user-session`. Only missing ones are installed.
4. **Node** — installs `nvm`, then Node 22 (`--node-version` to change; the
   floor is 20 from `package.json` `engines`) and wires `nvm` into `~/.bashrc`.
   It fails loudly if PATH resolves `node` to a Windows `node.exe`.
5. **git** — sets `core.autocrlf=false`, `core.eol=lf`, `core.filemode=true` on
   the local clone so `scripts/*.sh` stay LF and executable.
6. **Container runtime** — uses Docker Desktop's WSL integration or an in-distro
   Podman if present; otherwise installs `podman` + `podman-compose`. Without
   one, `npm run up` still works via its local-Node fallback.
7. **Dependencies** — `npm ci` at the root plus `npm --prefix web install`.
8. **`.env`** — copies `scripts/wsl/env.example` to `./.env` (gitignored) and
   adds a `ropex_env` helper to `~/.bashrc` that sources it inside the repo.
9. **Build + test** — `npm run build` (tsc + Vite SPA → `dist/ui`) and `npm test`.

Flags: `--skip-apt --skip-wsl-conf --skip-node --skip-container --skip-install
--skip-build --skip-tests --minimal --allow-mnt --force --node-version <n>`.

```bash
bash scripts/wsl-setup.sh --help
bash scripts/wsl-setup.sh --minimal        # no container runtime, no build, no tests
bash scripts/wsl-setup.sh --skip-apt       # unprivileged re-run
```

## Running the stack

```bash
npm run up      # → http://127.0.0.1:7780, open it in the Windows browser
npm run down
npm run web:dev # Vite dev server → http://127.0.0.1:5173, proxying /api to :7780
```

Both servers bind `127.0.0.1` inside the distro. Windows reaches them because
`localhostForwarding = true` is set in `.wslconfig` — that is why the template
matters. To reach them from another machine on the LAN instead, bind explicitly:

```bash
npx tsx src/cli.ts up fleets/examples/github-control-plane.yaml --serve --port 7780
npm --prefix web run dev -- --host 0.0.0.0
```

Change the port with `ROPEX_PORT` (honoured by `npm run up`, `podman-compose.yml`
and `wsl-doctor.sh`).

## Environment variables

Nothing auto-loads `.env`. Source it, or open a shell in the repo and let the
`ropex_env` helper do it:

```bash
set -a && source .env && set +a
```

`scripts/wsl/env.example` documents `ROPEX_PORT`, the `live` backend switches,
worker-runtime binaries and the GitHub ingress secrets. Defaults are embedded
Hermes + embedded harness, so everything runs offline with no keys.

## Conventions that matter on WSL

### Keep the repo on ext4

Clone into `~`, never `/mnt/c`. Across the 9p/DrvFs boundary `npm install`,
`tsc` and Vite watching are several times slower, and inotify events are
unreliable — the dev server stops hot-reloading. `wsl-setup.sh` refuses a
`/mnt` checkout for that reason.

To edit from Windows, keep the files on ext4 and reach in:

```bash
code .              # VS Code, WSL remote extension
explorer.exe .      # \\wsl$\<distro>\home\<user>\src\ropex
```

### Line endings

`.gitattributes` normalises the tree to LF and marks images binary. If you
clone on the Windows side with `core.autocrlf=true`, `scripts/*.sh` get CRLF and
fail with `bad interpreter: /bin/bash^M`. `wsl-doctor.sh` checks for this. Fix
by re-cloning inside WSL, or:

```bash
git config --local core.autocrlf false
git rm --cached -r . && git reset --hard
```

### Containers

Two supported paths:

- **Docker Desktop** — enable *Settings → Resources → WSL Integration* for your
  distro. `docker compose` then works in the distro with no daemon inside it.
- **Podman in-distro** — what `wsl-setup.sh` installs. Rootless Podman needs
  `systemd = true` in `/etc/wsl.conf` and a `wsl --shutdown` to take effect.

Neither is required for development: `scripts/stack-up.sh` falls back to running
the control plane directly with `tsx`.

If Docker Desktop is installed on Windows but its WSL integration is **off** for
this distro, `interop.appendWindowsPath` still puts its non-functional
`docker-compose` shim on `PATH` ahead of a working in-distro `podman-compose` —
`wsl-setup.sh` and `wsl-doctor.sh` check for `podman-compose` directly so this
doesn't read as "no compose available".

### Memory

`.wslconfig` caps the VM at 8 GB / 4 CPUs with `autoMemoryReclaim = gradual`.
Raise `memory` if `npm run build` gets OOM-killed during the Vite build; lower
it if Windows starves. Edits need `wsl --shutdown` to apply.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `bad interpreter: /bin/bash^M` | CRLF checkout | See [Line endings](#line-endings) |
| `node: command not found` after setup | `nvm` not yet sourced | Open a new shell, or `. ~/.nvm/nvm.sh` |
| `node -v` shows a Windows version | `appendWindowsPath` puts `/mnt/c/...` first | New shell after setup, or set `appendWindowsPath = false` in `/etc/wsl.conf` |
| `http://127.0.0.1:7780` refused from Windows | `localhostForwarding` off, or stack down | Install `scripts/wsl/.wslconfig`, `wsl --shutdown`, then `npm run up` |
| `podman` fails with a cgroup/dbus error | systemd not running | `wsl --shutdown`, reopen; confirm with `bash scripts/wsl-doctor.sh` |
| DNS fails inside the distro | Generated `resolv.conf` clash | `wsl --shutdown`; if it persists set `generateResolvConf = false` and write `/etc/resolv.conf` yourself |
| `npm install` hangs | Optional live DeepSeek tree | `bash scripts/bootstrap.sh` — see [README](../README.md#quick-start) |
| Very slow installs/builds | Repo on `/mnt/c` | Re-clone under `~` |
| `wsl-bootstrap.ps1` hangs with no output after "Provisioning" | Fresh distro install needs an interactive OOBE username/password prompt | Run from a real terminal, complete the prompt, exit that shell; see [Quick start](#quick-start--from-windows) |
| `--skip-node` still fails with "no node on PATH" | Re-running via `wsl-bootstrap.ps1` uses a non-login shell that doesn't source `~/.bashrc` | Fixed by sourcing `~/.nvm/nvm.sh` before handing off to `wsl-setup.sh`; update if you're on an older copy of the script |

Start every diagnosis with:

```bash
bash scripts/wsl-doctor.sh
```

It reports WSL/systemd state, repo location, free disk, Node and npm origin,
line endings, dependency and build artefacts, container runtime, and port
availability. Exit code 0 means ready; 1 means at least one hard failure.

## Related

- [Operations](./operations.md) — up/down, Compose, stack API
- [HTTP API](./api.md) — routes served on `:7780`
- [Control-plane UI](./control-plane-ui.md) — the SPA on `dist/ui`
- [Worker runtimes](./worker-runtimes.md) — putting a CLI runtime on `PATH`
