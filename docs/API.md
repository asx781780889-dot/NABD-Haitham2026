# API reference

Base URL `http://HOST:PORT`. JSON in / JSON out. All `/api/*` routes except `POST /api/auth/login`, `GET /api/setup/status` and `POST /api/setup/admin` (first run only) need a session cookie (`nabd_sid`, HttpOnly, SameSite=Lax).
State-changing requests (`POST/PUT/PATCH/DELETE`) also need the header `X-CSRF-Token` (returned by `/api/auth/login` and `/api/auth/me`) and, when an `Origin` header is present, it must match the host.
Roles: `viewer` < `operator` < `admin`. Routes marked **+ password** also require the header `X-Confirm-Password: <current password>` (step-up authentication; the web UI asks for it automatically).

## Conventions

- **Errors**: `{"error": {"code": "VALIDATION", "id": "E-1A2B3C4D", "message_en": "...", "message_ar": "...", "details": [...]}}`. `id` is also logged server-side - quote it when reporting problems. Codes: `VALIDATION, UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, CONFLICT, BAD_STATE, RATE_LIMITED, CSRF, REAUTH_REQUIRED, INVALID_CREDENTIALS, ACCOUNT_LOCKED, TELEGRAM_*, AI_UNAVAILABLE, AI_NOT_CONFIGURED, DB_UNAVAILABLE, WORKER_OFFLINE, INTERNAL`.
- **Pagination**: `?page=1&limit=50` → `{ "data": [...], "meta": { "total", "page", "limit", "pages" } }` (max limit 100-200 depending on the endpoint).
- **Match filters** (`/api/matches`, `/api/search`, exports, reports): `priority=high,critical`, `min_score=70`, `buckets=70,80,90,100` (bucket N = scores in (N-10, N]), `account_id`, `source_id`, `source`, `intent`, `rule_id`, `keyword`, `user`, `user_id`, `q`, `from`, `to` (ISO dates), `status`, `pinned`, `saved`, `feedback`, `sort=created|score|priority`. Arabic text search ignores alef/ya/ta-marbuta/diacritic variants.
- **Exports**: `/api/export/{matches|saved|report|audit}?format=csv|json|xlsx|pdf` (`pdf` returns a print-ready page: use the browser's *Save as PDF*, which shapes Arabic correctly).
- **Real time**: `GET /ws` (WebSocket, same cookie). Server events: `match.new` / `match.update` (`card`, `ui:{browser,sound}`), `alert.new`, `account.status`, `worker.status`, `job.update`, `system.status`, `stats.tick`. Blocked users/groups are filtered server-side before broadcast.
- **Health**: `GET /health` (liveness), `GET /ready` (200 when PostgreSQL is reachable; body says `ready` or `degraded` when Redis/workers are down), `GET /metrics` (Prometheus text; loopback, a signed-in user, or `Authorization: Bearer $METRICS_TOKEN`).

## Endpoints (128 routes)

| Method | Path | Minimum role |
|---|---|---|
| GET | `/api/accounts` | viewer |
| POST | `/api/accounts` | admin |
| GET | `/api/accounts/:id` | viewer |
| PATCH | `/api/accounts/:id` | admin |
| DELETE | `/api/accounts/:id` | admin + password |
| POST | `/api/accounts/:id/disable` | operator |
| POST | `/api/accounts/:id/enable` | operator |
| POST | `/api/accounts/:id/login/cancel` | admin |
| POST | `/api/accounts/:id/login/code` | admin |
| POST | `/api/accounts/:id/login/password` | admin |
| POST | `/api/accounts/:id/login/start` | admin |
| GET | `/api/accounts/:id/logs` | operator |
| POST | `/api/accounts/:id/{connect|disconnect|reconnect}` | operator |
| POST | `/api/accounts/:id/{sync|test}` | operator |
| GET | `/api/ai/providers` | operator |
| PUT | `/api/ai/providers/:id` | admin |
| GET | `/api/ai/providers/:id/models` | operator |
| POST | `/api/ai/providers/:id/reset` | admin |
| POST | `/api/ai/providers/:id/test` | operator |
| GET | `/api/ai/usage` | operator |
| GET | `/api/alerts` | viewer |
| DELETE | `/api/alerts/:id` | operator |
| POST | `/api/alerts/:id/read` | viewer |
| GET | `/api/alerts/deliveries` | operator |
| POST | `/api/alerts/read-all` | viewer |
| GET | `/api/analytics/overview` | viewer |
| POST | `/api/auth/login` | public |
| POST | `/api/auth/logout` | public |
| GET | `/api/auth/me` | public |
| POST | `/api/auth/password` | viewer |
| PATCH | `/api/auth/preferences` | viewer |
| GET | `/api/automations` | viewer |
| POST | `/api/automations` | operator |
| PATCH | `/api/automations/:id` | operator |
| DELETE | `/api/automations/:id` | operator |
| GET | `/api/automations/:id/runs` | viewer |
| GET | `/api/automations/triggers` | viewer |
| GET | `/api/blocks` | viewer |
| POST | `/api/blocks/keywords` | operator |
| POST | `/api/blocks/sources` | operator |
| POST | `/api/blocks/users` | operator |
| DELETE | `/api/blocks/{users|sources|keywords}/:id` | operator |
| GET | `/api/export/audit` | admin |
| GET | `/api/export/matches` | viewer |
| GET | `/api/export/report` | viewer |
| GET | `/api/export/saved` | viewer |
| GET | `/api/keywords` | viewer |
| POST | `/api/keywords` | operator |
| PATCH | `/api/keywords/:id` | operator |
| DELETE | `/api/keywords/:id` | operator |
| POST | `/api/keywords/:id/variants` | operator |
| POST | `/api/keywords/test` | operator |
| DELETE | `/api/keywords/variants/:id` | operator |
| GET | `/api/matches` | viewer |
| GET | `/api/matches/:id` | viewer |
| DELETE | `/api/matches/:id` | operator |
| POST | `/api/matches/:id/feedback` | operator |
| POST | `/api/matches/:id/{seen|ignore|restore|pin|unpin|save|unsave|block-user|block-source}` | operator |
| GET | `/api/matches/stats` | viewer |
| GET | `/api/messages` | viewer |
| GET | `/api/radar` | viewer |
| POST | `/api/radar` | operator |
| GET | `/api/radar/:id` | viewer |
| PATCH | `/api/radar/:id` | operator |
| DELETE | `/api/radar/:id` | operator |
| GET | `/api/radar/:id/examples` | viewer |
| POST | `/api/radar/:id/suggest` | operator |
| GET | `/api/radar/:id/suggestions` | viewer |
| POST | `/api/radar/:id/test` | operator |
| POST | `/api/radar/:id/{activate|pause}` | operator |
| POST | `/api/radar/draft` | operator |
| DELETE | `/api/radar/examples/:id` | operator |
| POST | `/api/radar/suggestions/:id/:action` | operator |
| GET | `/api/reports` | viewer |
| POST | `/api/reports` | operator |
| DELETE | `/api/reports/:id` | operator |
| GET | `/api/reports/run` | viewer |
| GET | `/api/rules` | viewer |
| POST | `/api/rules` | operator |
| PATCH | `/api/rules/:id` | operator |
| DELETE | `/api/rules/:id` | operator |
| POST | `/api/rules/test` | operator |
| GET | `/api/saved` | viewer |
| PATCH | `/api/saved/:id` | operator |
| DELETE | `/api/saved/:id` | operator |
| GET | `/api/search` | viewer |
| GET | `/api/settings` | viewer |
| PUT | `/api/settings` | admin |
| POST | `/api/settings/test/:channel` | admin |
| POST | `/api/setup/admin` | public |
| GET | `/api/setup/checks` | admin |
| POST | `/api/setup/complete` | admin |
| GET | `/api/setup/status` | public |
| GET | `/api/sources` | viewer |
| POST | `/api/sources` | operator |
| PATCH | `/api/sources/:id` | operator |
| DELETE | `/api/sources/:id` | operator |
| POST | `/api/sources/:id/scan` | operator |
| POST | `/api/sources/bulk` | operator |
| GET | `/api/system/audit` | admin |
| GET | `/api/system/backups` | admin |
| POST | `/api/system/backups` | admin |
| DELETE | `/api/system/backups/:id` | admin + password |
| GET | `/api/system/backups/:id/download` | admin + password |
| GET | `/api/system/database` | operator |
| POST | `/api/system/database/cleanup` | admin + password |
| POST | `/api/system/database/cleanup-preview` | admin |
| POST | `/api/system/database/emergency/clear` | admin + password |
| GET | `/api/system/logs` | operator |
| GET | `/api/system/logs/live` | operator |
| GET | `/api/system/overview` | viewer |
| GET | `/api/system/queues` | viewer |
| POST | `/api/system/queues/clear` | admin + password |
| POST | `/api/system/queues/pause` | admin |
| POST | `/api/system/queues/resume` | admin |
| POST | `/api/system/queues/retry-failed` | operator |
| GET | `/api/system/status` | viewer |
| GET | `/api/system/tasks` | viewer |
| GET | `/api/system/tasks/:id` | viewer |
| POST | `/api/system/tasks/:id/{cancel|retry|pause|resume}` | operator |
| GET | `/api/system/workers` | viewer |
| POST | `/api/system/workers/:name/:action` | admin |
| GET | `/api/users` | admin |
| POST | `/api/users` | admin + password |
| PATCH | `/api/users/:id` | admin |
| DELETE | `/api/users/:id` | admin + password |
| GET | `/health, /ready, /metrics` | public (metrics: loopback / token / session) |
| WS | `/ws` | session |
