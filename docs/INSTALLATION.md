# Installation

Requirements: **Node.js ≥ 18.18**, **PostgreSQL ≥ 14** (16 recommended; `pg_trgm` is optional but speeds up search), **Redis ≥ 6.2** (BullMQ needs Lua scripting), 300 MB free RAM, `pg_dump` for database backups.

## A. Termux (Android) - the supported "pocket server"
Full Arabic walkthrough: [`README.ar.md`](../README.ar.md). Short version:
```bash
pkg update && pkg upgrade -y && pkg install -y unzip
cd ~ && unzip nabd-ai.zip && cd nabd-ai
bash scripts/termux-setup.sh        # installs nodejs-lts/postgresql/redis, creates .env with random secrets, PostgreSQL cluster, migrations
bash scripts/start.sh               # PostgreSQL + Redis + API + worker (auto-restart on crash, wake-lock)
# open http://127.0.0.1:8080 in the phone browser → onboarding wizard
```
`scripts/stop.sh [--all]`, `scripts/status.sh`, `scripts/logs.sh [api|worker|postgres|redis]`.
Tips: keep the PostgreSQL data **inside Termux's home** (default `data/pgdata`), never on `/sdcard`; disable battery optimisation for Termux; `EMBED_WORKER=true` in `.env` runs the workers inside the API process to save ~80 MB RAM; start on boot with *Termux:Boot* (`~/.termux/boot/nabd` containing `cd ~/nabd-ai && bash scripts/start.sh`).
No native compilation is needed: every dependency is pure JavaScript and installed with `--ignore-scripts`.

## B. Linux / macOS / VPS
```bash
sudo apt install -y nodejs npm postgresql redis-server        # or your distro's equivalents (Node 18+)
cd nabd-ai && bash scripts/termux-setup.sh                    # same script; creates a private PostgreSQL cluster in ./data/pgdata (set NABD_PGDATA to move it)
bash scripts/start.sh
```
Or use your own PostgreSQL/Redis: `cp .env.example .env`, fill `DATABASE_URL`, `REDIS_URL`, `MASTER_KEY`, then `npm ci --omit=dev && node scripts/migrate.js && npm start` and, in a second terminal/service, `npm run worker`. Run both under systemd/pm2 for production.

## C. Docker
```bash
cp .env.example .env     # set MASTER_KEY and POSTGRES_PASSWORD (compose reads it from .env)
docker compose up -d --build        # http://localhost:8080
```
Services: `frontend` (nginx: static UI + reverse proxy + WebSocket), `backend` (API), `worker`, `postgres`, `redis`. Scale-out notes: run one `worker` per Telegram session owner; other modules can be split with `WORKER_ONLY=processor,keyword,ai,notification`.

## D. Cloud (Railway / Render / VPS)
Separate **Web** (`node src/server.js`) and **Worker** (`node src/worker.js`) services sharing the same `DATABASE_URL`, `REDIS_URL` and **identical `MASTER_KEY`**. Set `TRUST_PROXY=true`. Health check path `/ready`. Templates: `deploy/railway.json`, `deploy/render.yaml`, `deploy/Procfile`. Managed Postgres usually has a size quota: set *Settings → Database → size limit* so the 70/80/90/95/98 % monitor knows the capacity.

## Environment variables
| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | – (required) | PostgreSQL connection string |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis (queue, cache, rate limit). The app degrades gracefully without it |
| `MASTER_KEY` | – (required) | 32 random bytes (base64/hex) used to encrypt secrets and backups. **Back it up** |
| `MASTER_KEY_OLD` | – | only during key rotation |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | bind address / port |
| `DATA_DIR` | `./data` | backups, exports |
| `COOKIE_SECURE` | `auto` | `auto` (HTTPS only), `true`, `false` |
| `TRUST_PROXY` | `false` | `true` behind a reverse proxy |
| `ALLOWED_ORIGINS` | – | extra allowed browser origins |
| `LOG_LEVEL` | `info` | `debug/info/warning/error/critical` (also editable in Settings → Logs) |
| `AUTO_MIGRATE` | `true` | apply migrations on start (advisory-locked, safe with several processes) |
| `SERVE_STATIC` | `true` | API serves `public/` (disable behind nginx) |
| `EMBED_WORKER` | `false` | run the workers inside the API process |
| `WORKER_ONLY` | all | comma list of worker modules for this process |
| `PG_DUMP_PATH` | `pg_dump` | binary used for database backups |
| `METRICS_TOKEN` | – | bearer token required by `/metrics` for remote scrapers |

All other options (AI, notifications, retention, queue, security…) live in the database and are edited in **Settings** - see the registry in `src/lib/settings.js`.

## Redis
Used for: BullMQ queues, AI result cache, rate limiting. Not used for data that must survive (that is PostgreSQL). With `appendonly yes` queued jobs survive a restart; without Redis the system keeps working in degraded inline mode.

## PostgreSQL
Schema: `src/db/migrations/001_init.sql` (35 tables/views). Highlights: FKs everywhere, unique constraints for idempotency (`messages(account_id, tg_chat_id, tg_message_id)`, `message_matches(message_id)`, `notifications(dedupe_key, channel)`, `automation_runs(automation_id, dedupe_key)`), partial indexes for hot paths, soft-delete columns, an append-only `audit_logs`, `nabd_norm()` for Arabic-insensitive search with a trigram index, `telegram_groups`/`telegram_channels` views over `telegram_sources`.
