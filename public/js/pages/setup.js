import { h, icon, clear } from '../lib/dom.js';
import { t, setLang, getLang } from '../lib/i18n.js';
import { get, post, put, state } from '../lib/api.js';
import { btn, form, toast, showError, statusDot, askPassword } from '../lib/ui.js';
import { openAddAccount } from './accounts.js';
import { openRadarBuilder } from './radar.js';

const PROVIDERS = [['gemini', 'Gemini'], ['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['local', t('Local model (Ollama / LM Studio / llama.cpp)')], ['custom', t('Custom API (OpenAI-compatible)')], ['grok', 'Grok (xAI)']];

export function renderWizard(root, { fresh = false, onDone }) {
  const titles = [t('Create the administrator'), t('Database check'), t('Redis check'), t('AI provider'), t('Telegram configuration'), t('Create your first rule'), t('Start workers')];
  let i = fresh ? 0 : 1; let checks = null;
  const bar = h('div', { class: 'steps' }); const body = h('div', { class: 'stack' }); const nav = h('div', { class: 'row', style: { justifyContent: 'space-between', marginTop: '18px' } });
  const wrap = h('div', { class: fresh ? 'login' : '' }, h('div', { class: fresh ? 'card stack' : 'card stack', style: fresh ? { width: 'min(100%,560px)' } : {} }, h('div', { class: 'row' }, h('div', { class: 'brand', style: { padding: 0 } }, icon('pulse'), 'NABD AI'), h('span', { class: 'end muted sm' }, h('span', { class: 'num' }, `${t('Step')} ${i + 1} ${t('of')} 7`))), bar, h('h2', null, ''), body, nav));
  const title = wrap.querySelector('h2'); (fresh ? root : root).append(wrap);
  const next = () => { i = Math.min(6, i + 1); draw(); }; const back = () => { i = Math.max(fresh ? 1 : 1, i - 1); draw(); };
  const okRow = (ok, label, detail) => h('div', { class: 'row' }, statusDot(ok ? 'online' : 'error', label), detail && h('span', { class: 'muted sm' }, detail));
  async function refreshChecks() { try { checks = await get('/setup/checks'); } catch (e) { showError(e); } }

  const steps = [
    () => { // 1: admin
      const f = form([{ key: 'username', label: t('Username'), value: 'admin' }, { key: 'password', label: t('Password'), type: 'password' }, { key: 'confirm', label: t('Confirm password'), type: 'password' }]);
      const go = btn(t('Next'), async () => { const v = f.get(); if (v.password !== v.confirm) return toast(t('Passwords do not match'), 'error'); try { const r = await post('/setup/admin', { username: v.username, password: v.password }); state.user = r.user; state.csrf = r.csrf; next(); } catch (e) { showError(e); } }, { kind: 'primary' });
      body.append(h('p', { class: 'muted' }, t('Welcome to NABD AI')), f.el); nav.append(h('span'), go);
    },
    async () => { await refreshChecks(); body.append(okRow(checks?.database?.ok, 'PostgreSQL', checks?.database?.ok ? `${checks.database.ms} ms` : checks?.database?.error)); nav.append(btn(t('Back'), back), h('div', { class: 'row' }, btn(t('Check again'), () => draw()), btn(t('Next'), next, { kind: 'primary' }))); },
    async () => { await refreshChecks(); body.append(okRow(checks?.redis?.ok, 'Redis', checks?.redis?.ok ? `${checks.redis.latencyMs} ms` : checks?.redis?.error), !checks?.redis?.ok && h('div', { class: 'callout warn' }, t('Redis is offline — the system keeps working in degraded mode.'))); nav.append(btn(t('Back'), back), h('div', { class: 'row' }, btn(t('Check again'), () => draw()), btn(t('Next'), next, { kind: 'primary' }))); },
    () => { // 4: AI
      const f = form([{ key: 'id', label: t('Provider'), type: 'select', options: PROVIDERS.map(([value, label]) => ({ value, label })) }, { key: 'api_key', label: t('API key'), type: 'password' }, { key: 'model', label: t('Model') }, { key: 'base_url', label: t('Base URL'), dir: 'ltr', hint: 'local: http://127.0.0.1:11434/v1' }]);
      const res = h('div'); const go = btn(`${t('Save')} + ${t('Test')}`, async () => {
        const v = f.get(); clear(res);
        try { await put(`/ai/providers/${v.id}`, { enabled: true, ...(v.api_key ? { api_key: v.api_key } : {}), ...(v.model ? { model: v.model } : {}), ...(v.base_url ? { base_url: v.base_url } : {}) }); await put('/settings', { values: { 'ai.primary': v.id } }); const r = await post(`/ai/providers/${v.id}/test`);
          res.append(h('div', { class: `callout ${r.ok ? '' : 'bad'}` }, r.ok ? `${t('Provider works')} (${r.latencyMs} ms)` : r.error)); } catch (e) { showError(e); } }, { kind: 'primary' });
      body.append(f.el, go, res); nav.append(btn(t('Back'), back), h('div', { class: 'row' }, btn(t('Skip for now'), next), btn(t('Next'), next, { kind: 'primary' })));
    },
    async () => { await refreshChecks(); const n = checks?.accounts; body.append(h('p', { class: 'muted' }, t('Get the API ID and API Hash from my.telegram.org → API development tools. They are stored encrypted and never shown again.')), okRow(n?.connected > 0, t('Telegram'), n?.connected > 0 ? `${n.connected}/${n.count}` : t('Not connected yet')), btn(t('Add account'), () => openAddAccount(() => draw()), { kind: 'primary', ic: 'plus' })); nav.append(btn(t('Back'), back), h('div', { class: 'row' }, btn(t('Skip for now'), next), btn(t('Next'), next, { kind: 'primary' }))); },
    async () => { await refreshChecks(); body.append(okRow(checks?.radars?.count > 0, t('Smart Radar'), `${checks?.radars?.count ?? 0}`), btn(t('New radar'), () => openRadarBuilder(() => draw()), { kind: 'primary', ic: 'spark' })); nav.append(btn(t('Back'), back), h('div', { class: 'row' }, btn(t('Skip for now'), next), btn(t('Next'), next, { kind: 'primary' }))); },
    async () => { // 7: workers + ready
      await refreshChecks(); const w = await get('/system/workers').catch(() => ({ process_online: false, data: [] }));
      body.append(w.process_online ? h('div', { class: 'statusgrid' }, w.data.map((x) => h('div', { class: 'stat' }, h('span', { class: `dot ${x.status}`, style: { marginTop: '6px' } }), h('div', null, h('b', null, x.name), h('span', null, x.status))))) : h('div', { class: 'callout warn' }, t('No worker process is online. Start it with scripts/start.sh')));
      const ready = checks?.database?.ok && w.process_online && w.data.every((x) => x.status === 'running');
      body.append(ready && h('div', { class: 'callout' }, h('b', null, t('NABD AI Ready')), h('div', { class: 'muted' }, t('Everything is connected. Open the dashboard to start monitoring.'))));
      const finish = btn(t('Go to dashboard'), async () => { try { await post('/setup/complete'); } catch { /* admin only */ } location.hash = '#/'; onDone?.(); }, { kind: 'primary' });
      nav.append(btn(t('Back'), back), h('div', { class: 'row' }, btn(t('Check again'), () => draw()), w.process_online && !ready && btn(t('Start all'), async () => { try { await post('/system/workers/all/start'); setTimeout(draw, 1500); } catch (e) { showError(e); } }), finish));
    },
  ];
  async function draw() {
    clear(body); clear(nav); clear(bar).append(...titles.map((_, k) => h('span', { class: k <= i ? 'on' : '' }))); title.textContent = titles[i]; wrap.querySelector('.num').textContent = `${t('Step')} ${i + 1} ${t('of')} 7`;
    try { await steps[i](); } catch (e) { showError(e); }
  }
  draw();
}
export default async function setupPage(ctx) { renderWizard(ctx.root, { fresh: false, onDone: () => ctx.go('/') }); }
