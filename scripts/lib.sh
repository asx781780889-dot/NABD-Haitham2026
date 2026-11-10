#!/usr/bin/env bash
# Shared helpers for the NABD AI service scripts (Termux / Linux).
NABD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$NABD_DIR/data}"
RUN_DIR="$DATA_DIR/run"; LOG_DIR="$DATA_DIR/logs"; REDIS_DIR="$DATA_DIR/redis"
PGDATA="${NABD_PGDATA:-$DATA_DIR/pgdata}"          # keep it in Termux private storage (never /sdcard: no unix permissions there)
export NABD_DIR DATA_DIR RUN_DIR LOG_DIR REDIS_DIR PGDATA
mkdir -p "$RUN_DIR" "$LOG_DIR" "$REDIS_DIR"

is_termux() { [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ]; }
log()  { printf '\033[1;32m[nabd]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[nabd]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[nabd]\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' not found. ${2:-Install it first.}"; }
env_get() { grep -E "^$1=" "$NABD_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
app_port() { local p; p="$(env_get PORT)"; echo "${p:-8080}"; }
redis_port() { local u; u="$(env_get REDIS_URL)"; u="${u##*:}"; u="${u%%/*}"; case "$u" in ''|*[!0-9]*) echo 6379;; *) echo "$u";; esac; }
db_port() { local u; u="$(env_get DATABASE_URL)"; u="${u#*@}"; u="${u#*:}"; u="${u%%/*}"; case "$u" in ''|*[!0-9]*) echo 5432;; *) echo "$u";; esac; }

pg_running()    { pg_ctl -D "$PGDATA" status >/dev/null 2>&1; }
redis_running() { redis-cli -h 127.0.0.1 -p "$(redis_port)" ping 2>/dev/null | grep -q PONG; }

start_pg() {
  pg_running && return 0
  [ -d "$PGDATA" ] || die "PostgreSQL cluster not found at $PGDATA. Run: bash scripts/termux-setup.sh"
  log "Starting PostgreSQL…"
  pg_ctl -D "$PGDATA" -l "$LOG_DIR/postgres.log" -w -t 90 \
    -o "-c port=$(db_port) -c listen_addresses=127.0.0.1 -c unix_socket_directories=$RUN_DIR -c shared_buffers=${PG_SHARED_BUFFERS:-64MB} -c max_connections=${PG_MAX_CONN:-40} -c work_mem=4MB -c wal_compression=on" start >/dev/null \
    || die "PostgreSQL failed to start. See $LOG_DIR/postgres.log"
}
start_redis() {
  redis_running && return 0
  log "Starting Redis…"
  redis-server --daemonize yes --bind 127.0.0.1 --port "$(redis_port)" --dir "$REDIS_DIR" --appendonly yes --appendfsync everysec --save "" \
    --logfile "$LOG_DIR/redis.log" --pidfile "$RUN_DIR/redis.pid" >/dev/null
  for _ in $(seq 1 30); do redis_running && return 0; sleep 0.5; done
  die "Redis failed to start. See $LOG_DIR/redis.log"
}
