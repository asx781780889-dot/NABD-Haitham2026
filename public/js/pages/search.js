import { h, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get } from '../lib/api.js';
import { pageHead, btn, form, card, table, pager, errorBox, exportMenu, emptyState, badge, skeletons } from '../lib/ui.js';
import { matchCard } from '../lib/card.js';

export default async function search(ctx) {
  const [{ data: accs }, { data: radars }] = await Promise.all([get('/accounts'), get('/radar')]);
  const f = form([
    { key: 'scope', label: t('Type'), type: 'select', options: [{ value: 'matches', label: t('Matches only') }, { value: 'messages', label: t('All stored messages') }], value: 'matches' },
    { key: 'q', label: t('Keyword'), value: ctx.query.q ?? '' }, { key: 'user', label: t('User') }, { key: 'user_id', label: t('User ID'), type: 'number', dir: 'ltr' }, { key: 'source', label: `${t('Group')} / ${t('Channel')}` },
    { key: 'account_id', label: t('Account'), type: 'select', options: [{ value: '', label: t('Any') }, ...accs.map((a) => ({ value: a.id, label: a.name }))] },
    { key: 'from', label: t('From'), type: 'datetime-local' }, { key: 'to', label: t('To'), type: 'datetime-local' }, { key: 'intent', label: t('Intent') },
    { key: 'priority', label: t('Priority'), type: 'checks', options: ['low', 'medium', 'high', 'critical'].map((value) => ({ value, label: t(value[0].toUpperCase() + value.slice(1)) })) },
    { key: 'min_score', label: `${t('Min %')}`, type: 'number', min: 0, max: 100 }, { key: 'rule_id', label: t('Radar'), type: 'select', options: [{ value: '', label: t('Any') }, ...radars.map((r) => ({ value: r.id, label: r.name }))] },
  ]);
  f.el.className = 'grid g4';
  const out = h('div'); const st = { page: 1 };
  const params = () => { const v = f.get(); const iso = (x) => (x ? new Date(x).toISOString() : ''); return { ...v, user_id: v.user_id ?? '', from: iso(v.from), to: iso(v.to), priority: v.priority, min_score: v.min_score ?? '' }; };
  async function run(resetPage = true) {
    if (resetPage) st.page = 1; const p = params(); clear(out).append(skeletons(2));
    try {
      const r = await get('/search', { ...p, limit: 20, page: st.page }); clear(out);
      out.append(h('div', { class: 'row', style: { marginBottom: '10px' } }, h('span', { class: 'muted' }, `${t('Showing')} ${fmt.num(r.meta.total)} ${t('results')}`), p.scope !== 'messages' && h('span', { class: 'end' }, exportMenu('/export/matches', Object.fromEntries(Object.entries(p).filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length)).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]))))));
      if (!r.data.length) out.append(emptyState(t('No results yet.')));
      else if (p.scope === 'messages') out.append(table({ rows: r.data, columns: [{ label: t('Date'), render: (m) => h('span', { class: 'xs num' }, fmt.dt(m.sent_at)) }, { label: t('Source'), render: (m) => m.source_title }, { label: t('User'), render: (m) => h('span', null, m.sender_username ? `@${m.sender_username}` : m.sender_name ?? '–', h('div', { class: 'mono xs muted' }, m.sender_id ?? '')) }, { label: t('Message'), render: (m) => h('div', { style: { minWidth: '260px', unicodeBidi: 'plaintext' } }, m.text) }, { label: t('Status'), render: (m) => m.match_id ? badge(`#${m.match_id}`, 'ok') : badge(m.state) }] }));
      else out.append(h('div', { class: 'cards' }, r.data.map((c) => matchCard(c, { onChange: () => run(false) }))));
      out.append(pager(r.meta, (pg) => { st.page = pg; run(false); }));
    } catch (e) { clear(out).append(errorBox(e, () => run())); }
  }
  f.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') run(); });
  ctx.root.append(pageHead(t('Advanced search'), null), card(null, h('div', { class: 'stack' }, f.el, h('div', { class: 'row' }, btn(t('Search'), () => run(), { kind: 'primary', ic: 'search' }), btn(t('Clear'), () => { ctx.reload(); }, {})))), h('div', { style: { height: '14px' } }), out);
  if (ctx.query.q) run();
}
