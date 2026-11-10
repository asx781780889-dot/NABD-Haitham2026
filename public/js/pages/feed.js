import { h, icon, clear } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { get } from '../lib/api.js';
import * as ws from '../lib/ws.js';
import { pageHead, btn, debounce, errorBox, skeletons, emptyState } from '../lib/ui.js';
import { matchCard } from '../lib/card.js';

const BUCKETS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]; const PRIS = ['low', 'medium', 'high', 'critical'];

export default async function feed(ctx) {
  const st = { q: '', min: 0, buckets: new Set(), prio: new Set(), account: '', source: '', intent: '', page: 1, paused: false, buffer: [], afterId: 0 };
  const els = new Map(); const list = h('div', { class: 'cards' }); const more = h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '14px' } });
  async function loadAllGroups() {
    const rows = []; let page = 1; let meta;
    do {
      const result = await get('/sources', { monitored: 'true', kind: ['group', 'supergroup'], limit: 200, page });
      rows.push(...result.data); meta = result.meta; page++;
    } while (meta.page < meta.pages);
    return rows;
  }
  const [{ data: accs }, srcs] = await Promise.all([get('/accounts'), loadAllGroups()]);
  const params = () => ({ q: st.q, min_score: st.min || '', buckets: [...st.buckets], priority: [...st.prio], account_id: st.account, source_id: st.source, intent: st.intent, after_id: st.afterId || '', pinned_first: 'true', limit: 25, page: st.page });
  const passes = (c) => (c.score >= st.min) && (!st.buckets.size || st.buckets.has(c.bucket ?? Math.max(10, Math.ceil(c.score / 10) * 10))) && (!st.prio.size || st.prio.has(c.priority)) && (!st.account || c.detected_by.some((a) => String(a.id) === st.account) || String(c.account.id) === st.account)
    && (!st.source || String(c.source.id) === st.source) && (!st.intent || (c.intent ?? '').toLowerCase().includes(st.intent.toLowerCase())) && (!st.q || `${c.text} ${c.keyword ?? ''} ${c.sender.username ?? ''} ${c.intent ?? ''}`.toLowerCase().includes(st.q.toLowerCase()));
  const insert = (c, fresh, prepend) => {
    const el = matchCard(c, { fresh, onChange: (nc) => replace(nc), onRemove: () => { els.get(c.id)?.remove(); els.delete(c.id); } });
    els.set(c.id, el); prepend ? list.prepend(el) : list.append(el); while (list.children.length > 400) { const last = list.lastChild; els.delete(Number(last.dataset.id)); last.remove(); }
  };
  const replace = (nc) => { const old = els.get(nc.id); if (!old) return; const el = matchCard(nc, { onChange: replace, onRemove: () => { el.remove(); els.delete(nc.id); } }); old.replaceWith(el); els.set(nc.id, el); };
  async function load(reset = true) {
    try {
      if (reset) { st.page = 1; clear(list).append(skeletons(3)); els.clear(); }
      const { data, meta } = await get('/matches', params()); if (reset) clear(list);
      if (!data.length && reset) list.append(emptyState(t('Waiting for new matches…'), 'activity'));
      for (const c of data) insert(c, false, false);
      clear(more).append(meta.page < meta.pages && btn(t('Load more'), () => { st.page++; load(false); }));
    } catch (e) { clear(list).append(errorBox(e, () => load(true))); }
  }
  const pauseBtn = btn(t('Pause feed'), () => { st.paused = !st.paused; if (!st.paused) flush(); paint(); }, { ic: 'pause' });
  function paint() { const label = st.paused ? `${t('Resume feed')}${st.buffer.length ? ` (${st.buffer.length} ${t('new')})` : ''}` : t('Pause feed'); clear(pauseBtn).append(icon(st.paused ? 'play' : 'pause'), label); pauseBtn.setAttribute('aria-label', label); pauseBtn.classList.toggle('on', st.paused); }
  function flush() { list.querySelector('.empty')?.remove(); for (const c of st.buffer.splice(0).reverse()) if (!els.has(c.id)) insert(c, true, true); }
  const bucketBar = h('div', { class: 'bucketbar' }); const prioBar = h('div', { class: 'bucketbar' });
  const drawBars = () => { clear(bucketBar).append(btn(t('All'), () => { st.buckets.clear(); drawBars(); load(); }, { sm: true, kind: st.buckets.size ? '' : 'on' }), ...BUCKETS.map((b) => btn(`${b}%`, () => { st.buckets.has(b) ? st.buckets.delete(b) : st.buckets.add(b); drawBars(); load(); }, { sm: true, kind: st.buckets.has(b) ? 'on' : '' })));
    clear(prioBar).append(...PRIS.map((p) => btn(t(p[0].toUpperCase() + p.slice(1)), () => { st.prio.has(p) ? st.prio.delete(p) : st.prio.add(p); drawBars(); load(); }, { sm: true, kind: st.prio.has(p) ? 'on' : '' }))); };
  drawBars();
  const q = h('input', { type: 'search', placeholder: t('Search'), onInput: debounce(() => { st.q = q.value; load(); }) });
  const min = h('input', { type: 'number', min: 0, max: 100, placeholder: t('Min %'), style: { width: '96px' }, onInput: debounce(() => { st.min = Number(min.value) || 0; load(); }) });
  const accSel = h('select', { onChange: () => { st.account = accSel.value; load(); } }, h('option', { value: '' }, `${t('Account')}: ${t('All')}`), accs.map((a) => h('option', { value: a.id }, a.name)));
  const srcSel = h('select', { onChange: () => { st.source = srcSel.value; load(); } }, h('option', { value: '' }, `${t('Group')}: ${t('All')}`), srcs.map((s) => h('option', { value: s.id }, s.title ?? s.tg_chat_id)));
  const intent = h('input', { placeholder: t('Intent filter'), onInput: debounce(() => { st.intent = intent.value; load(); }) });
  const liveDot = h('span', { class: 'livechip' }, h('span', { class: 'dot online' }), t('Live'));
  ctx.root.append(pageHead(t('Live Feed'), null, liveDot, pauseBtn, btn(t('Clear'), () => { const ids = [...els.keys()]; st.afterId = Math.max(0, ...ids); st.buffer = []; clear(list).append(emptyState(t('Waiting for new matches…'), 'activity')); els.clear(); clear(more); paint(); }, { ic: 'trash' })),
    h('div', { class: 'card', style: { marginBottom: '14px' } }, h('div', { class: 'filters' }, q, min, accSel, srcSel, intent), h('div', { class: 'stack tight' }, h('div', { class: 'row' }, h('span', { class: 'lbl' }, t('Match')), bucketBar), h('div', { class: 'row' }, h('span', { class: 'lbl' }, t('Priority')), prioBar))), list, more);
  await load();
  ctx.onLeave(ws.on('match.new', (m) => { const c = m.card; if (!passes(c) || els.has(c.id)) return; st.afterId = 0; if (st.paused) { st.buffer.push(c); paint(); } else { list.querySelector('.empty')?.remove(); insert(c, true, true); } }));
  ctx.onLeave(ws.on('match.update', (m) => { if (els.has(m.card.id)) replace(m.card); }));
  ctx.onLeave(ws.on('ws:open', () => { if (!st.paused) load(); }));
}
