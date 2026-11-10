# Security

| Area | What is implemented |
|---|---|
| Authentication | Username + password, **scrypt** (N=2^14) hashes, constant-time verification, generic errors (no user enumeration), lock-out after N failures, per-IP and per-user login rate limits |
| Sessions | Random 256-bit token in an **HttpOnly, SameSite=Lax** cookie (`Secure` automatically on HTTPS); only the SHA-256 of the token is stored; server-side expiry and revocation (logout, password change, user disable) |
| CSRF | Per-session token in `X-CSRF-Token` for every state-changing request + `Origin` host check |
| RBAC | `admin` / `operator` / `viewer`; the last admin cannot be demoted, disabled or deleted; sensitive actions (stop workers, clear queue, delete account/backup/user, download backup, cleanup) additionally need the **password again** |
| Secrets | Telegram phone, API ID, API hash, **session strings**, AI API keys, SMTP password, bot token: AES-256-GCM with `MASTER_KEY` (key-id tagged, rotation tool `scripts/rotate-key.js`). The API never returns them (only `has_api_key: true`), logs redact them, the UI never receives them |
| Backups | Whole files are encrypted (AES-256-GCM, 0600); config backups omit secret values entirely; download needs step-up auth |
| Input validation | Zod schemas on every route; unknown rule/automation condition and action types are rejected; JSON size limit 1 MB |
| SQL injection | Only parameterised queries; the few dynamic fragments (ORDER BY, column lists) are whitelisted |
| XSS | The UI builds DOM with `textContent` (no `innerHTML`), strict CSP (`script-src 'self'`, no inline scripts), `X-Frame-Options`/`frame-ancestors none`, export formulas neutralised (`=`/`+`/`-`/`@` prefixes in CSV/XLSX), HTML export escaped |
| Rate limiting | API (per user/IP), login, step-up; Redis-backed with an **in-memory fallback** (never fails open); AI calls (BullMQ limiter + breaker); Telegram (FloodWait honoured, polite catch-up delays) |
| Audit | Append-only `audit_logs` (a trigger blocks `UPDATE`): who / when / what / result / IP / request id for logins, account changes, rules, AI provider/settings changes, blocks, exports, backups, worker control … |
| Prompt injection | Message text is untrusted: it is delimited, the model is told to treat it as data, the output is a schema-validated JSON verdict **with no tools or actions**; the AI agent only *proposes* (new signals become pending suggestions a human accepts) |
| Telegram boundaries | Reads only chats the connected account is already a member of; no scraping of members, no joining, no auto-messaging, no flood-limit evasion. Keep it that way: Telegram's API terms apply to your accounts |

## Hardening checklist
1. Keep `HOST=127.0.0.1` unless you really need LAN access; if you expose it, put **HTTPS** in front (nginx/Caddy/Cloudflare Tunnel), set `TRUST_PROXY=true`, `COOKIE_SECURE=true`.
2. `chmod 600 .env`; back up `MASTER_KEY` separately (password manager). Losing it makes sessions/keys/backups unrecoverable.
3. Use a long unique admin password; create `operator`/`viewer` accounts for others.
4. Set `METRICS_TOKEN` if Prometheus scrapes remotely.
5. Rotate the key if it ever leaks: set `MASTER_KEY_OLD` (current) and `MASTER_KEY` (new), stop the app, run `node scripts/rotate-key.js --dry-run` then without `--dry-run`.
6. Telegram sessions are as sensitive as the account: anyone with the database **and** `MASTER_KEY` can act as the account. Terminate unknown sessions from Telegram's *Settings → Devices* if in doubt.

## Privacy / compliance note
The platform stores message text and sender ids from the groups you monitor. Monitor only chats you are entitled to, tell people where required by law (GDPR-style regimes), and use the retention settings (*Settings → Database*) to keep only what you need. Unmatched messages are soft-deleted after 24 hours by default, then hard-purged after the 7-day grace period.
