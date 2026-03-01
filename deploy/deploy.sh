#!/usr/bin/env bash
# =============================================================================
# Bitbash BHW Bot — Deploy / Update Script
# =============================================================================
# Run this after setup.sh to clone the repo and start the bot.
# Also use it to pull updates and restart.
#
# Usage — first deploy:
#   bash deploy/deploy.sh
#
# Usage — update (pull new code + restart):
#   bash deploy/deploy.sh --update
# =============================================================================

set -euo pipefail

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
RED="\033[31m"
RESET="\033[0m"

info()  { echo -e "${CYAN}[deploy]${RESET} $*"; }
ok()    { echo -e "${GREEN}[  OK  ]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[ WARN ]${RESET} $*"; }
fail()  { echo -e "${RED}[ FAIL ]${RESET} $*"; exit 1; }

REPO="https://github.com/zeeshana1233/bhw-outbound-bot.git"
APP_DIR="/root/bhw-bot"
UPDATE=${1:-""}

# ─────────────────────────────────────────────────────────────────────────────
# UPDATE MODE — pull latest code and restart
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$UPDATE" == "--update" ]]; then
  echo -e "\n${BOLD}${CYAN}━━━  Updating BHW Bot  ━━━${RESET}\n"
  cd "$APP_DIR"
  git pull origin main
  npm install --omit=dev
  pm2 restart bhw-bot --update-env
  pm2 save
  ok "Update complete. Bot restarted."
  pm2 status
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# FIRST DEPLOY
# ─────────────────────────────────────────────────────────────────────────────
echo -e "\n${BOLD}${CYAN}━━━  Deploying BHW Bot  ━━━${RESET}\n"

# ── Clone repo ───────────────────────────────────────────────────────────────
if [[ -d "$APP_DIR/.git" ]]; then
  warn "Repo already cloned at ${APP_DIR} — pulling latest."
  cd "$APP_DIR" && git pull origin main
else
  info "Cloning repo to ${APP_DIR}…"
  git clone "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi
ok "Repo ready at ${APP_DIR}"

# ── Install dependencies ──────────────────────────────────────────────────────
info "Installing npm dependencies…"
npm install --omit=dev
ok "Dependencies installed."

# ── .env check ───────────────────────────────────────────────────────────────
if [[ ! -f "${APP_DIR}/.env" ]]; then
  fail ".env file not found at ${APP_DIR}/.env\nUpload it first: scp .env root@SERVER:${APP_DIR}/.env"
fi
ok ".env found."

# ── Session files check ───────────────────────────────────────────────────────
if [[ ! -f "${APP_DIR}/bhw-cookies.json" ]]; then
  warn "bhw-cookies.json missing — BHW session will not work until you upload it."
  warn "Run:  scp bhw-cookies.json root@SERVER:${APP_DIR}/"
fi

if [[ ! -d "${APP_DIR}/.wwebjs_auth" ]]; then
  warn ".wwebjs_auth/ missing — WhatsApp will require a QR scan on first start."
  warn "Run:  scp -r .wwebjs_auth root@SERVER:${APP_DIR}/"
fi

# ── DB schema ────────────────────────────────────────────────────────────────
info "Running DB migrations…"
node -e "
  import('./src/database/init.js')
    .then(m => m.initDatabase ? m.initDatabase() : m.default?.initDatabase?.())
    .then(() => { console.log('DB init OK'); process.exit(0); })
    .catch(e => { console.error('DB init failed:', e.message); process.exit(1); })
"
ok "Database schema ready."

# ── PM2 start ────────────────────────────────────────────────────────────────
info "Starting bot with PM2…"
pm2 start deploy/ecosystem.config.cjs --env production
pm2 save
ok "Bot started."

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}━━━  Deployment Complete  ━━━${RESET}"
echo ""
pm2 status
echo ""
echo "  Useful commands:"
echo "    pm2 logs bhw-bot           — tail live logs"
echo "    pm2 status                 — process status"
echo "    pm2 restart bhw-bot        — restart"
echo "    pm2 stop bhw-bot           — stop"
echo "    bash deploy/deploy.sh --update  — pull latest code + restart"
echo ""
