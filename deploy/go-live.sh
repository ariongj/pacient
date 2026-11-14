#!/usr/bin/env bash
# Pacient API on the VPS: install or upgrade in one command.
#
#   deploy/go-live.sh --web-url https://pacienti.itdks.tech [--api-url https://pacienti-api.itdks.tech]
#
# First run: creates the private settings (.env.vps), builds the API image, starts PostgreSQL,
# applies the database migrations and starts the API on 127.0.0.1:18840. Later runs (after a
# `git pull`) upgrade the same way. Safe to repeat: it never replaces .env.vps, never deletes data
# and stops before changing anything if a check fails.
#
#   --no-build   use the image that is already there (e.g. one pulled from a registry)
#
# With BACKUP_AGE_RECIPIENT set, an encrypted backup is taken before an upgrade (deploy/backup.sh).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

WEB_URL='' API_URL='' BUILD=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --web-url) WEB_URL=${2:-}; shift 2 ;;
    --api-url) API_URL=${2:-}; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    -h | --help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

ENV_FILE=.env.vps
COMPOSE=(docker compose --env-file "$ENV_FILE" -f deploy/compose.vps.yml)
step() { printf '\n== %s\n' "$*"; }
fail() { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
https_url() { [[ "$1" =~ ^https://[a-z0-9.-]+(:[0-9]+)?/?$ ]]; }

[[ -z $WEB_URL ]] || https_url "$WEB_URL" || fail "--web-url must be a plain https:// address."
[[ -z $API_URL ]] || https_url "$API_URL" || fail "--api-url must be a plain https:// address."

step "Checking the server"
command -v docker >/dev/null || fail "Docker is not installed."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 ('docker compose') is not available."
docker info >/dev/null 2>&1 || fail "Docker is not running, or this user may not use it."
command -v python3 >/dev/null || fail "python3 is needed to create the private settings."
command -v curl >/dev/null || fail "curl is needed for the health check."
free_gb=$(df -Pk . | awk 'NR == 2 { print int($4 / 1048576) }')
[[ $free_gb -ge 5 ]] || fail "Only $free_gb GB of free disk space; at least 5 GB are needed."
echo "Docker $(docker version --format '{{.Server.Version}}'), $free_gb GB free, commit $(git rev-parse --short HEAD 2>/dev/null || echo '?')."

step "Private settings"
if [[ -f $ENV_FILE ]]; then
  [[ $(stat -c %a "$ENV_FILE") == 600 ]] ||
    fail "$ENV_FILE must be readable by its owner only: chmod 600 $ENV_FILE"
  echo "Using the existing $ENV_FILE (it is never replaced)."
else
  [[ -n $WEB_URL ]] || fail "First run: give the frontend address, e.g. --web-url https://pacienti.itdks.tech"
  python3 deploy/init-env.py --web-url "$WEB_URL"
  echo "Keep a protected copy of $ENV_FILE elsewhere: without it the database and the two-step"
  echo "sign-in secrets cannot be recovered."
fi
setting() { grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-; }
WEB_APP_URL=$(setting WEB_APP_URL)
BIND=$(setting PACIENTI_BIND_ADDRESS); BIND=${BIND:-127.0.0.1}
PORT=$(setting PACIENTI_PORT); PORT=${PORT:-18840}
if [[ -n $WEB_URL && ${WEB_URL%/} != "$WEB_APP_URL" ]]; then
  fail "--web-url ($WEB_URL) differs from WEB_APP_URL in $ENV_FILE ($WEB_APP_URL). Change $ENV_FILE deliberately if the address really changed."
fi
[[ $BIND == 127.0.0.1 ]] || echo "Note: the API listens on $BIND, not only on this machine."

running=$("${COMPOSE[@]}" ps -q api 2>/dev/null || true)
if [[ -z $running ]] && command -v ss >/dev/null && ss -ltnH "( sport = :$PORT )" | grep -q .; then
  fail "Port $PORT is already used by another program. Set PACIENTI_PORT in $ENV_FILE."
fi

if [[ -n $("${COMPOSE[@]}" ps -q db 2>/dev/null || true) ]]; then
  if [[ -n ${BACKUP_AGE_RECIPIENT:-} ]]; then
    step "Backup before the upgrade"
    PACIENT_COMPOSE=deploy/compose.vps.yml PACIENT_ENV_FILE=$ENV_FILE deploy/backup.sh
  else
    echo "Note: no backup taken before this upgrade (set BACKUP_AGE_RECIPIENT to take one)."
  fi
fi

if [[ $BUILD == 1 ]]; then
  step "Building the API image (a few minutes the first time)"
  "${COMPOSE[@]}" build migrate
fi

step "Starting the database, applying migrations, starting the API"
if ! "${COMPOSE[@]}" up -d; then
  "${COMPOSE[@]}" logs --tail 40 migrate api || true
  fail "Starting failed (logs above). Nothing was deleted; fix the cause and run this again."
fi

step "Waiting for the API"
ready=0
for _ in $(seq 1 60); do
  if curl -fsS "http://$BIND:$PORT/health/ready" >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
if [[ $ready != 1 ]]; then
  "${COMPOSE[@]}" ps || true
  "${COMPOSE[@]}" logs --tail 40 api || true
  fail "The API did not become ready within 2 minutes (logs above)."
fi
"${COMPOSE[@]}" ps --format '{{.Service}}: {{.Status}}' 2>/dev/null || "${COMPOSE[@]}" ps

API=${API_URL%/}
API=${API:-https://YOUR-API-ADDRESS}
WEB_HOST=${WEB_APP_URL#https://}
OWNER=$(git remote get-url origin 2>/dev/null | sed -E 's#(\.git)?/?$##; s#.*[/:]([^/:]+)/[^/]+$#\1#' || true)
OWNER=${OWNER:-github-user}
cat <<NEXT

The API is ready on http://$BIND:$PORT (this machine only).

Next steps (each only once):
  1. HTTPS: route $API to http://127.0.0.1:$PORT in the web server or proxy,
     e.g. deploy/proxy/nginx-pacienti-api.conf or deploy/proxy/Caddyfile.
  2. First administrator:  deploy/first-admin.sh OWNER-EMAIL
  3. GitHub › Settings › Pages: source "GitHub Actions"; Environments › github-pages: allow
     the branch the workflow runs on; Secrets and variables › Actions › Variables:
       PACIENTI_API_BASE_URL   = $API/api/v1
       PACIENTI_WEB_DOMAIN     = $WEB_HOST
       PACIENTI_DEPLOY_ENABLED = true
     DNS: CNAME ${WEB_HOST%%.*} → $OWNER.github.io. Then run "Pacient frontend".
  4. Check it from anywhere:  node deploy/smoke-test.mjs --web $WEB_APP_URL --api $API
  5. Nightly encrypted backups: deploy/systemd/ (see deploy/README.md).
NEXT
