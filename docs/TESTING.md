# Testing

```bash
npm test                  # everything (≈1 min): needs PostgreSQL + Redis reachable (see below)
npm run test:unit         # pure logic only, no services
npm run test:integration  # real PostgreSQL + Redis, in-process API + workers
```
Integration tests read `DATABASE_URL` (default `postgres://nabd:nabd_test@127.0.0.1:5432/nabd_test`), `REDIS_URL` and `MASTER_KEY`. **They DROP and recreate the `public` schema and flush the Redis db** - point them at a throw-away database. The resilience tests also stop/start Redis (`redis-cli shutdown`) and PostgreSQL (`pg_ctlcluster 16 main …`); they skip themselves if those commands are unavailable.

| Suite | Tests | Covers |
|---|---|---|
| `unit/engine` | 10 | Arabic normalisation, dialect/stem canonicalisation, the six spec phrase variants, context modes, fuzzy/partial/synonym, priority, rule conditions & actions, SimHash |
| `unit/lib` | 7 | AES-GCM + key ids, scrypt, backoff/retry/circuit breaker/semaphore/token bucket, CSV/XLSX/HTML export safety, AI JSON parsing, provider request shapes (Gemini/OpenAI/Anthropic/local/custom, adaptive retries, 429/401), Telegram links, redaction |
| `integration/pipeline` | 10 | Provider config & secret hygiene · Telegram login (wrong code, 2FA, wrong password) · account/source sync · radar draft → confirm · keyword + semantic hits, noise, blocked user, unmonitored source, WebSocket · cross-account duplicates · rules + notifications + automations · feedback/pin/save/export/blocks/search/bucket filters · history-scan task, analytics, worker control, metrics · reconnect + audit immutability |
| `integration/security` | 6 | Auth required, CSP/headers, CSRF + Origin, password policy, RBAC matrix, last-admin protection, lock-out and rate limiting, SQLi/XSS probes, unknown condition/action rejection |
| `integration/resilience` | 10 | AI failover + breaker + degraded mode · idempotency · connection loss + catch-up · worker module stop · process restart · retry-failed · database capacity ladder/emergency mode · **Redis outage** · **PostgreSQL outage** |
| `integration/maintenance` | 3 | Encrypted backups (no plaintext secrets, restorable dump, step-up download) · retention cleanup (dry-run exactness, soft-delete → purge, matched messages untouched) · MASTER_KEY rotation |

## Browser (UI) smoke test
```bash
node tests/helpers/ui-server.js        # fresh DB + fake Telegram/AI, serves http://127.0.0.1:18090 (control API on :18091)
pip install playwright && playwright install chromium
python3 tests/ui/ui_smoke.py           # wizard, feed, every route, EN/LTR, light theme, mobile; fails on any console/page error
```
The fake Telegram transport (`tests/helpers/fakes.js`) lets you try the whole product without Telegram credentials: log in with phone `+966500000001`, code `12345`.

## Manual tests that need real services
1. Add a real account (Termux), enable one group, post a matching sentence from another account → a live card appears within a second.
2. Kill your internet for a minute and restore it: the account reconnects and catch-up imports what you missed.
3. Configure a real AI key and press *Test* in AI Settings; try the Radar *Test* panel with *Use AI* ticked.
