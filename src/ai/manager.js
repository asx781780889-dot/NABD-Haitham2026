// AI provider manager: primary + fallback chain, retries with backoff, per-provider circuit breakers, usage logging.
import { many, one, query } from '../lib/db.js';
import { getSetting } from '../lib/settings.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { CircuitBreaker, retry } from '../lib/resilience.js';
import { createProvider } from './providers.js';
import { AppError } from '../lib/errors.js';
import { bump } from '../services/stats.js';
import { fireTrigger } from '../services/automation.js';
import { logger } from '../lib/logger.js';

const log = logger('ai');
export const PROVIDER_IDS = ['gemini', 'openai', 'anthropic', 'local', 'custom', 'grok'];
const breakers = new Map(); const instances = new Map();
let cache = { at: 0, map: new Map() };
export const invalidateAi = () => { cache.at = 0; instances.clear(); };

async function configs() {
  if (Date.now() - cache.at < 10000) return cache.map;
  const rows = await many('SELECT * FROM ai_providers');
  const map = new Map();
  for (const r of rows) {
    let apiKey = ''; let headers = {};
    try { apiKey = r.api_key_enc ? decrypt(r.api_key_enc) : ''; } catch { /* key unreadable: treated as unset */ }
    try { headers = r.headers_enc ? JSON.parse(decrypt(r.headers_enc)) : {}; } catch { /* ignore */ }
    map.set(r.id, { id: r.id, enabled: r.enabled, apiKey, headers, baseUrl: r.base_url, model: r.model, temperature: r.temperature, maxTokens: r.max_tokens, timeoutMs: r.timeout_ms, retryCount: r.retry_count });
  }
  cache = { at: Date.now(), map };
  return map;
}
const configured = (c) => !!c && c.enabled && !!c.model && (['local', 'custom'].includes(c.id) ? !!c.baseUrl : !!c.apiKey);
async function breaker(id) {
  let b = breakers.get(id);
  if (!b) { b = new CircuitBreaker({ name: id, threshold: await getSetting('ai.breaker_threshold'), cooldownMs: (await getSetting('ai.breaker_cooldown_s')) * 1000 }); breakers.set(id, b); }
  return b;
}
const scrub = (e, cfg) => { if (cfg.apiKey && e?.message) e.message = e.message.split(cfg.apiKey).join('***'); return e; };
function instance(cfg) {
  const k = `${cfg.id}:${cfg.model}:${cfg.baseUrl}`;
  if (!instances.has(k)) instances.set(k, createProvider(cfg.id, cfg));
  return instances.get(k);
}

export async function activeChain() {
  const [primary, fallback, failover, map] = await Promise.all([getSetting('ai.primary'), getSetting('ai.fallback'), getSetting('ai.failover_enabled'), configs()]);
  const chain = [primary]; if (failover && fallback && fallback !== primary) chain.push(fallback);
  return chain.filter((id) => id && configured(map.get(id)));
}
export async function aiAvailable() { return (await activeChain()).length > 0; }

function record(r) {
  query('INSERT INTO api_usage (provider, model, purpose, status, http_status, latency_ms, tokens_in, tokens_out, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [r.provider, r.model, r.purpose, r.status, r.httpStatus ?? null, r.latencyMs, r.tokensIn ?? null, r.tokensOut ?? null, r.error ? String(r.error).slice(0, 300) : null]).catch(() => {});
  bump({ ai_calls: 1, ...(r.status === 'error' ? { errors: 0 } : {}) });
}

/** Returns {text, provider, model, tokensIn, tokensOut, latencyMs}; throws AI_UNAVAILABLE / AI_NOT_CONFIGURED. */
export async function complete({ purpose = 'generic', system, user, json = true, maxTokens, temperature, chain: forced } = {}) {
  const map = await configs();
  const chain = forced ?? await activeChain();
  if (!chain.length) throw new AppError('AI_NOT_CONFIGURED', { status: 409 });
  let last = null;
  for (const id of chain) {
    const cfg = map.get(id); const br = await breaker(id);
    if (!br.canPass()) { last ??= new Error(`circuit open for ${id}`); continue; }
    const t0 = Date.now();
    try {
      const res = await retry(() => instance(cfg).complete({ system, user, json, maxTokens: maxTokens ?? cfg.maxTokens, temperature: temperature ?? cfg.temperature }),
        { retries: cfg.retryCount, base: 600, cap: 8000, shouldRetry: (e) => e.retryable });
      br.success();
      record({ provider: id, model: cfg.model, purpose, status: 'ok', latencyMs: Date.now() - t0, tokensIn: res.tokensIn, tokensOut: res.tokensOut });
      return { ...res, provider: id, model: cfg.model, latencyMs: Date.now() - t0 };
    } catch (e) {
      scrub(e, cfg); br.fail(e); last = e;
      record({ provider: id, model: cfg.model, purpose, status: 'error', httpStatus: e.status, latencyMs: Date.now() - t0, error: e.message });
      log.warn('ai provider failed', { provider: id, err: e.message, failover: chain.length > 1 });
    }
  }
  void fireTrigger('ai_failure', { id: chain.join(','), providers: chain.join(','), error: last?.message }, { ref: Math.floor(Date.now() / 300000) });
  throw new AppError('AI_UNAVAILABLE', { status: 503, cause: last, details: { last: last?.message } });
}

export async function testProvider(id) {
  const cfg = (await configs()).get(id);
  if (!cfg) throw new AppError('NOT_FOUND', { status: 404 });
  if (!configured(cfg)) throw new AppError('AI_NOT_CONFIGURED', { status: 409 });
  const t0 = Date.now();
  try {
    const res = await instance(cfg).complete({ system: 'Reply with the JSON {"ok":true} and nothing else.', user: 'ping', json: true, maxTokens: 40, temperature: 0 });
    (await breaker(id)).success();
    record({ provider: id, model: cfg.model, purpose: 'test', status: 'ok', latencyMs: Date.now() - t0, tokensIn: res.tokensIn, tokensOut: res.tokensOut });
    await query("UPDATE ai_providers SET status = 'ok', last_test_at = now(), last_error = NULL WHERE id = $1", [id]);
    return { ok: true, latencyMs: Date.now() - t0, model: cfg.model };
  } catch (e) {
    scrub(e, cfg);
    record({ provider: id, model: cfg.model, purpose: 'test', status: 'error', httpStatus: e.status, latencyMs: Date.now() - t0, error: e.message });
    await query("UPDATE ai_providers SET status = 'error', last_test_at = now(), last_error = $2 WHERE id = $1", [id, String(e.message).slice(0, 300)]);
    return { ok: false, error: e.message, latencyMs: Date.now() - t0 };
  }
}
export async function listModels(id) {
  const cfg = (await configs()).get(id);
  if (!cfg || !configured(cfg)) throw new AppError('AI_NOT_CONFIGURED', { status: 409 });
  try { return await instance(cfg).listModels(); } catch (e) { throw new AppError('AI_UNAVAILABLE', { status: 502, message: scrub(e, cfg).message }); }
}

export async function updateProvider(id, patch) {
  if (!PROVIDER_IDS.includes(id)) throw new AppError('NOT_FOUND', { status: 404 });
  const sets = []; const p = [id];
  const set = (col, v) => { p.push(v); sets.push(`${col} = $${p.length}`); };
  for (const [k, col] of [['enabled', 'enabled'], ['base_url', 'base_url'], ['model', 'model'], ['temperature', 'temperature'], ['max_tokens', 'max_tokens'], ['timeout_ms', 'timeout_ms'], ['retry_count', 'retry_count']]) if (patch[k] !== undefined) set(col, patch[k] === '' ? null : patch[k]);
  if (patch.api_key !== undefined) set('api_key_enc', patch.api_key ? encrypt(patch.api_key) : null); // undefined = keep, '' = clear
  if (patch.headers !== undefined) set('headers_enc', patch.headers && Object.keys(patch.headers).length ? encrypt(JSON.stringify(patch.headers)) : null);
  if (sets.length) await query(`UPDATE ai_providers SET ${sets.join(', ')}, status = 'unconfigured' WHERE id = $1`, p);
  invalidateAi(); breakers.delete(id);
}
export const resetBreaker = (id) => { breakers.get(id)?.reset(); };

export async function providersSnapshot() {
  const [rows, usage, primary, fallback] = await Promise.all([
    many('SELECT * FROM ai_providers ORDER BY id'),
    many(`SELECT provider, count(*)::int AS calls, count(*) FILTER (WHERE status = 'error')::int AS errors, COALESCE(avg(latency_ms) FILTER (WHERE status = 'ok'), 0)::int AS avg_ms,
            COALESCE(sum(tokens_in), 0)::bigint AS tokens_in, COALESCE(sum(tokens_out), 0)::bigint AS tokens_out
          FROM api_usage WHERE created_at > now() - interval '24 hours' GROUP BY provider`),
    getSetting('ai.primary'), getSetting('ai.fallback'),
  ]);
  const u = new Map(usage.map((x) => [x.provider, x]));
  return rows.map((r) => ({
    id: r.id, enabled: r.enabled, has_api_key: !!r.api_key_enc, has_headers: !!r.headers_enc, base_url: r.base_url, model: r.model, temperature: r.temperature, max_tokens: r.max_tokens,
    timeout_ms: r.timeout_ms, retry_count: r.retry_count, status: r.status, last_test_at: r.last_test_at, last_error: r.last_error,
    role: r.id === primary ? 'primary' : r.id === fallback ? 'fallback' : null,
    breaker: breakers.get(r.id)?.snapshot() ?? { name: r.id, state: 'closed', failures: 0, lastError: null, retryInMs: 0 },
    usage_24h: u.get(r.id) ?? { calls: 0, errors: 0, avg_ms: 0, tokens_in: 0, tokens_out: 0 },
  }));
}
