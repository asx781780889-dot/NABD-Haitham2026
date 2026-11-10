import { h, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get, post, put } from '../lib/api.js';
import { pageHead, btn, form, card, badge, showError, toast, errorBox, skeletons, can, statusDot, table, kpi } from '../lib/ui.js';
import { settingsEditor } from '../lib/settingsform.js';
import { ChartSet, canvas, theme } from '../lib/charts.js';

const NAMES = { gemini: 'Google Gemini', openai: 'OpenAI', anthropic: 'Anthropic Claude', local: t('Local model (Ollama / LM Studio / llama.cpp)'), custom: t('Custom API (OpenAI-compatible)'), grok: 'Grok (xAI)' };
const KEYLESS = ['local', 'custom'];

function providerCard(p, reload) {
  const admin = can('admin'); const listId = `models-${p.id}`; const dl = h('datalist', { id: listId });
  const providerName = p.id === 'grok' && p.base_url?.includes('api.groq.com') ? 'Groq (GroqCloud)' : NAMES[p.id];
  const f = form([
    { key: 'enabled', label: t('Enabled'), type: 'toggle', value: p.enabled }, ...(KEYLESS.includes(p.id) || p.base_url ? [] : []),
    { key: 'api_key', label: t('API key'), type: 'password', placeholder: p.has_api_key ? t('saved — leave empty to keep') : (KEYLESS.includes(p.id) ? '(optional)' : ''), dir: 'ltr' },
    { key: 'base_url', label: t('Base URL'), dir: 'ltr', value: p.base_url ?? '', placeholder: p.id === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : p.id === 'grok' ? 'https://api.x.ai/v1' : '' },
    { key: 'model', label: t('Model'), value: p.model ?? '', dir: 'ltr' }, { key: 'temperature', label: t('Temperature'), type: 'number', min: 0, max: 2, step: 0.1, value: p.temperature },
    { key: 'max_tokens', label: t('Max tokens'), type: 'number', min: 50, max: 8000, value: p.max_tokens }, { key: 'timeout_ms', label: t('Timeout (ms)'), type: 'number', min: 2000, max: 120000, value: p.timeout_ms }, { key: 'retry_count', label: t('Retry count'), type: 'number', min: 0, max: 5, value: p.retry_count },
    ...(p.id === 'custom' ? [{ key: 'headers', label: 'Headers (JSON)', type: 'textarea', rows: 2, placeholder: p.has_headers ? t('saved — leave empty to keep') : '{"x-api-key": "..."}', dir: 'ltr' }] : []),
  ]);
  f.el.classList.add('grid', 'g2'); f.el.style.display = 'grid'; f.ctl.model.setAttribute('list', listId);
  const res = h('div'); const u = p.usage_24h; const br = p.breaker;
  const save = async (refresh = true) => {
    const v = f.get(); const body = { enabled: v.enabled, base_url: v.base_url, model: v.model, temperature: v.temperature, max_tokens: v.max_tokens, timeout_ms: v.timeout_ms, retry_count: v.retry_count };
    if (v.api_key) body.api_key = v.api_key; if (v.headers?.trim()) { try { body.headers = JSON.parse(v.headers); } catch { toast('Headers must be valid JSON', 'error'); return false; } }
    for (const k of Object.keys(body)) if (body[k] === undefined || Number.isNaN(body[k])) delete body[k];
    try { await put(`/ai/providers/${p.id}`, body); toast(t('Saved.')); if (refresh) reload(); return true; } catch (e) { showError(e); return false; }
  };
  return card(null, h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('h3', { class: 'grow' }, providerName), p.role && badge(p.role === 'primary' ? t('Primary provider') : t('Fallback provider'), 'ok'), statusDot(br.state === 'open' ? 'error' : br.state === 'half-open' ? 'warning' : p.status === 'ok' ? 'online' : 'disconnected', `${t('Circuit')}: ${br.state}`)),
    f.el, dl, h('div', { class: 'row sm muted' }, h('span', null, `${t('Usage (24h)')}: ${fmt.num(u.calls)} ${t('calls')} · ${u.errors} ${t('Errors')} · ${fmt.ms(u.avg_ms)} · ${fmt.num(Number(u.tokens_in) + Number(u.tokens_out))} tok`), (p.last_error) && h('span', { style: { color: 'var(--bad)' } }, `${t('last error')}: ${p.last_error}`)), res,
    admin && h('div', { class: 'row tight' }, btn(t('Save'), save, { kind: 'primary', ic: 'save' }),
      btn(t('Test'), async () => { clear(res).append(h('span', { class: 'muted' }, t('Loading…'))); try { if (!(await save(false))) return; const r = await post(`/ai/providers/${p.id}/test`); clear(res).append(h('div', { class: `callout ${r.ok ? '' : 'bad'}` }, r.ok ? `✔ ${t('Provider works')} · ${r.latencyMs} ms · ${r.model}` : `✘ ${r.error}`)); } catch (e) { clear(res); showError(e); } }, { ic: 'play' }),
      btn(t('Fetch models'), async () => { try { const r = await get(`/ai/providers/${p.id}/models`); clear(dl).append(...r.data.map((m) => h('option', { value: m }))); toast(`${r.data.length} ${t('Model')}`); } catch (e) { showError(e); } }, { ic: 'refresh' }),
      br.state !== 'closed' && btn(t('Reset circuit'), async () => { await post(`/ai/providers/${p.id}/reset`); reload(); }))));
}

export default async function ai(ctx) {
  const box = h('div', { class: 'stack' }); const charts = new ChartSet(); ctx.onLeave(() => charts.destroy());
  ctx.root.append(pageHead(t('AI Settings'), 'Gemini · OpenAI · Anthropic · Grok · Local · Custom — independent providers with automatic failover.'), box);
  async function load() {
    charts.destroy(); clear(box);
    try {
      const [{ data: provs }, { data: reg }, usage] = await Promise.all([get('/ai/providers'), get('/settings'), get('/ai/usage')]);
      const keys = ['ai.primary', 'ai.fallback', 'ai.failover_enabled', 'ai.semantic_enabled', 'ai.intent_enabled', 'ai.classification_enabled', 'ai.summarization_enabled', 'ai.requests_per_minute', 'ai.concurrency', 'ai.min_chars', 'ai.max_chars', 'ai.breaker_threshold', 'ai.breaker_cooldown_s'];
      const { box: cb, canvas: cv } = canvas('sm'); const c = theme();
      box.append(card(t('AI Settings'), settingsEditor(reg, keys, { readOnly: !can('admin'), onSaved: load }).el), h('div', { class: 'grid g2' }, ...provs.map((p) => providerCard(p, load))),
        card(`${t('Usage (24h)')}`, h('div', { class: 'stack' }, usage.series.length ? cb : h('div', { class: 'muted' }, t('No data')), usage.recent_errors.length > 0 && table({ rows: usage.recent_errors, columns: [{ label: t('Time'), render: (e) => h('span', { class: 'xs num' }, fmt.dt(e.created_at)) }, { label: t('Provider'), render: (e) => e.provider }, { label: 'HTTP', render: (e) => e.http_status ?? '–' }, { label: t('Errors'), render: (e) => h('span', { class: 'xs' }, e.error) }] }))));
      if (usage.series.length) charts.line(cv, usage.series.map((s) => fmt.time(s.t).slice(0, 5)), [{ label: t('AI calls'), data: usage.series.map((s) => s.calls), fill: true }, { label: t('Errors'), data: usage.series.map((s) => s.errors), color: c.bad }]);
    } catch (e) { clear(box).append(errorBox(e, load)); }
  }
  box.append(skeletons(2)); await load();
}
