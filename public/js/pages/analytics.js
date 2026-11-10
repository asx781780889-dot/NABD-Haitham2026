import { h, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get } from '../lib/api.js';
import { pageHead, kpi, card, errorBox, skeletons, emptyState } from '../lib/ui.js';
import { ChartSet, canvas, theme } from '../lib/charts.js';

export default async function analytics(ctx) {
  const charts = new ChartSet(); ctx.onLeave(() => charts.destroy()); const box = h('div'); let range = ctx.query.range ?? '24h';
  const sel = h('select', { style: { width: 'auto' }, onChange: () => { range = sel.value; load(); } }, [['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days']].map(([v, l]) => h('option', { value: v, selected: v === range }, t(l))));
  ctx.root.append(pageHead(t('Analytics'), null, h('label', { class: 'row tight' }, t('Range'), sel)), box);
  const chart = (title, fn, cls = '') => { const { box: b, canvas: c } = canvas(cls); const el = card(title, b); queueMicrotask(() => fn(c)); return el; };
  async function load() {
    charts.destroy(); clear(box).append(skeletons(3));
    try {
      const a = await get('/analytics/overview', { range }); clear(box); const c = theme(); const lbl = (p) => (range === '24h' || range === '7d' ? `${fmt.date(p.t).slice(0, 5)} ${fmt.time(p.t).slice(0, 2)}h` : fmt.date(p.t));
      const names = (rows, k = 'n') => [rows.map((r) => r.name), rows.map((r) => r[k])]; const noData = (rows) => !rows.length;
      const maybe = (title, rows, fn, cls) => (noData(rows) ? card(title, emptyState(t('No data'), 'chart')) : chart(title, fn, cls));
      box.append(h('div', { class: 'grid g4' }, kpi({ label: t('Messages'), value: fmt.num(a.totals.messages), ic: 'message' }), kpi({ label: t('Matches'), value: fmt.num(a.totals.matches), ic: 'tag', tone: 'ok' }), kpi({ label: t('High-priority matches'), value: fmt.num(a.totals.high), ic: 'zap', tone: 'warn' }),
        kpi({ label: t('Error rate'), value: `${a.totals.error_rate}%`, ic: 'alert', tone: a.totals.error_rate > 2 ? 'bad' : '' }), kpi({ label: t('AI calls'), value: fmt.num(a.ai_usage.calls), sub: `${t('Avg latency')}: ${fmt.ms(a.ai_usage.avg_ms)} · ${a.ai_usage.errors} ${t('Errors')}`, ic: 'cpu' })),
        h('div', { style: { height: '16px' } }), h('div', { class: 'grid g2' },
          chart(`${t('Messages per period')} / ${t('Matches per period')}`, (cv) => charts.line(cv, a.series.map(lbl), [{ label: t('Messages'), data: a.series.map((p) => p.messages), fill: true }, { label: t('Matches'), data: a.series.map((p) => p.matches) }, { label: t('Errors'), data: a.series.map((p) => p.errors), color: c.bad }])),
          maybe(t('Match distribution'), a.match_distribution, (cv) => charts.bars(cv, a.match_distribution.map((d) => `${d.bucket}%`), a.match_distribution.map((d) => d.n), { colors: a.match_distribution.map((d) => (d.bucket >= 80 ? c.accent : d.bucket >= 50 ? c.medium : c.low)) })),
          maybe(t('Priority split'), a.priority, (cv) => charts.doughnut(cv, a.priority.map((p) => t(p.name[0].toUpperCase() + p.name.slice(1))), a.priority.map((p) => p.n), a.priority.map((p) => c[p.name])), 'sm'),
          maybe(t('Match types'), a.match_types, (cv) => charts.doughnut(cv, a.match_types.map((p) => t(p.name[0].toUpperCase() + p.name.slice(1))), a.match_types.map((p) => p.n)), 'sm'),
          maybe(t('Top keywords'), a.top.keywords, (cv) => charts.bars(cv, ...names(a.top.keywords), { horizontal: true })), maybe(t('Top groups'), a.top.groups, (cv) => charts.bars(cv, a.top.groups.map((r) => r.name), a.top.groups.map((r) => r.matches), { horizontal: true })),
          maybe(t('Top accounts'), a.top.accounts, (cv) => charts.bars(cv, a.top.accounts.map((r) => r.name), a.top.accounts.map((r) => r.messages), { horizontal: true })), maybe(t('Top intents'), a.top.intents, (cv) => charts.bars(cv, ...names(a.top.intents), { horizontal: true })),
          maybe(t('AI classifications'), a.ai_classifications, (cv) => charts.doughnut(cv, ...names(a.ai_classifications)), 'sm')));
    } catch (e) { clear(box).append(errorBox(e, load)); }
  }
  await load();
}
