# Architecture

```
                    ┌────────────────────────── Browser (SPA, no build step) ──────────────────────────┐
                    │ Dashboard · Live Feed · Radar · Rules · Analytics · System …   REST + WebSocket   │
                    └───────────────────────────────────────┬───────────────────────────────────────────┘
                                                            │ HTTP / WS (cookie session + CSRF)
┌───────────────────────────────────────────────────────────▼──────────────────────────────┐
│ API service  (src/server.js)  Express · RBAC · rate limit · audit · WebSocket relay        │
│  - serves the UI (or nginx does)    - Telegram *login* flow only (temporary client)       │
└───────┬───────────────────────────────────┬───────────────────────────────────┬───────────┘
        │ SQL                               │ LISTEN/NOTIFY (events + control)  │ BullMQ (enqueue)
┌───────▼──────────┐              ┌─────────▼──────────┐              ┌─────────▼─────────┐
│ PostgreSQL       │◄─────────────┤ Worker service     │─────────────►│ Redis             │
│ system of record │   SQL        │ (src/worker.js)    │  jobs/cache  │ queues · cache ·  │
│ 35 tables+views  │              │ 8 independent      │              │ rate limiting     │
└──────────────────┘              │ modules            │              └───────────────────┘
                                  └───┬────────────────┘
        ┌─────────────┬──────────────┼───────────────┬──────────────┬───────────┬────────────┐
   telegram        processor      keyword          ai         notification  analytics   scheduler+cleanup
 (GramJS clients)  (claim, block) (keyword engine) (providers) (TG/email)    (rollups)   (sweeper, DB monitor,
  ingest → DB      queue: process  queue: keyword  queue: ai    queue: notify              backups, retention)
```

## Message pipeline (every stage idempotent, derived from the database)

1. **telegram** module: GramJS `NewMessage` → normalised → `Ingestor` batches `INSERT … ON CONFLICT DO NOTHING` into `messages` (**database first**) and enqueues `process`. If Redis is down the row simply stays `pending`.
2. **processor** (`stageProcess`): atomically claims the row (`pending → processing`), skips disabled sources / empty text / **blocked** users, groups and keywords, then hands over.
3. **keyword** (`stageKeyword`): Arabic-aware normalisation, light stemming, dialect canonicalisation, then exact / partial / fuzzy / synonym matching with context rules. Decides whether AI is needed (`uncertain` mode = only when the keyword score is not already ≥95 and a cheap local pre-filter passes).
4. **ai** (`stageAi`): per-radar analysis through the provider chain (primary → fallback, retries with backoff, circuit breaker, Redis result cache). Provider outage → queue retries; on the last attempt the pipeline **degrades to keyword-only** (card flagged `ai_degraded`).
5. **decide**: merges keyword + AI evidence → candidates → **Rules Engine** (conditions tree, actions) → priority (score, AI confidence, sensitive words, source weight, repeat sender, hints) → **dedupe** (exact hash, normalised hash, SimHash bands, trigram similarity; advisory-locked) → one card with *Detected by* accounts → notifications → automations → WebSocket event.

State of a message: `pending → processing → done | skipped | failed`. A sweeper (scheduler module) re-enqueues stale `pending` rows, resets stuck `processing`, retries failed notifications, and when Redis is down processes pending rows **inline** (degraded mode). Job ids contain the attempt number so a retry can never be swallowed by an old job.

## Why two job mechanisms
- **BullMQ/Redis**: high-volume pipeline + notifications (priorities, retries, rate limiter for AI, pause/resume, counts).
- **PostgreSQL task table** (`jobs`, `SKIP LOCKED`): low-volume admin operations (account connect/sync/test, history scans, backups, cleanup). They keep working without Redis, have `queued/running/paused/completed/failed/cancelled` states, progress, checkpoints (resume after a crash) and Cancel / Retry / Resume.

## Events and control (no Redis dependency)
`LISTEN/NOTIFY` carries tiny events (`{t:'match.new', id}`) – consumers hydrate from the DB, which is also where block lists are enforced. The `nabd_control` channel carries commands (start/stop/restart a worker module, connect an account, invalidate caches). Heartbeats land in the `workers` table; "offline" = no heartbeat for 25 s.

## Failure matrix (all exercised by `tests/integration/resilience.test.js`)

| Failure | Behaviour |
|---|---|
| AI provider down | failover to the fallback provider; breaker opens after N errors and the dead provider is skipped; both down → keyword-only degraded cards + `ai_failure` automation/alert; Telegram untouched |
| Redis down | clear *Offline* status + warning; login keeps working (in-memory rate limiter); ingestion continues; sweeper processes inline; recovers automatically |
| PostgreSQL down | API answers `503 DB_UNAVAILABLE` (bilingual message); worker stays alive, Telegram updates buffer in memory (bounded) and flush after recovery; nothing lost |
| Worker module stopped / process killed | messages stay stored `pending`; restart drains them; running tasks resume from their checkpoint |
| Telegram disconnect | watchdog detects it → status *Disconnected* → reconnect with capped exponential backoff (max attempts configurable, honours FloodWait) → bounded **catch-up** of missed messages; fatal auth errors stop retrying and ask for a new login |
| Database nearly full | 70/80/90/95/98 % ladder with alerts; at 98 % ingestion pauses (nothing is deleted); clears automatically when space is available |

## Layout
```
src/config.js · boot.js · server.js · worker.js
src/lib/      db, redis, queue, bus, crypto, settings, logger, audit, errors, resilience, ratelimit
src/engine/   normalize, similarity, keywords, priority, conditions (rules+automation), dedupe      ← pure, unit-tested
src/services/ cards, matches (dedupe+persist), notifier, saved, blocks, ingest, tasks, automation, status, dbmonitor, cleanup, backup, export, stats, accounts
src/ai/       providers (Gemini/OpenAI-compatible/Anthropic), manager (failover+breaker), prompts, analyzer, radar (draft+agent)
src/telegram/ adapter (the only file that imports GramJS), manager, login, links, registry
src/workers/  pipeline, modules, supervisor, task-runner
src/api/      app, middleware, ws, sql, routes/*
public/       index.html · css · js (ES modules, lazy-loaded pages) · vendored Chart.js and IBM Plex fonts (offline)
tests/        unit · integration · helpers (fake Telegram + fake AI) · ui-server (QA harness)
```
