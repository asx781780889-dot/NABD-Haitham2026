# NABD AI — نبض

A self-hosted **Telegram monitoring, AI analysis and automation platform**: connect your own Telegram accounts, watch the groups/channels/chats they already belong to, describe in plain words what you are looking for, and get **live cards** (with alerts, analytics, reports and an audit trail) when matching messages appear.

> Arabic quick start for **Termux (Android)**: see [`README.ar.md`](README.ar.md).

## Highlights
- **Pipeline**: Telegram → ingest (DB first, idempotent) → processor → keyword engine → AI analyzer → rules → de-duplication → live card → notifications/automations → analytics, with independent workers and queues.
- **Arabic-first keyword engine**: normalisation, light stemming, dialect canonicalisation, exact/partial/fuzzy/synonym matching, context rules, match-% filters.
- **Smart Radar**: plain-language description → intent + signals (AI or offline heuristic) → *you confirm* → active. Feedback loop (👍/👎 → few-shot examples, suggested keywords) with no automatic training.
- **AI layer**: Gemini · OpenAI · Anthropic · Local · Custom, primary + fallback, retries with backoff, circuit breaker, usage log; message text is treated as untrusted data.
- **Cross-account de-duplication**: one card with *Detected by Account 1, 2, 3* (exact hash, normalised hash, SimHash, similarity).
- **Operations**: RBAC (admin/operator/viewer), CSRF, scrypt, AES-256-GCM secrets, audit log, task manager, worker control, queue control, PostgreSQL capacity ladder (70/80/90/95/98 %), encrypted backups, safe retention.
- **UI**: responsive (desktop/tablet/phone), Arabic RTL / English LTR, dark/light, live WebSocket updates, offline assets (no CDN calls).

## Quick start
```bash
# Termux / Linux
bash scripts/termux-setup.sh && bash scripts/start.sh      # then open http://127.0.0.1:8080
# Docker
cp .env.example .env   # set MASTER_KEY + POSTGRES_PASSWORD
docker compose up -d --build
```
First run opens a 7-step onboarding: admin → database → Redis → AI provider → Telegram → first rule → workers.

## Documentation
[Installation & env vars](docs/INSTALLATION.md) · [Telegram & AI setup](docs/TELEGRAM_AI_SETUP.md) · [Architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Security](docs/SECURITY.md) · [Operations & troubleshooting](docs/OPERATIONS.md) · [Testing](docs/TESTING.md) · [Spec coverage & known limits](docs/COVERAGE.md)

## What was verified (and what was not)
Automated: **46 tests** (unit, API, database, worker, AI, security, failure scenarios) against real PostgreSQL + Redis with a fake Telegram transport and a fake AI service; a headless-Chromium walk-through of the UI (wizard, feed, every page, RTL/LTR, mobile); a clean install from the zip as an unprivileged user using the Termux scripts.
**Not verified here:** a live connection to Telegram's servers (no credentials/network in the build environment), a real Android device, `docker compose`, SMTP delivery, and third-party AI APIs. Details and the full spec mapping are in [`docs/COVERAGE.md`](docs/COVERAGE.md).

## Responsible use
Use only accounts and chats you are entitled to access, respect Telegram's terms and local privacy law. The platform contains no scraping, joining, messaging or flood-evasion features by design.
