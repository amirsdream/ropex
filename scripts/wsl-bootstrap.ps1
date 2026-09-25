<#
.SYNOPSIS
  Ropex — create and provision a WSL 2 distro from Windows, end to end.

.DESCRIPTION
  Run this from Windows PowerShell. It installs WSL 2 and a distro if needed,
  optionally copies the tuned .wslconfig, clones the repo into the distro's
  Linux filesystem, and runs scripts/wsl-setup.sh inside it.

  The Linux side is scripts/wsl-setup.sh — if you already have a distro, run
  that directly instead.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\wsl-bootstrap.ps1

.EXAMPLE
  .\scripts\wsl-bootstrap.ps1 -Distro Ubuntu-24.04 -InstallWslConfig -Repo https://github.com/amirsdream/ropex.git
#>
[CmdletBinding()]
param(
  # Distro to use or install. `wsl --list --online` shows the catalogue.
  [string]$Distro = 'Ubuntu-24.04',

  # Git remote to clone. Defaults to this repo.
  [string]$Repo = 'https://github.com/amirsdream/ropex.git',

  # Path inside the distro, relative to the Linux user's home.
  [string]$TargetDir = 'src/ropex',

  # Copy scripts\wsl\.wslconfig to %UserProfile%\.wslconfig (backs up any existing file).
  [switch]$InstallWslConfig,

  # Flags forwarded verbatim to scripts/wsl-setup.sh, e.g. '--minimal'.
  [string]$SetupArgs = '',

  # Only report what is present; change nothing.
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# wsl.exe writes progress to stderr and (for --list) emits UTF-16LE. Under
# $ErrorActionPreference = 'Stop' a redirected native stderr line can terminate
# the script, so every wsl call goes through these two helpers.
function Invoke-Wsl {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$WslArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & wsl.exe @WslArgs 2>&1 | Out-String }
  finally { $ErrorActionPreference = $prev }
}

function Get-WslDistros {
  $prev = [Console]::OutputEncoding
  try {
    [Console]::OutputEncoding = [System.Text.Encoding]::Unicode
    $raw = Invoke-Wsl '--list' '--quiet'
  } finally { [Console]::OutputEncoding = $prev }
  # Strip any stray NULs left by an OEM-codepage decode of UTF-16 output.
  @(($raw -replace "`0", '') -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Write-Step { param([string]$m) Write-Host "`n→ $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "  ✓ $m" -ForegroundColor Green }
function Write-Warn { param([string]$m) Write-Host "  ! $m" -ForegroundColor Yellow }
function Write-Err  { param([string]$m) Write-Host "  ✗ $m" -ForegroundColor Red }

# --- 1. WSL present? -------------------------------------------------------
Write-Step 'Checking WSL'
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
  Write-Err 'wsl.exe not found. Windows 10 2004+ or Windows 11 is required.'
  Write-Host '  Install with:  wsl --install' -ForegroundColor Yellow
  exit 1
}

Write-Ok 'wsl.exe found'
$status = Invoke-Wsl '--status'
if ($status -match '2') { Write-Ok 'WSL 2 available' }

if (-not $CheckOnly) {
  Write-Step 'Updating the WSL kernel'
  Invoke-Wsl '--update' | Write-Verbose
  Invoke-Wsl '--set-default-version' '2' | Write-Verbose
  Write-Ok 'kernel up to date, default version 2'
}

# --- 2. distro -------------------------------------------------------------
Write-Step "Checking distro '$Distro'"
$installed = Get-WslDistros

if ($installed -contains $Distro) {
  Write-Ok "$Distro already installed"
} elseif ($CheckOnly) {
  Write-Warn "$Distro not installed"
} else {
  Write-Host "  installing $Distro — set a UNIX username and password when prompted, then exit that shell" -ForegroundColor Yellow
  & wsl.exe --install -d $Distro
  if ($LASTEXITCODE -ne 0) {
    Write-Err "install failed. See available names with: wsl --list --online"
    exit 1
  }
  Write-Ok "$Distro installed"
  Write-Warn 'A reboot may be required before the distro is usable. Re-run this script afterwards.'
}

if ($CheckOnly) {
  Write-Step 'Check complete (no changes made)'
  exit 0
}

# --- 3. .wslconfig ---------------------------------------------------------
if ($InstallWslConfig) {
  Write-Step 'Installing %UserProfile%\.wslconfig'
  $src = Join-Path $scriptRoot 'wsl\.wslconfig'
  $dst = Join-Path $env:USERPROFILE '.wslconfig'
  if (-not (Test-Path $src)) {
    Write-Warn "template missing: $src"
  } else {
    if (Test-Path $dst) {
      $backup = "$dst.bak.$(Get-Date -Format yyyyMMddHHmmss)"
      Copy-Item $dst $backup
      Write-Warn "existing .wslconfig backed up to $backup"
    }
    Copy-Item $src $dst -Force
    Write-Ok "wrote $dst — review memory/processors for your machine"
    Write-Warn 'Run `wsl --shutdown` to apply it.'
  }
}

# --- 4. clone + provision --------------------------------------------------
Write-Step "Provisioning $Distro"

$bash = @"
set -euo pipefail
target="`$HOME/$TargetDir"
if [ -d "`$target/.git" ]; then
  echo "→ repo already at `$target"
else
  echo "→ cloning $Repo into `$target"
  mkdir -p "`$(dirname "`$target")"
  # A local (e.g. /mnt/*) -Repo is owned by a different uid than this distro's
  # user from git's point of view, which git treats as "dubious ownership" and
  # refuses to clone. Trust this specific path (git checks the .git dir, not
  # the working tree root); a no-op when -Repo is a URL.
  git config --global --add safe.directory "$Repo/.git" 2>/dev/null || true
  git clone "$Repo" "`$target"
fi
cd "`$target"
# A prior run's nvm lives in ~/.bashrc, which this non-interactive, non-login
# shell never sources — load it so --skip-node (or any step assuming node is
# already on PATH) sees a node that setup itself would otherwise re-source.
export NVM_DIR="`$HOME/.nvm"
[ -s "`$NVM_DIR/nvm.sh" ] && \. "`$NVM_DIR/nvm.sh"
exec bash scripts/wsl-setup.sh $SetupArgs
"@

# Send LF-only to bash; CRLF would break the heredoc-free script above.
$bash = $bash -replace "`r`n", "`n"
$tmp = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($tmp, $bash, (New-Object System.Text.UTF8Encoding $false))
$winPath = $tmp -replace '\\', '/'
$linuxTmp = (Invoke-Wsl '-d' $Distro 'wslpath' '-a' $winPath).Trim()
if (-not $linuxTmp) { Write-Err 'could not translate the temp path into the distro'; exit 1 }

# No --cd: the generated script cds itself, and --cd is missing on older WSL.
& wsl.exe -d $Distro -- bash $linuxTmp
$code = $LASTEXITCODE
Remove-Item $tmp -ErrorAction SilentlyContinue

if ($code -ne 0) {
  Write-Err "setup failed inside $Distro (exit $code)"
  Write-Host "  Retry manually:  wsl -d $Distro" -ForegroundColor Yellow
  Write-Host "                   cd ~/$TargetDir && bash scripts/wsl-setup.sh" -ForegroundColor Yellow
  exit $code
}

Write-Step 'Done'
Write-Host @"
  Open the environment:
    wsl -d $Distro
    cd ~/$TargetDir

  (--cd ~/... resolves against the Windows side, not the distro's home — use
  a plain cd once you're in the shell, or pass --cd an absolute Linux path.)

  Then:
    bash scripts/wsl-doctor.sh
    npm run up                 # http://127.0.0.1:7780 from the Windows browser
    code .                     # VS Code, WSL remote

  Docs: docs/wsl.md
"@ -ForegroundColor Green
