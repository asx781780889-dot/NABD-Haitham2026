#!/usr/bin/env bash
# Starts PostgreSQL, Redis, the API and the worker. API and worker run under a tiny restart-on-crash supervisor.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$NABD_DIR"
[ -f .env ] || die ".env not found. Run: bash scripts/termux-setup.sh"
[ -d node_modules ] || die "Dependencies missing. Run: bash scripts/termux-setup.sh"
need node; need pg_ctl; need redis-server

rm -f "$RUN_DIR/stop"
start_pg; start_redis
if command -v termux-wake-lock >/dev/null 2>&1; then termux-wake-lock && log "Wake lock acquired (keeps Termux alive in the background)"; fi

launch() {  # launch <name> <command...>
  local name="$1"; shift
  if [ -f "$RUN_DIR/$name.sup.pid" ] && kill -0 "$(cat "$RUN_DIR/$name.sup.pid")" 2>/dev/null; then log "$name already running"; return 0; fi
  nohup bash -c '
    name="$1"; shift; cd "$NABD_DIR"
    while [ ! -f "$RUN_DIR/stop" ]; do
      "$@" >> "$LOG_DIR/$name.log" 2>&1; code=$?
      [ -f "$RUN_DIR/stop" ] && break
      echo "[$(date +%FT%T)] $name exited with code $code - restarting in 3s" >> "$LOG_DIR/$name.log"; sleep 3
    done' _ "$name" "$@" >/dev/null 2>&1 &
  echo $! > "$RUN_DIR/$name.sup.pid"; log "$name started (logs: data/logs/$name.log)"
}
launch api node src/server.js
[ "${1:-}" = "--no-worker" ] || launch worker node src/worker.js

PORT="$(app_port)"
for _ in $(seq 1 40); do node -e "fetch('http://127.0.0.1:$PORT/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && break; sleep 0.5; done \
  && log "NABD AI is up →  http://127.0.0.1:$PORT" || warn "API did not answer yet - check: bash scripts/logs.sh api"
