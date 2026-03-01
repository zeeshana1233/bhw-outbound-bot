# =============================================================================
# Bitbash BHW Bot — Windows Server Setup Script
# =============================================================================
# Run this ONCE on a fresh Windows machine (RDP in first, then run this).
#
# Requirements: Windows 10/11 or Windows Server 2019/2022
#
# How to run (in PowerShell as Administrator):
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\deploy\setup.ps1
# =============================================================================

param()

$ErrorActionPreference = "Stop"

function Write-Info  { Write-Host "[setup] $args" -ForegroundColor Cyan }
function Write-Ok    { Write-Host "[  OK  ] $args" -ForegroundColor Green }
function Write-Warn  { Write-Host "[ WARN ] $args" -ForegroundColor Yellow }
function Write-Fail  { Write-Host "[ FAIL ] $args" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "━━━  BHW Bot — Windows Server Setup  ━━━" -ForegroundColor Cyan
Write-Host ""

# ── Admin check ───────────────────────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Fail "Please run PowerShell as Administrator (right-click → Run as administrator)"
}
Write-Ok "Running as Administrator."

# ── Winget check ─────────────────────────────────────────────────────────────
Write-Info "Checking winget…"
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Warn "winget not found. Install manually from https://aka.ms/winget-install"
    Write-Fail "winget required to auto-install Node.js, Git, PostgreSQL."
}
Write-Ok "winget available."

# ── 1. Git ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Info "Step 1/5 — Installing Git…"
if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Ok "Git already installed: $(git --version)"
} else {
    winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    Write-Ok "Git installed."
}

# ── 2. Node.js 20 LTS ────────────────────────────────────────────────────────
Write-Host ""
Write-Info "Step 2/5 — Installing Node.js 20 LTS…"
if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodever = node --version
    Write-Ok "Node.js already installed: $nodever"
} else {
    winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    Write-Ok "Node.js installed."
}

# PM2 globally
Write-Info "Installing PM2 globally…"
npm install -g pm2 2>&1 | Out-Null
Write-Ok "PM2 installed: $(pm2 --version)"

# pm2-windows-startup for auto-start on reboot
Write-Info "Installing pm2-windows-startup…"
npm install -g pm2-windows-startup 2>&1 | Out-Null
pm2-startup install 2>&1 | Out-Null
Write-Ok "PM2 set to auto-start on Windows boot."

# ── 3. PostgreSQL 16 ─────────────────────────────────────────────────────────
Write-Host ""
Write-Info "Step 3/5 — Installing PostgreSQL 16…"
$pgInstalled = Get-Command psql -ErrorAction SilentlyContinue
if ($pgInstalled) {
    Write-Ok "PostgreSQL already installed."
} else {
    winget install --id PostgreSQL.PostgreSQL.16 -e --source winget --accept-source-agreements --accept-package-agreements
    # Add psql to PATH
    $pgBin = "C:\Program Files\PostgreSQL\16\bin"
    $currentPath = [System.Environment]::GetEnvironmentVariable("Path","Machine")
    if ($currentPath -notlike "*$pgBin*") {
        [System.Environment]::SetEnvironmentVariable("Path", "$currentPath;$pgBin", "Machine")
    }
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    Write-Ok "PostgreSQL 16 installed."
}

# Create DB and botuser
Write-Info "Creating database 'bhw_bot' and user 'botuser'…"
$dbPassword = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 20 | ForEach-Object {[char]$_})

$pgSetup = @"
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'botuser') THEN
    CREATE ROLE botuser LOGIN PASSWORD '$dbPassword';
  ELSE
    ALTER ROLE botuser WITH LOGIN PASSWORD '$dbPassword';
  END IF;
END
\$\$;

CREATE DATABASE bhw_bot OWNER botuser;
GRANT ALL PRIVILEGES ON DATABASE bhw_bot TO botuser;
"@

# Run as postgres superuser (uses Windows auth if available, else prompt)
try {
    $pgSetup | & "psql" -U postgres 2>&1
    Write-Ok "Database and user created."
} catch {
    Write-Warn "Could not auto-create DB — you may need to run psql manually."
    Write-Warn "SQL to run as postgres superuser saved to: C:\bhw-bot-db-setup.sql"
    $pgSetup | Set-Content "C:\bhw-bot-db-setup.sql"
}

# Save credentials
$credsFile = "C:\bhw-bot-creds.txt"
@"
DB_HOST=localhost
DB_PORT=5432
DB_NAME=bhw_bot
DB_USER=botuser
DB_PASSWORD=$dbPassword
"@ | Set-Content $credsFile
Write-Ok "DB credentials saved to: $credsFile"

# ── 4. Google Chrome (for Puppeteer) ─────────────────────────────────────────
Write-Host ""
Write-Info "Step 4/5 — Checking Chrome/Chromium for Puppeteer…"
$chromePaths = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe"
)
$chromeFound = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($chromeFound) {
    Write-Ok "Chrome found at: $chromeFound"
    Add-Content $credsFile "BHW_CHROME_PATH=$chromeFound"
} else {
    Write-Info "Chrome not found — installing via winget…"
    winget install --id Google.Chrome -e --source winget --accept-source-agreements --accept-package-agreements
    $chromeFound = "C:\Program Files\Google\Chrome\Application\chrome.exe"
    Write-Ok "Chrome installed."
    Add-Content $credsFile "BHW_CHROME_PATH=$chromeFound"
}

# ── 5. Firewall — block inbound (bot talks out only) ─────────────────────────
Write-Host ""
Write-Info "Step 5/5 — Firewall check (outbound-only bot, no port exposure needed)…"
Write-Ok "No inbound ports required. Defaults are fine."

# ── Summary ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "━━━  Setup Complete  ━━━" -ForegroundColor Green
Write-Host ""
Write-Host "Credentials saved to:   C:\bhw-bot-creds.txt" -ForegroundColor Yellow
Write-Host "NEXT STEP: run .\deploy\deploy.ps1" -ForegroundColor Cyan
Write-Host ""
