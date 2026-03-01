#!/usr/bin/env bash
# =============================================================================
# Bitbash BHW Bot — Fresh Ubuntu VPS Setup
# =============================================================================
# Run this ONCE on a fresh Ubuntu 22.04 / 24.04 server as root or sudo user.
#
# What it installs:
#   - Node.js 20 LTS (via NodeSource)
#   - npm + PM2 (process manager — keeps bot alive after crashes/reboots)
#   - PostgreSQL 16
#   - Chromium + all Puppeteer Linux dependencies (for BHW scraper + WA client)
#   - Git
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zeeshana1233/bhw-outbound-bot/main/deploy/setup.sh | bash
#   -- OR --
#   chmod +x deploy/setup.sh && sudo bash deploy/setup.sh
# =============================================================================

set -euo pipefail

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
RESET="\033[0m"

info()  { echo -e "${CYAN}[setup]${RESET} $*"; }
ok()    { echo -e "${GREEN}[  OK ]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[ WARN]${RESET} $*"; }
step()  { echo -e "\n${BOLD}${CYAN}━━━  $*  ━━━${RESET}\n"; }

# ─────────────────────────────────────────────────
# 1. System update
# ─────────────────────────────────────────────────
step "1 / 6 — System Update"
apt-get update -qq && apt-get upgrade -y -qq
ok "System packages updated."

# ─────────────────────────────────────────────────
# 2. Node.js 20 LTS
# ─────────────────────────────────────────────────
step "2 / 6 — Node.js 20 LTS"
if command -v node &>/dev/null; then
  warn "Node.js already installed: $(node -v) — skipping."
else
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  ok "Node.js installed: $(node -v)"
fi

npm install -g pm2 --quiet
pm2 startup systemd -u root --hp /root | tail -1 | bash || true
ok "PM2 installed and configured to start on boot."

# ─────────────────────────────────────────────────
# 3. PostgreSQL 16
# ─────────────────────────────────────────────────
step "3 / 6 — PostgreSQL 16"
if command -v psql &>/dev/null; then
  warn "PostgreSQL already installed: $(psql --version) — skipping."
else
  apt-get install -y postgresql postgresql-contrib
  systemctl enable postgresql
  systemctl start postgresql
  ok "PostgreSQL installed and running."
fi

# Create DB + user (idempotent — safe to re-run)
DB_USER=${BOT_DB_USER:-"botuser"}
DB_PASS=${BOT_DB_PASS:-"$(openssl rand -base64 16)"}
DB_NAME="bhw_bot"

sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"

ok "Database '${DB_NAME}' ready — user: ${DB_USER}"

# Save DB credentials for env setup step
echo "DB_USER=${DB_USER}" >> /tmp/bot_db_creds
echo "DB_PASSWORD=${DB_PASS}" >> /tmp/bot_db_creds
echo "DB_NAME=${DB_NAME}" >> /tmp/bot_db_creds

# ─────────────────────────────────────────────────
# 4. Chromium + Puppeteer Linux dependencies
# ─────────────────────────────────────────────────
step "4 / 6 — Chromium + Puppeteer Dependencies"
apt-get install -y \
  chromium-browser \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libgbm1 libasound2 \
  fonts-liberation libappindicator3-1 xdg-utils \
  libx11-xcb1 libxcb-dri3-0 libxss1 \
  wget ca-certificates --no-install-recommends

ok "Chromium dependencies installed."

CHROME_PATH=$(which chromium-browser 2>/dev/null || which chromium 2>/dev/null || echo "not found")
info "Chrome path: ${CHROME_PATH}"
echo "CHROME_PATH=${CHROME_PATH}" >> /tmp/bot_db_creds

# ─────────────────────────────────────────────────
# 5. Git
# ─────────────────────────────────────────────────
step "5 / 6 — Git"
apt-get install -y git
ok "Git installed: $(git --version)"

# ─────────────────────────────────────────────────
# 6. Summary
# ─────────────────────────────────────────────────
step "6 / 6 — Setup Complete"
echo ""
echo "  Node.js : $(node -v)"
echo "  npm     : $(npm -v)"
echo "  PM2     : $(pm2 -v)"
echo "  psql    : $(psql --version)"
echo "  chrome  : ${CHROME_PATH}"
echo ""
echo "  DB credentials saved to: /tmp/bot_db_creds"
echo "  $(cat /tmp/bot_db_creds)"
echo ""
echo -e "${GREEN}${BOLD}Server is ready. Now run deploy/deploy.sh to clone and start the bot.${RESET}"
