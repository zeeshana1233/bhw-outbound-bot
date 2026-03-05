# Remote setup script — runs on the Windows server
# Uploaded via SCP and triggered with: powershell -File C:\bhw-setup.ps1

$ErrorActionPreference = "SilentlyContinue"

function Log { param($msg) $ts = Get-Date -Format "HH:mm:ss"; Write-Host "[$ts] $msg"; Add-Content "C:\bhw-setup-log.txt" "[$ts] $msg" }

Log "=== BHW Bot Windows Setup Started ==="

# ── PostgreSQL via choco (fresh attempt) ─────────────────────────────────────
Log "Checking PostgreSQL..."
$psqlPath = "C:\Program Files\PostgreSQL\16\bin\psql.exe"
if (Test-Path $psqlPath) {
    Log "PostgreSQL already installed."
} else {
    Log "Installing PostgreSQL 16 via chocolatey..."
    & choco install postgresql16 --params "/Password:bhwbot2024" --ia "--enable_acledit 1" -y 2>&1 | ForEach-Object { Log $_ }
    # refresh path
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

# ── Add psql to PATH ─────────────────────────────────────────────────────────
$pgBin = "C:\Program Files\PostgreSQL\16\bin"
if (Test-Path $pgBin) {
    $mp = [System.Environment]::GetEnvironmentVariable("Path","Machine")
    if ($mp -notlike "*$pgBin*") {
        [System.Environment]::SetEnvironmentVariable("Path","$mp;$pgBin","Machine")
        Log "Added $pgBin to PATH"
    }
    $env:Path = "$env:Path;$pgBin"
}

# ── Create DB user and database ───────────────────────────────────────────────
Log "Creating botuser and bhw_bot database..."
$env:PGPASSWORD = "bhwbot2024"
$pgBinFull = if (Test-Path $pgBin) { $pgBin } else { "C:\pg16\pgsql\bin" }

$sql = @"
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'botuser') THEN
    CREATE ROLE botuser LOGIN PASSWORD 'BhwBot2024Secure!';
  ELSE
    ALTER ROLE botuser WITH LOGIN PASSWORD 'BhwBot2024Secure!';
  END IF;
END
`$`$;
SELECT 'exists' FROM pg_database WHERE datname = 'bhw_bot'
"@

$sqlFile = "C:\setup_db.sql"
$sql | Set-Content $sqlFile

try {
    & "$pgBinFull\psql.exe" -U postgres -f $sqlFile 2>&1 | ForEach-Object { Log $_ }
    
    # Create DB (separate command to avoid duplicate error)
    & "$pgBinFull\psql.exe" -U postgres -c "CREATE DATABASE bhw_bot OWNER botuser;" 2>&1 | ForEach-Object { Log $_ }
    & "$pgBinFull\psql.exe" -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE bhw_bot TO botuser;" 2>&1 | ForEach-Object { Log $_ }
    Log "Database setup complete."
} catch {
    Log "DB setup error: $_"
}

# ── Chrome check ─────────────────────────────────────────────────────────────
Log "Checking Chrome..."
$chromePaths = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
)
$chromeExe = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chromeExe) {
    Log "Installing Chrome via choco..."
    & choco install googlechrome -y 2>&1 | ForEach-Object { Log $_ }
    $chromeExe = "C:\Program Files\Google\Chrome\Application\chrome.exe"
}
Log "Chrome: $chromeExe"

# ── Clone or update repo ──────────────────────────────────────────────────────
$appDir = "C:\bhw-bot"
Log "Setting up repo at $appDir..."
if (Test-Path "$appDir\.git") {
    Set-Location $appDir
    & git pull origin main 2>&1 | ForEach-Object { Log $_ }
} else {
    & git clone https://github.com/zeeshana1233/bhw-outbound-bot.git $appDir 2>&1 | ForEach-Object { Log $_ }
    Set-Location $appDir
}

# ── npm install ───────────────────────────────────────────────────────────────
Log "Running npm install..."
Set-Location $appDir
& npm install 2>&1 | ForEach-Object { Log $_ }

# ── Write .env ────────────────────────────────────────────────────────────────
if (-not (Test-Path "$appDir\.env")) {
    Log "Writing .env file..."
    @"
DB_HOST=localhost
DB_PORT=5432
DB_NAME=bhw_bot
DB_USER=botuser
DB_PASSWORD=BhwBot2024Secure!
OPENAI_API_KEY=REPLACE_ME
WA_GROUP_NAME=Bitbash BHW Bot
BHW_USERNAME=REPLACE_ME
BHW_PASSWORD=REPLACE_ME
BHW_CHROME_PROFILE_PATH=$chromeExe
NODE_ENV=production
"@ | Set-Content "$appDir\.env"
    Log ".env written — REMEMBER to fill in OPENAI_API_KEY, BHW_USERNAME, BHW_PASSWORD"
} else {
    Log ".env already exists, skipping."
}

# ── Save credential summary ───────────────────────────────────────────────────
@"
=== BHW Bot Server Setup Summary ===
Date: $(Get-Date)
App Directory: C:\bhw-bot
DB: bhw_bot  User: botuser  Password: BhwBot2024Secure!
postgres superuser password: bhwbot2024
Chrome: $chromeExe

NEXT STEPS:
1. Edit C:\bhw-bot\.env and fill in:
   - OPENAI_API_KEY
   - BHW_USERNAME (your BHW login email)
   - BHW_PASSWORD (your BHW password)
2. Copy bhw-cookies.json to C:\bhw-bot\bhw-cookies.json
3. Copy .wwebjs_auth\ folder to C:\bhw-bot\.wwebjs_auth\
4. Run DB migrations: cd C:\bhw-bot && node -e "import('./src/database/init.js').then(m=>m.initDatabase())"
5. Start bot: pm2 start deploy\ecosystem.config.cjs --env production && pm2 save
"@ | Set-Content "C:\bhw-bot-summary.txt"

Log "=== Setup Complete! Read C:\bhw-bot-summary.txt ==="
Log "Full log: C:\bhw-setup-log.txt"
