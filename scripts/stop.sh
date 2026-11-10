#!/usr/bin/env bash
# Stops the API and worker (graceful). Use --all to also stop PostgreSQL and Redis.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
touch "$RUN_DIR/stop"
for name in worker api; do
  f="$RUN_DIR/$name.sup.pid"
  if [ -f "$f" ]; then
    sup="$(cat "$f")"
    pkill -TERM -P "$sup" 2>/dev/null; kill "$sup" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$sup" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$sup" 2>/dev/null; rm -f "$f"; log "$name stopped"
  fi
done
rm -f "$RUN_DIR/stop"
if [ "${1:-}" = "--all" ]; then
  pg_running && pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null && log "PostgreSQL stopped"
  redis_running && redis-cli -h 127.0.0.1 -p "$(redis_port)" shutdown nosave >/dev/null 2>&1 && log "Redis stopped"
  command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock
fi
exit 0
