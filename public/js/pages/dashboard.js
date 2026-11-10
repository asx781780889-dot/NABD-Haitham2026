import { h, icon, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get } from '../lib/api.js';
import * as ws from '../lib/ws.js';
import { pageHead, kpi, card, statusDot, emptyState, errorBox, can, btn } from '../lib/ui.js';
import { ChartSet, canvas } from '../lib/charts.js';
import { matchCard } from '../lib/card.js';

const KPIS = [
  ['accounts_total', 'Total Telegram accounts', 'users'], ['accounts_connected', 'Connected accounts', 'check', 'ok'], ['accounts_disconnected', 'Disconnected accounts', 'alert', 'bad0'], ['groups', 'Groups', 'layers'], ['channels', 'Channels', 'message'],
  ['chats', 'Chats', 'user'], ['messages_processed', 'Messages processed', 'activity'], ['matches', 'Matches', 'tag'], ['matches_high', 'High-priority matches', 'zap', 'warn'], ['ai_rules', 'AI rules', 'radar'],
  ['alerts_unread', 'Alerts (unread)', 'bell'], ['tasks_active', 'Active tasks', 'list'], ['tasks_failed', 'Failed tasks', 'alert', 'bad0'], ['messages_last_minute', 'Messages / min', 'pulse'], ['messages_pending', 'Pending messages', 'clock'],
];
const COMPONENTS = [['telegram', 'Telegram'], ['database', 'Database'], ['ai', 'AI Provider'], ['workers', 'Workers'], ['queue', 'Queue'], ['redis', 'Redis'], ['api', 'API'], ['scheduler', 'Scheduler'], ['storage', 'Storage']];

export default async function dashboard(ctx) {
  const kpiBox = h('div', { class: 'grid g4' }); const statusBox = h('div', { class: 'statusgrid' }); const recent = h('div', { class: 'cards' }); const chartHost = h('div');
  const charts = new ChartSet(); ctx.onLeave(() => charts.destroy());
  const paintKpis = (s) => { clear(kpiBox).append(...KPIS.map(([k, label, ic, tone]) => kpi({ label: t(label), value: fmt.num(s[k]), ic, tone: tone === 'bad0' ? (s[k] > 0 ? 'bad' : '') : tone === 'ok' ? (s[k] > 0 ? 'ok' : '') : tone === 'warn' ? (s[k] > 0 ? 'warn' : '') : '' }))); };
  const paintStatus = (st) => { if (!st) return; clear(statusBox).append(...COMPONENTS.map(([k, label]) => { const c = st[k] ?? { status: 'offline', detail: '–' }; return h('div', { class: 'stat' }, h('span', { class: `dot ${c.status}`, style: { marginTop: '6px' } }), h('div', { class: 'grow' }, h('b', null, t(label)), h('span', { class: `sv ${c.status}` }, t(c.status[0].toUpperCase() + c.status.slice(1))), c.detail && h('span', { class: 'sd', dir: 'auto', title: c.detail }, c.detail))); })); };
  async function refresh() { const { stats, status } = await get('/system/overview'); paintKpis(stats); paintStatus(status); return stats; }
  async function loadRecent() { const { data } = await get('/matches', { limit: 5, sort: 'created' }); clear(recent).append(...(data.length ? data.map((c) => matchCard(c, { compact: true })) : [emptyState(t('Waiting for new matches…'), 'activity')])); }
  async function loadChart() {
    const a = await get('/analytics/overview', { range: '24h' }); clear(chartHost); const { box, canvas: cv } = canvas('sm'); chartHost.append(box);
    charts.line(cv, a.series.map((p) => fmt.time(p.t).slice(0, 5)), [{ label: t('Messages'), data: a.series.map((p) => p.messages), fill: true }, { label: t('Matches'), data: a.series.map((p) => p.matches) }]);
  }
  try {
    const stats = await refresh();
    ctx.root.append(pageHead(t('Dashboard'), null, can('admin') && btn(t('Continue setup'), () => ctx.go('/setup'), { ic: 'sliders' }), btn(t('Refresh'), () => { refresh(); loadRecent(); loadChart(); }, { ic: 'refresh' })),
      stats.processing_paused ? h('div', { class: 'callout warn', style: { marginBottom: '14px' } }, t('Processing'), ': ', t('Paused')) : null, kpiBox,
      h('div', { class: 'grid g2', style: { marginTop: '16px' } }, card(t('Live system status'), statusBox), card(t('Throughput (24h)'), chartHost)),
      h('div', { style: { marginTop: '16px' } }, card(t('Recent matches'), recent, h('a', { class: 'btn sm', href: '#/feed' }, t('Live Feed')))));
    loadRecent(); loadChart().catch(() => {});
  } catch (e) { return ctx.root.append(errorBox(e, ctx.reload)); }
  let tm; const soon = () => { clearTimeout(tm); tm = setTimeout(() => refresh().catch(() => {}), 1200); };
  ctx.onLeave(ws.on('system.status', (m) => paintStatus(m.status))); ctx.onLeave(ws.on('account.status', soon)); ctx.onLeave(ws.on('job.update', soon));
  ctx.onLeave(ws.on('match.new', (m) => { soon(); recent.querySelector('.empty')?.remove(); recent.prepend(matchCard(m.card, { compact: true, fresh: true })); while (recent.children.length > 5) recent.lastChild.remove(); }));
  ctx.onLeave(() => clearTimeout(tm));
}
