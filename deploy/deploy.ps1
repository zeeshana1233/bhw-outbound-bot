# =============================================================================
# Bitbash BHW Bot — Deploy / Update Script (Windows)
# =============================================================================
# Run after setup.ps1.  Works for first deploy AND future updates.
#
# First deploy:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\deploy\deploy.ps1
#
# Pull latest code + restart:
#   .\deploy\deploy.ps1 -Update
# =============================================================================

param(
    [switch]$Update
)

$ErrorActionPreference = "Stop"

function Write-Info  { Write-Host "[deploy] $args" -ForegroundColor Cyan }
function Write-Ok    { Write-Host "[  OK  ] $args" -ForegroundColor Green }
function Write-Warn  { Write-Host "[ WARN ] $args" -ForegroundColor Yellow }
function Write-Fail  { Write-Host "[ FAIL ] $args" -ForegroundColor Red; exit 1 }
function Prompt-Value {
    param([string]$Label, [string]$Default = "")
    if ($Default) {
        $val = Read-Host "$Label [$Default]"
        if ([string]::IsNullOrWhiteSpace($val)) { return $Default }
        return $val
    }
    return Read-Host $Label
}

$AppDir = "C:\bhw-bot"
$Repo   = "https://github.com/zeeshana1233/bhw-outbound-bot.git"

Write-Host ""
Write-Host "━━━  BHW Bot — Windows Deploy  ━━━" -ForegroundColor Cyan
Write-Host ""

# ─────────────────────────────────────────────────────────────────────────────
# UPDATE MODE
# ─────────────────────────────────────────────────────────────────────────────
if ($Update) {
    Write-Info "Update mode — pulling latest code…"
    Set-Location $AppDir
    git pull origin main
    npm install --omit=dev
    pm2 restart bhw-bot --update-env
    pm2 save
    Write-Ok "Update complete. Bot restarted."
    pm2 status
    exit 0
}

# ─────────────────────────────────────────────────────────────────────────────
# FIRST DEPLOY
# ─────────────────────────────────────────────────────────────────────────────

# ── Clone repo ───────────────────────────────────────────────────────────────
Write-Info "Step 1/5 — Clone repo…"
if (Test-Path "$AppDir\.git") {
    Write-Warn "Repo already exists at $AppDir — pulling latest."
    Set-Location $AppDir
    git pull origin main
} else {
    git clone $Repo $AppDir
    Set-Location $AppDir
}
Write-Ok "Repo ready at $AppDir"

# ── npm install ───────────────────────────────────────────────────────────────
Write-Info "Step 2/5 — Installing dependencies…"
npm install --omit=dev
Write-Ok "npm install complete."

# ── .env setup ───────────────────────────────────────────────────────────────
Write-Info "Step 3/5 — Setting up .env file…"

if (Test-Path "$AppDir\.env") {
    $overwrite = Read-Host ".env already exists. Overwrite? (y/N)"
    if ($overwrite -ne "y") {
        Write-Ok "Keeping existing .env."
    } else {
        Remove-Item "$AppDir\.env"
    }
}

if (-not (Test-Path "$AppDir\.env")) {
    # Load DB creds saved by setup.ps1
    $dbHost = "localhost"; $dbPort = "5432"; $dbName = "bhw_bot"; $dbUser = "botuser"; $dbPass = ""
    if (Test-Path "C:\bhw-bot-creds.txt") {
        Get-Content "C:\bhw-bot-creds.txt" | ForEach-Object {
            if ($_ -match "^DB_HOST=(.+)")     { $dbHost = $Matches[1] }
            if ($_ -match "^DB_PORT=(.+)")     { $dbPort = $Matches[1] }
            if ($_ -match "^DB_NAME=(.+)")     { $dbName = $Matches[1] }
            if ($_ -match "^DB_USER=(.+)")     { $dbUser = $Matches[1] }
            if ($_ -match "^DB_PASSWORD=(.+)") { $dbPass = $Matches[1] }
        }
    }

    # Detect Chrome path
    $chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
    if (Test-Path "C:\bhw-bot-creds.txt") {
        $line = Select-String "BHW_CHROME_PATH" "C:\bhw-bot-creds.txt" -ErrorAction SilentlyContinue
        if ($line) { $chromePath = $line.Line.Split("=",2)[1] }
    }

    Write-Host ""
    Write-Host "Enter the following values (press Enter to accept defaults):" -ForegroundColor Yellow
    Write-Host ""

    $openaiKey  = Prompt-Value "OPENAI_API_KEY"
    $waGroup    = Prompt-Value "WA_GROUP_NAME (WhatsApp group name)" "Bitbash BHW Bot"
    $bhwUser    = Prompt-Value "BHW_USERNAME (your BHW login email)"
    $bhwPass    = Prompt-Value "BHW_PASSWORD (your BHW login password)"
    $bhwChromeP = Prompt-Value "BHW_CHROME_PROFILE_PATH (Chrome exe path)" $chromePath

    @"
# ── Database ────────────────────────────────────────────────────────────────
DB_HOST=$dbHost
DB_PORT=$dbPort
DB_NAME=$dbName
DB_USER=$dbUser
DB_PASSWORD=$dbPass

# ── OpenAI ──────────────────────────────────────────────────────────────────
OPENAI_API_KEY=$openaiKey

# ── WhatsApp ─────────────────────────────────────────────────────────────────
WA_GROUP_NAME=$waGroup

# ── BHW Scraper ──────────────────────────────────────────────────────────────
BHW_USERNAME=$bhwUser
BHW_PASSWORD=$bhwPass
BHW_CHROME_PROFILE_PATH=$bhwChromeP

# ── Environment ──────────────────────────────────────────────────────────────
NODE_ENV=production
"@ | Set-Content "$AppDir\.env"
    Write-Ok ".env written."
}

# ── Session files reminder ────────────────────────────────────────────────────
Write-Host ""
Write-Warn "━━━  IMPORTANT: Upload session files via RDP  ━━━"
Write-Host ""
Write-Host "  Copy these from your LOCAL Mac to $AppDir on the server:" -ForegroundColor Yellow
Write-Host "  1. bhw-cookies.json       → $AppDir\bhw-cookies.json"
Write-Host "  2. .wwebjs_auth\  (folder) → $AppDir\.wwebjs_auth\"
Write-Host ""
Write-Host "  Easiest way via RDP:" -ForegroundColor Cyan
Write-Host "  • Open File Explorer on your Mac, copy the files"
Write-Host "  • In the RDP window, they paste directly into the server's Explorer"
Write-Host ""
$ready = Read-Host "Have you copied the session files? (y to continue, n to skip for now)"
if ($ready -ne "y") {
    Write-Warn "Reminder: bot will need a fresh BHW login + WhatsApp QR scan without session files."
}

# ── DB migrations ─────────────────────────────────────────────────────────────
Write-Info "Step 4/5 — Running DB migrations…"
node -e "
  import('./src/database/init.js')
    .then(m => m.initDatabase ? m.initDatabase() : m.default?.initDatabase?.())
    .then(() => { console.log('DB init OK'); process.exit(0); })
    .catch(e => { console.error('DB init failed:', e.message); process.exit(1); })
"
Write-Ok "Database schema ready."

# ── PM2 start ─────────────────────────────────────────────────────────────────
Write-Info "Step 5/5 — Starting bot with PM2…"
pm2 start deploy/ecosystem.config.cjs --env production
pm2 save
Write-Ok "Bot started."

# ── Summary ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "━━━  Deployment Complete  ━━━" -ForegroundColor Green
Write-Host ""
pm2 status
Write-Host ""
Write-Host "  Useful commands:" -ForegroundColor Cyan
Write-Host "    pm2 logs bhw-bot              — tail live logs"
Write-Host "    pm2 status                    — process status"
Write-Host "    pm2 restart bhw-bot           — restart"
Write-Host "    pm2 stop bhw-bot              — stop"
Write-Host "    .\deploy\deploy.ps1 -Update   — pull latest code + restart"
Write-Host ""
