# Operations guide

## Workers (System → Workers)
| Module | Does | Queue |
|---|---|---|
| `telegram` | owns the GramJS connections, ingestion, reconnect/catch-up, account tasks, history scans | – |
| `processor` | claim, normalise, block checks | `process` |
| `keyword` | keyword engine + AI routing | `keyword` |
| `ai` | semantic analysis (rate-limited: *requests/min*, *concurrency*) | `ai` |
| `notification` | Telegram bot / account, email delivery with retries | `notify` |
| `analytics` | hourly roll-ups, radar precision counters | `analytics` |
| `cleanup` | backup + retention tasks | PG tasks |
| `scheduler` | sweeper, DB monitor, worker liveness, scheduled backup/cleanup | – |
Start / stop / restart / pause / resume each module from the dashboard (stop, restart-all and all dangerous actions ask for your password). If *no worker process* is online the UI tells you to run `scripts/start.sh`.

## Queue & tasks
*Tasks* page: processing queue counters, **Pause / Resume processing**, **Retry failed jobs**, **Clear queue** (skips every pending message; password required) and the task table with state, progress, start/end/duration, errors, Cancel / Retry / Pause / Resume. Long operations (history scan) checkpoint their progress and resume after a crash.

## Database monitor (System → Database)
Size vs capacity (configured limit, or free disk), tables, indexes, WAL, temp files, replication slots, connections, long queries. Levels: 70 % *Warning*, 80 % *High risk*, 90 % *Critical*, 95 % *Emergency preparation*, 98 % *Emergency mode* (ingestion pauses, **nothing is deleted**, auto-clears below the level; manual override available). Cleanup preview shows exactly what would be removed.

## Retention (Settings → Database)
Unmatched messages older than N days (default 1 day / 24 hours) are **soft-deleted**, purged after a grace period (default 7 days). Messages backing a card or an occurrence are never touched. Logs (30 d), notifications (60 d), finished tasks (30 d), AI usage (90 d) are pruned hourly.

## Backups
System → Backups: Database (`pg_dump -Fc`), Configuration, Rules. Scheduled daily by default, keep last 7. Files in `data/backups/*.enc` are AES-256-GCM encrypted with `MASTER_KEY`. Restore (app stopped):
```bash
node scripts/restore.js database data/backups/database-….dump.enc --yes      # pg_restore --clean --if-exists
node scripts/restore.js decrypt data/backups/config-….json.enc config.json    # inspect config / rules backups
```

## Troubleshooting
| Symptom | Fix |
|---|---|
| UI says *No worker process is online* | `bash scripts/start.sh` (or `docker compose up -d worker`) |
| `ready: degraded`, Redis offline | start Redis (`bash scripts/start.sh` does); the app keeps working inline meanwhile |
| Account stuck *Disconnected* with attempts counting | read the *last error* on the Accounts page; *Reconnect* resets the counter; `auth_required` means the session was revoked → remove and add the account again |
| `FLOOD_WAIT` messages | automatic: connection waits and retries; reduce *catch-up per source* in Settings → Telegram |
| AI cards flagged *keywords only* | provider failing: AI Settings → Test; check the circuit state and the usage error list |
| Login code never arrives | check API ID/hash belong to the account owner; Telegram sends the code to the *Telegram app* first |
| PostgreSQL won't start on Termux | `bash scripts/logs.sh postgres`; stale lock → `bash scripts/stop.sh --all` then start again; never keep `data/pgdata` on shared storage |
| `npm ci` native build errors on Termux | the scripts already use `--ignore-scripts`; if you run npm manually add it too |
| Port in use | change `PORT` in `.env` |
| Forgot admin password | `node scripts/create-admin.js admin 'NewPassw0rd-123'` resets/creates an admin |
| Everything is slow | check System → Database (capacity) and Tasks (queue backlog); lower AI *concurrency*; raise worker concurrency only on strong hardware |
