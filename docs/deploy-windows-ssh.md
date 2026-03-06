# Deploy to Windows Server via SSH — Universal Guide

This guide documents the full deployment of the BHW Outbound Bot to a Windows
server using only SSH (no RDP). Every quirk discovered is logged so future
deploys on similar servers are faster.

**Server:** `100.110.133.96` (Tailscale IP) | User: `zeeshan` | OS: Windows 10 Pro 64-bit (build 26200)

---

## Prerequisites (verified on this server)

| Component | Version | Notes |
|---|---|---|
| Node.js | v22.17.0 | Already installed |
| npm | 10.9.2 | Already installed |
| Git | 2.50.1.windows.1 | Already installed |
| PM2 | 6.0.14 | `npm install -g pm2` |
| PostgreSQL | **18.1** | Already installed at `C:\Program Files\PostgreSQL\18\bin\` |
| Chrome | latest | `C:\Program Files\Google\Chrome\Application\chrome.exe` |

---

## Step 1 — SSH Access

```bash
# Requires sshpass on Mac
brew install hudochenkov/sshpass/sshpass

sshpass -p 'PASSWORD' ssh -o StrictHostKeyChecking=no zeeshan@HOST
```

**Quirk:** Interactive SSH (`ssh zeeshan@HOST`) prompts for password in a way
that doesn't work well in scripted contexts. Always use `sshpass -p`.

---

## Step 2 — PM2 in PATH

After a fresh `npm install -g pm2`, PM2 installs to `%APPDATA%\npm\` which is
not in PATH by default. Run this once:

```powershell
# Run on server (PowerShell)
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*AppData\Roaming\npm*") {
    [Environment]::SetEnvironmentVariable(
        "Path",
        "$userPath;$env:APPDATA\npm",
        "User"
    )
}
```

After running, **new SSH sessions** will have `pm2` in PATH. Existing sessions need to be closed.

**Quirk:** `pm2` works in PowerShell only with `-ExecutionPolicy Bypass` — the
default policy blocks `.ps1` scripts. Always run:
```bash
powershell -ExecutionPolicy Bypass -Command "pm2 ..."
```

---

## Step 3 — PostgreSQL Setup

### Credentials established on this server

| Item | Value |
|---|---|
| postgres superuser password | `Postgres2024!` |
| botuser password | `BhwBot2024!` |
| Database | `bhw_bot` |

### Critical: always use `-h 127.0.0.1`

```bash
# WRONG — hangs (tries Unix socket, which doesn't exist on Windows)
psql -U botuser -d bhw_bot

# CORRECT
psql -h 127.0.0.1 -U botuser -d bhw_bot
```

### Set PGPASSWORD via PowerShell (not env var in cmd)

```powershell
$env:PGPASSWORD = "BhwBot2024!"
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -h 127.0.0.1 -U botuser -d bhw_bot -c "\l"
```

**Quirk:** Passing `PGPASSWORD=xxx` as a suffix to a command in `cmd` shell is
ignored. Use PowerShell `$env:PGPASSWORD` or SCP a `.ps1` file and run it.

### Reset postgres superuser password (if locked out)

1. Edit `C:\Program Files\PostgreSQL\18\data\pg_hba.conf`
2. Change `md5` / `scram-sha-256` to `trust` for `127.0.0.1/32`
3. Restart: `net stop postgresql-x64-18 && net start postgresql-x64-18`
4. `psql -h 127.0.0.1 -U postgres -c "ALTER USER postgres PASSWORD 'NewPass';"`
5. Revert `pg_hba.conf` back to `md5` and restart again

### pg_hba.conf auth on this server

```
host  all  all  127.0.0.1/32  md5            ← use this
host  all  all  ::1/128       scram-sha-256  ← IPv6, avoid
```

Always connect with `-h 127.0.0.1` and set `DB_HOST=127.0.0.1` in `.env`.

---

## Step 4 — Clone the Repo (Private)

GitHub credential manager hangs interactively over SSH. Embed token in URL:

```bash
# Get token from local Mac git credential store
git credential fill <<< $'protocol=https\nhost=github.com\n'

# Clone with embedded credentials
sshpass -p 'PASSWORD' ssh USER@HOST \
  "git clone https://USERNAME:TOKEN@github.com/ORG/REPO.git C:\\bhw-bot 2>&1"
```

**Quirk:** Git will print `fatal: Unable to persist credentials with the 'wincredman'
credential store` — this is non-fatal. The clone succeeds regardless. Check with
`Test-Path C:\bhw-bot\package.json`.

---

## Step 5 — npm install

```bash
sshpass -p 'PASSWORD' ssh USER@HOST "cd C:\\bhw-bot && npm install 2>&1"
```

First run takes 2–3 minutes (Puppeteer downloads Chromium). Subsequent runs are
fast. If it times out, just run again — npm is idempotent.

---

## Step 6 — Write .env

PowerShell here-strings (`@'...'@`) are fragile over SSH due to quoting escapes.
The reliable approach: write the file locally and SCP it.

```bash
# Write locally
cat > /tmp/.env.server << 'EOF'
DB_HOST=127.0.0.1
DB_PORT=5432
...
EOF

# SCP to server
sshpass -p 'PASSWORD' scp /tmp/.env.server USER@HOST:"C:/bhw-bot/.env"
```

---

## Step 7 — Database Schema

`init.js` starts with `ALTER TABLE conversations ...` — this assumes the base
tables already exist. On a **fresh database**, run the base schema first.

```bash
# SCP the base schema SQL
sshpass -p 'PASSWORD' scp bhw_base_schema.sql USER@HOST:"C:/bhw-bot/bhw_base_schema.sql"

# Run it via a PS1 script (to handle PGPASSWORD correctly)
cat > /tmp/run_schema.ps1 << 'EOF'
$env:PGPASSWORD = "BhwBot2024!"
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -h 127.0.0.1 -U botuser -d bhw_bot -f "C:\bhw-bot\bhw_base_schema.sql"
EOF

sshpass -p 'PASSWORD' scp /tmp/run_schema.ps1 USER@HOST:"C:/bhw-bot/run_schema.ps1"
sshpass -p 'PASSWORD' ssh USER@HOST \
  "powershell -ExecutionPolicy Bypass -File C:\\bhw-bot\\run_schema.ps1 2>&1"
```

Then run the Node migrations:

```bash
sshpass -p 'PASSWORD' ssh USER@HOST \
  "cd C:\\bhw-bot && node -e \"import('./src/database/init.js').then(m => m.initDatabase()).then(() => { console.log('OK'); process.exit(0); })\""
```

---

## Step 8 — Seed Outreach Targets

```bash
# Export from local DB
psql -U localuser -d bhw_bot \
  -c "\COPY (SELECT thread_url, title FROM outreach_targets ORDER BY id) TO '/tmp/targets.csv' WITH CSV HEADER"

# SCP to server
sshpass -p 'PASSWORD' scp /tmp/targets.csv USER@HOST:"C:/bhw-bot/targets.csv"

# Seed on server
sshpass -p 'PASSWORD' ssh USER@HOST \
  "cd C:\\bhw-bot && node scripts/seed-outreach-targets.js C:\\bhw-bot\\targets.csv 2>&1"
```

---

## Step 9 — PM2 Persistent Service

**The core Windows PM2 problem:** Each SSH session spawns a fresh PM2 daemon.
`pm2 list` in a new session shows empty — the previous daemon is unreachable.

**Fix:** `pm2-windows-startup` installs PM2 as a Windows Registry startup entry.

```bash
# Install pm2-windows-startup
sshpass -p 'PASSWORD' ssh USER@HOST \
  "powershell -ExecutionPolicy Bypass -Command \"npm install -g pm2-windows-startup && pm2-startup install\""
```

**Critical:** `pm2 start` and `pm2 save` must be run in the **same SSH session**
(same daemon). Chain them with `;`:

```bash
sshpass -p 'PASSWORD' ssh USER@HOST \
  "powershell -ExecutionPolicy Bypass -Command \"\
    Set-Location C:\\bhw-bot; \
    pm2 start C:\\bhw-bot\\deploy\\ecosystem.config.cjs --env production; \
    Start-Sleep 3; \
    pm2 save; \
    pm2 list\""
```

The saved dump is at `C:\Users\zeeshan\.pm2\dump.pm2`. PM2 auto-restores from
this on next boot.

### Managing the bot after deploy

```bash
# Status
sshpass -p 'PASSWORD' ssh USER@HOST \
  "powershell -ExecutionPolicy Bypass -Command \"pm2 list\""

# Restart
sshpass -p 'PASSWORD' ssh USER@HOST \
  "powershell -ExecutionPolicy Bypass -Command \"pm2 restart bhw-bot\""

# Logs (tail)
# Read log file directly — pm2 logs --nostream doesn't work well across sessions
sshpass -p 'PASSWORD' ssh USER@HOST \
  "powershell -Command \"Get-Content 'C:\\bhw-bot\\logs\\combined.log' -Tail 30\""

# Pull latest code and restart
sshpass -p 'PASSWORD' ssh USER@HOST \
  "powershell -ExecutionPolicy Bypass -Command \"\
    Set-Location C:\\bhw-bot; \
    git pull; \
    pm2 restart bhw-bot\""
```

---

## Step 10 — Telegram Setup

No QR scan, no session files — just set two env vars in `.env`:

```
TELEGRAM_BOT_TOKEN=<your-bot-token-from-BotFather>
TELEGRAM_GROUP_ID=<negative-integer-group-chat-id>
```

**How to get the Group Chat ID:**

```bash
# Option 1 — add @userinfobot to your Telegram group, it will post the chat ID
# Option 2 — call the Telegram API after adding your bot to the group:
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
# Look for "chat":{"id":-XXXXXXXXX} in the response
```

**Bot permissions:** Add the bot to the group and grant it admin rights so it can
send messages and read all group messages (needed for slash command processing).

Once `.env` is updated and the bot restarted, it connects immediately — no manual
step required. Verify by sending `/status` in the Telegram group.

---

## Troubleshooting Log

### `psql` hangs with no output
**Cause:** No `-h` flag — tries Unix socket (doesn't exist on Windows).
**Fix:** Always use `-h 127.0.0.1`.

### PM2 list shows empty after new SSH session
**Cause:** Each session spawns a fresh daemon with no memory of previous processes.
**Fix:** `pm2-windows-startup` + always chain `pm2 start` + `pm2 save` in one session.

### `pm2` command blocked: "running scripts is disabled"
**Cause:** PowerShell default execution policy blocks `.ps1` scripts.
**Fix:** `powershell -ExecutionPolicy Bypass -Command "pm2 ..."`

### Git clone fails with "could not read Username"
**Cause:** Git Credential Manager tries to open a TTY prompt (no TTY in SSH).
**Fix:** Embed credentials in the clone URL: `https://user:token@github.com/...`

### Bot starts then crashes silently (0-byte stdout/stderr logs)
**Cause:** DB tables don't exist yet — `init.js` tries `ALTER TABLE conversations` on empty DB.
**Fix:** Run `bhw_base_schema.sql` first, then `node -e "import('./src/database/init.js')..."`.

### PowerShell here-string fails over SSH
**Cause:** SSH quoting + PowerShell here-string terminator `'@` conflicts.
**Fix:** Write the file locally and SCP it instead of generating it on-server.

### `$env:APPDATA` doesn't expand in cmd shell over SSH
**Cause:** `cmd` doesn't expand PowerShell-style env vars.
**Fix:** Use `powershell -Command "..."` or hardcode the path
(`C:\Users\zeeshan\AppData\Roaming\npm`).

### `wmic ENOENT` in PM2 logs
**Cause:** PM2 6 tries to use `wmic` for CPU stats on Windows; not always present.
**Impact:** Cosmetic only — bot runs fine.

### PostgreSQL 18 vs scripts referencing PostgreSQL 16
**Cause:** Deploy scripts (`deploy.ps1`, `win-remote-setup.ps1`) reference
`C:\Program Files\PostgreSQL\16\bin\`. Server has PostgreSQL 18.
**Fix:** Update path references to `...\PostgreSQL\18\bin\` or use the binary
already in Machine PATH (`psql` works without full path).
