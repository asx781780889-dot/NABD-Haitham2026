# Specification coverage

Legend: ✅ implemented and covered by automated tests · 🟢 implemented, verified through the UI/browser run or by inspection · 🟡 implemented with a documented difference · 🔴 could not be verified in the build environment.

| § | Requirement | Status | Notes |
|---|---|---|---|
| 1-2 | Unified system, clear layered architecture | ✅ | `docs/ARCHITECTURE.md`; pipeline stages are pure functions over DB state |
| 3 | Dashboard: 13 required stats + live system status (Telegram, DB, AI, Workers, Queue, Redis, API, Scheduler, Storage) | ✅🟢 | 15 KPIs; statuses Online/Offline/Warning/Error pushed over WebSocket |
| 4-5 | Add account (validation, secure session, code, 2FA, encrypted session, test) + management actions | ✅ / 🔴 | whole flow tested with a fake transport; real MTProto login not exercised. Secrets never reach the UI (tested). Also: import StringSession |
| 6 | Sources: groups / channels / private / saved; add/remove/toggle/account/per-source radars & keywords | ✅ | "per-source rules" = per-source radars/keywords/priority weight + global rules with `source` conditions |
| 7-8 | Keyword engine: exact, partial, semantic, fuzzy, synonyms; context modes | ✅ | semantic = AI confirmation (`uncertain`/`always`) + offline pre-filter; fuzzy covers typos/spacing/repeats/dialect; abbreviations through variants |
| 9 | Match-% buttons 10…100 + All, multi-select | ✅ | bucket N = scores in (N-10, N] |
| 10, 45 | Smart Radar / Smart Search Builder with explicit confirmation | ✅ | drafts never activate by themselves |
| 11-12 | Provider architecture (Gemini, OpenAI, Anthropic, Local, Custom), primary/fallback, test, status, usage, errors, auto-failover, AI settings page | ✅ | Local/Custom = OpenAI-compatible endpoints; keys encrypted. Third-party APIs verified by request-shape tests + a fake server, not live |
| 13 | AI agent (analysis, intent, classification, relevance, entities, priority, similar messages, suggestions) without dangerous actions | 🟡 | proposals only (pending suggestions); "similar messages" = fingerprint de-duplication |
| 14 | Live cards with all fields and buttons | ✅🟢 | "Add rule" offers templates (user/source priority, ignore, notify) |
| 15-16 | De-duplication across accounts: exact hash, normalised hash, similarity, semantic similarity | 🟡 | "semantic similarity" = local character-trigram similarity + SimHash; no embedding model |
| 17 | LOW/MEDIUM/HIGH/CRITICAL from score, intent, AI confidence, sensitive words, source, user, rule | ✅ | explained factors stored per card; thresholds editable |
| 18 | Alerts: dashboard, browser, sound, Telegram, email, independent settings | ✅ / 🔴 | Telegram bot path tested against a fake Bot API; browser/sound are client-side (flags tested, audio/permission UI by inspection); SMTP not tested live |
| 19 | Block users / groups / channels / keywords, enforced in the backend | ✅ | at processing time, query time and WebSocket |
| 20-21 | Saved results (+notes/tags/search/filter/export) and global search with all listed filters | ✅ | Arabic-insensitive search |
| 22, 50 | Analytics with interactive charts; report builder | ✅🟢 | |
| 23-24 | Rules engine (IF/AND/OR/NOT → actions) and Automation (trigger → conditions → actions) sharing one evaluator | ✅ | 9 triggers; idempotent runs |
| 25-26 | Background workers + Redis (queue, cache, rate limiting, jobs) | 🟡 | 7 worker modules + scheduler on 5 BullMQ queues. Locks use PostgreSQL advisory locks; the temporary login state lives in API memory (a live client object cannot be stored in Redis) |
| 27-28 | PostgreSQL schema, 70/80/90/95/98 % monitor, no dangerous auto-delete | ✅ | emergency mode pauses ingestion only |
| 29-31 | Audit logs, security (auth, RBAC, sessions, rate limit, CSRF, cookies, validation, SQLi/XSS, secret encryption), secrets never in the frontend | ✅ | `docs/SECURITY.md` |
| 32 | API architecture (/api/auth … /api/system) | ✅ | `docs/API.md` (128 routes) |
| 33 | Real-time (WebSocket) | ✅ | new match/alert/account/worker/job/system events |
| 34-36 | Responsive modern UI, AR/EN with RTL/LTR | ✅🟢 | headless-Chromium run: desktop, mobile, English, light theme, every route without console errors |
| 37-38 | Understandable errors with Retry / View details / Copy error ID; 5 log levels + search | ✅ | bilingual messages |
| 39 | `/health`, `/ready`, `/metrics` | ✅ | |
| 40 | Performance: pagination, lazy loading, caching, indexes, batching, queues, worker pools | 🟢 | batched inserts, lazy page modules, hourly aggregates; no load/soak test was run |
| 41-44 | Live Feed (pause/resume/clear/filters), short AI explanation (no chain-of-thought), feedback loop (no auto-training), suggested keywords | ✅ | |
| 46-47 | Task manager (state, progress, times, error) + system control with protection | ✅ | password re-entry for dangerous actions |
| 48-49 | Backups (DB/config/rules, manual+scheduled, encrypted, no plaintext secrets); export CSV/JSON/Excel/PDF | 🟡 | restore is a CLI (`scripts/restore.js`). **PDF = print-ready page** ("Save as PDF" in the browser) because server-side PDF cannot shape Arabic without bundling fonts and a layout engine |
| 51-52 | Settings (all groups) and 7-step onboarding | ✅🟢 | |
| 53-55 | Modular architecture, code quality, tests incl. the listed scenarios | 🟡 | 46 tests. Plain JavaScript (no build step on a phone) with Zod validation and JSDoc instead of TypeScript |
| 56-58 | Docker, `.env.example`, cloud-ready (Railway/Render/VPS) | 🔴 | files provided; `docker compose`, Railway and Render templates were **not executed** here |
| 59-60 | Failure handling; rate limiting, backoff, cool-down, circuit breaker | ✅ | `docs/ARCHITECTURE.md` failure matrix, all exercised |
| 61 | Never bypass Telegram limits / access unauthorised data | ✅ | design constraint, see `docs/SECURITY.md` |
| 62-64 | No data loss, explicit states with Cancel/Retry/Resume, idempotency | ✅ | |
| 65-70 | No dummy buttons/APIs; staged verification; end-to-end test | ✅ / 🔴 | E2E Account → Telegram → Message → … → Database passes with the fake transport; **a live Telegram account was not available** |
| 71-75 | Complete deliverable with documentation | ✅ | |

## Known limitations (please read)
1. **Telegram library**: GramJS (`telegram` npm package, MTProto user client). `npm` reports it as *archived*; a maintained fork named `teleproto` is advertised as largely compatible. Only `src/telegram/adapter.js` imports it, so switching is a one-file change — test it before relying on it. The adapter follows GramJS' typings but has never talked to Telegram's servers in this build.
2. **Termux**: scripts were validated on Ubuntu as an unprivileged user with the same flow (private PostgreSQL cluster, Redis, migrations, supervision, crash recovery, clean stop). Package names (`nodejs-lts postgresql redis`) and Android specifics (wake-lock, battery policy) come from documentation, not from a device.
3. **One connection per Telegram session**: the `telegram` module must run in exactly one worker process.
4. Messages are stored in a single (unpartitioned) table with retention; very high volumes (millions/day) need partitioning and a bigger machine than a phone.
5. Edited Telegram messages are not re-evaluated; media is not downloaded; only text/captions are analysed.
6. Default AI model names can become outdated: use *Fetch models* and edit the model field.
