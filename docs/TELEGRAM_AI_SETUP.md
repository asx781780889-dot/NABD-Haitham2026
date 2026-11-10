# Telegram & AI setup

## Telegram accounts
1. Sign in at <https://my.telegram.org> with the account's phone → **API development tools** → create an app → note **API ID** (number) and **API Hash** (32 hex chars).
2. *Telegram Accounts → Add account*: phone (international format), API ID, API hash, optional name/tags.
3. Telegram sends a login code (usually to the Telegram app). Enter it; if the account has two-step verification enter that password too. The session is stored **encrypted**; the temporary login client is closed and the worker takes over the connection.
4. Alternatively paste an existing GramJS/Telethon **StringSession** instead of logging in.
5. *Sync* the account to list its groups, channels, private chats, and saved messages. With **Monitor new sources automatically** enabled (the default), all source kinds are monitored for existing and newly added accounts. You can still pause or resume an individual source from the Sources page.
Limits: only chats the account already belongs to; one connection per session; FloodWait is honoured; after a disconnect the worker fetches at most *catch-up per source* missed messages.

## AI providers (AI Settings)
| Provider | Needs | Notes |
|---|---|---|
| Gemini | API key | default model `gemini-3.8-flash`; calls use Google's Interactions API and do not store interaction content |
| OpenAI | API key | default `gpt-4o-mini`; `max_completion_tokens`/`temperature` quirks are handled automatically |
| Anthropic | API key | default `claude-haiku-4-5-20251001`, Messages API `anthropic-version: 2023-06-01` |
| Grok (xAI) | API key from <https://console.x.ai> | default `grok-4-fast`; base URL `https://api.x.ai/v1` |
| Local | base URL (Ollama `http://127.0.0.1:11434/v1`, LM Studio, llama.cpp server) | any OpenAI-compatible server |
| Custom | base URL + optional key/headers | any OpenAI-compatible gateway |
Use **Fetch models** to list the models your key can use (defaults can become outdated - model names are free text). Pick a **primary** and a **fallback**; the circuit breaker skips a failing provider for the cool-down period. Keys are stored encrypted and never shown again (leave the field empty to keep the saved one).
Cost control: the radar's *AI confirmation* = `uncertain` (default) calls the model only when the local keyword score is below 95 and a cheap lexical pre-filter passes; `always` analyses every message ≥ *min chars*; `off` is keyword-only. Results are cached 24 h per (radar, normalised text).

## Smart Radar
Describe the target in plain words → the AI proposes an **intent**, 12-20 **signals** (dialects, typos, English), **negative signals** (look-alikes to reject) and a threshold → you review → *Confirm & activate* (it stays a draft until you do). Without an AI provider a local heuristic draft is generated. The radar then:
- matches signals with the keyword engine (exact / partial / fuzzy / dialect-canonical, context rules);
- asks the AI to confirm uncertain candidates and to catch **new phrasings** (semantic matching);
- learns from your 👍/👎: reviewed examples are sent as few-shot context (nothing is trained automatically), repeated AI-confirmed phrases appear as **Suggested keywords** to add or ignore, and *Ask AI for proposals* analyses your feedback.
Per-source scoping: Sources → edit → "use only these radars/keywords".

## Keyword engine in one minute
Normalisation: removes diacritics/tatweel, unifies أ إ آ → ا, ى → ي, ة → ه, collapses elongation, converts Arabic-Indic digits. Light stemming removes the article/prefixes (ال، وال، بال، لل). Dialect canonicalisation maps ابي / ابغى / عايز / ودي / أريد → احتاج (extend with *Settings → Keywords → custom synonyms*). Modes: **exact** (100 %), **partial** (substring 88 % or token coverage), **fuzzy** (Levenshtein on space-insensitive text, threshold per keyword), **synonym** (variants). Context: none / before / after / both, strict (reject) or lenient (score penalty, default −25 %).
