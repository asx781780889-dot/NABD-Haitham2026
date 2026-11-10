#!/usr/bin/env bash
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
up() { "$@" >/dev/null 2>&1 && echo "running" || echo "stopped"; }
echo "PostgreSQL : $(up pg_running)"; echo "Redis      : $(up redis_running)"
for n in api worker; do f="$RUN_DIR/$n.sup.pid"; printf '%-11s: ' "$n"; if [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null; then echo "running (supervisor pid $(cat "$f"))"; else echo "stopped"; fi; done
node -e "fetch('http://127.0.0.1:$(app_port)/ready').then(async r=>console.log('/ready     :', r.status, await r.text())).catch(()=>console.log('/ready     : unreachable'))"
