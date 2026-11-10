#!/usr/bin/env bash
# One-shot installer for Termux (also works on Debian/Ubuntu if node, postgresql and redis are installed).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$NABD_DIR"

log "NABD AI setup ($(is_termux && echo Termux || echo Linux))"
if [ -z "${NABD_SKIP_PKG:-}" ]; then
  if is_termux; then
    log "Installing packages (nodejs, postgresql, redis)…"
    pkg update -y
    pkg install -y nodejs-lts postgresql redis
  else
    warn "Not running in Termux: make sure nodejs>=18, postgresql and redis are installed."
  fi
fi
need node "In Termux: pkg install nodejs-lts"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || die "Node.js 18 or newer is required (found $(node -v))."
need initdb "In Termux: pkg install postgresql"; need pg_ctl; need psql; need createdb; need redis-server "In Termux: pkg install redis"; need redis-cli

if is_termux; then  # node-gyp workaround for optional native modules on Android
  mkdir -p "$HOME/.gyp"; [ -f "$HOME/.gyp/include.gypi" ] || echo "{'variables':{'android_ndk_path':''}}" > "$HOME/.gyp/include.gypi"
fi

log "Installing Node dependencies (pure JavaScript - native build scripts are skipped)…"
if [ -f package-lock.json ]; then npm ci --omit=dev --ignore-scripts --no-audit --no-fund || npm install --omit=dev --ignore-scripts --no-audit --no-fund
else npm install --omit=dev --ignore-scripts --no-audit --no-fund; fi

if [ ! -f .env ]; then
  DBPW="$(node -e 'console.log(require("crypto").randomBytes(18).toString("hex"))')"
  node scripts/gen-env.js --db-password "$DBPW" --port "${NABD_PORT:-8080}" --db-port "${NABD_DB_PORT:-5432}" --redis-port "${NABD_REDIS_PORT:-6379}"
fi
DBPW="$(env_get DATABASE_URL | sed -E 's#^[a-z]+://[^:]+:([^@]+)@.*#\1#')"
[ -n "$DBPW" ] || die "Could not read the database password from .env"

if [ ! -d "$PGDATA" ]; then
  log "Creating the PostgreSQL cluster at $PGDATA …"
  PWFILE="$(mktemp)"; chmod 600 "$PWFILE"; printf '%s\n' "$DBPW" > "$PWFILE"
  initdb -D "$PGDATA" -U nabd -E UTF8 --locale=C --auth-local=trust --auth-host=scram-sha-256 --pwfile="$PWFILE" >/dev/null
  rm -f "$PWFILE"
fi
start_pg
if ! psql -h "$RUN_DIR" -p "$(db_port)" -U nabd -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='nabd'" | grep -q 1; then
  log "Creating database 'nabd'…"; createdb -h "$RUN_DIR" -p "$(db_port)" -U nabd nabd
fi
start_redis

log "Applying database migrations…"
node scripts/migrate.js
chmod 600 .env 2>/dev/null || true
cat <<MSG

  Setup complete.

  Start NABD AI :   bash scripts/start.sh
  Then open     :   http://127.0.0.1:$(app_port)   (create the administrator, follow the 7 onboarding steps)
  Status / logs :   bash scripts/status.sh   |   bash scripts/logs.sh

  IMPORTANT: back up the MASTER_KEY line of .env somewhere safe.

MSG
