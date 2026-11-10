import { h, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get, post, del } from '../lib/api.js';
import { pageHead, btn, form, card, kpi, table, exportMenu, errorBox, toast, showError, iconBtn, can, emptyState } from '../lib/ui.js';
import { ChartSet, canvas, theme } from '../lib/charts.js';

const iso = (d) => d.toISOString().slice(0, 16);
export default async function reports(ctx) {
  const charts = new ChartSet(); ctx.onLeave(() => charts.destroy());
  const [{ data: accs }, { data: radars }, { data: saved }] = await Promise.all([get('/accounts'), get('/radar'), get('/reports')]);
  const f = form([{ key: 'from', label: t('From'), type: 'datetime-local', value: iso(new Date(Date.now() - 7 * 864e5)) }, { key: 'to', label: t('To'), type: 'datetime-local', value: iso(new Date()) },
    { key: 'account_id', label: t('Account'), type: 'select', options: [{ value: '', label: t('Any') }, ...accs.map((a) => ({ value: a.id, label: a.name }))] }, { key: 'rule_id', label: t('Radar'), type: 'select', options: [{ value: '', label: t('Any') }, ...radars.map((r) => ({ value: r.id, label: r.name }))] },
    { key: 'min_score', label: t('Min %'), type: 'number', min: 0, max: 100 }, { key: 'priority', label: t('Priority'), type: 'checks', options: ['low', 'medium', 'high', 'critical'].map((value) => ({ value, label: t(value[0].toUpperCase() + value.slice(1)) })) }]);
  f.el.className = 'grid g4'; const out = h('div'); const savedBox = h('div', { class: 'row' });
  const params = () => { const v = f.get(); return Object.fromEntries(Object.entries({ ...v, from: v.from ? new Date(v.from).toISOString() : '', to: v.to ? new Date(v.to).toISOString() : '', min_score: v.min_score ?? '', priority: v.priority.join(',') }).filter(([, x]) => x !== '' && x != null)); };
  const drawSaved = () => { clear(savedBox).append(h('span', { class: 'muted sm' }, t('Saved reports')), ...saved.map((r) => h('span', { class: 'chip' }, h('a', { href: '#', onClick: (e) => { e.preventDefault(); for (const [k, v] of Object.entries(r.params)) if (f.ctl[k]) f.set(k, k === 'priority' ? String(v).split(',') : k === 'from' || k === 'to' ? iso(new Date(v)) : v); }, }, r.name), h('button', { class: 'btn icon sm ghost', style: { width: '18px', height: '18px', padding: 0 }, onClick: async () => { await del(`/reports/${r.id}`); saved.splice(saved.indexOf(r), 1); drawSaved(); } }, '×')))); };
  drawSaved();
  async function run() {
    charts.destroy(); clear(out);
    try {
      const p = params(); const { data: r } = await get('/reports/run', p); const c = theme();
      out.append(h('div', { class: 'row', style: { margin: '14px 0' } }, h('h2', { class: 'grow' }, `${fmt.date(r.period.from)} → ${fmt.date(r.period.to)}`), exportMenu('/export/report', p)),
        h('div', { class: 'grid g4' }, kpi({ label: t('Messages'), value: fmt.num(r.totals.messages) }), kpi({ label: t('Matches'), value: fmt.num(r.totals.matches), tone: 'ok' }), kpi({ label: t('Unique users'), value: fmt.num(r.totals.users) }), kpi({ label: t('Avg score'), value: `${Math.round(r.totals.avg_score)}%` }), kpi({ label: t('Avg AI confidence'), value: `${Math.round(r.totals.avg_ai_confidence)}%` })));
      const mk = (title, fn) => { const { box, canvas: cv } = canvas('sm'); out.append(card(title, box)); queueMicrotask(() => fn(cv)); };
      out.append(h('div', { style: { height: '14px' } }));
      if (r.by_day.length) mk(t('Matches per period'), (cv) => charts.line(cv, r.by_day.map((d) => fmt.date(d.day)), [{ label: t('Matches'), data: r.by_day.map((d) => d.n), fill: true }]));
      const tbl = (title, rows) => card(title, rows.length ? table({ rows, columns: [{ label: t('Name'), render: (x) => x.name }, { label: '#', render: (x) => h('span', { class: 'mono num' }, x.n) }] }) : emptyState(t('No data'), 'chart'));
      out.append(h('div', { style: { height: '14px' } }), h('div', { class: 'grid g3' }, tbl(t('Sources'), r.sources), tbl(t('Keywords'), r.keywords), tbl(t('Top intents'), r.intents), tbl(t('Accounts'), r.accounts), tbl(t('Priority split'), r.priority), tbl(t('Match distribution'), r.confidence_buckets.map((b) => ({ name: `${b.name}%`, n: b.n })))));
    } catch (e) { clear(out).append(errorBox(e, run)); }
  }
  ctx.root.append(pageHead(t('Report builder'), null), card(null, h('div', { class: 'stack' }, f.el, savedBox, h('div', { class: 'row' }, btn(t('Run report'), run, { kind: 'primary', ic: 'play' }), can('operator') && btn(t('Save report'), async () => { const name = prompt(t('Name')); if (!name) return; try { const r = await post('/reports', { name, params: params() }); saved.unshift(r.data); drawSaved(); toast(t('Saved.')); } catch (e) { showError(e); } }, { ic: 'save' })))), out);
}
