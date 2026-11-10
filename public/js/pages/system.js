import { h, icon, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get, post, api } from '../lib/api.js';
import * as ws from '../lib/ws.js';
import { pageHead, btn, iconBtn, card, table, tabs, kpi, badge, statusDot, showError, toast, confirmBox, errorBox, skeletons, can, askPassword } from '../lib/ui.js';

const PAUSABLE = ['processor', 'keyword', 'ai', 'notification', 'analytics'];
const LEVEL_L = { normal: 'Normal', warning: 'Warning', high_risk: 'High risk', critical: 'Critical', emergency_prep: 'Emergency prep', emergency: 'Emergency' };
const LEVEL_C = { normal: 'var(--ok)', warning: 'var(--warn)', high_risk: 'var(--high)', critical: 'var(--critical)', emergency_prep: 'var(--critical)', emergency: 'var(--critical)' };

export default async function system(ctx) {
  let tab = ctx.query.tab ?? 'workers'; const box = h('div'); const admin = can('admin'); const op = can('operator');
  const items = [{ id: 'workers', label: t('Workers') }, ...(op ? [{ id: 'database', label: t('Database') }] : []), ...(admin ? [{ id: 'backups', label: t('Backups') }] : []), { id: 'health', label: 'Health' }];
  ctx.root.append(pageHead(t('System'), 'Workers · Database · Backups · Health'), tabs(items, tab, (id) => { tab = id; load(); }), box);
  const call = (path, ok) => async () => { try { await post(path); if (ok) toast(ok); setTimeout(load, 700); } catch (e) { showError(e); } };

  async function workers() {
    const r = await get('/system/workers');
    return h('div', { class: 'stack' }, !r.process_online && h('div', { class: 'callout bad' }, t('No worker process is online. Start it with scripts/start.sh')),
      admin && h('div', { class: 'row tight' }, ...[['start', 'Start all', 'play'], ['restart', 'Restart all', 'refresh']].map(([a, l, ic]) => btn(t(l), call(`/system/workers/all/${a}`), { ic })), btn(t('Stop all'), async () => { if (await confirmBox(t('Stop all'), { danger: true, ok: t('Stop all') })) call('/system/workers/all/stop')(); }, { kind: 'danger', ic: 'pause' })),
      table({ rows: r.data, columns: [{ label: t('Module'), render: (w) => h('b', null, w.name) }, { label: t('Status'), render: (w) => statusDot(w.status, t(w.status[0].toUpperCase() + w.status.slice(1))) }, { label: t('Processed'), render: (w) => h('span', { class: 'mono num' }, fmt.num(w.processed)) }, { label: t('Failed'), render: (w) => h('span', { class: 'mono num' }, fmt.num(w.failed)) },
        { label: t('Heartbeat'), render: (w) => h('span', { class: 'xs' }, fmt.ago(w.last_heartbeat)) }, { label: t('Errors'), render: (w) => h('span', { class: 'xs', style: { color: 'var(--bad)' } }, w.last_error ?? '') },
        { label: '', act: true, render: (w) => admin && h('div', { class: 'row tight' }, w.status !== 'running' && w.status !== 'paused' && iconBtn('play', t('Start'), call(`/system/workers/${w.name}/start`)), w.status === 'running' && PAUSABLE.includes(w.name) && iconBtn('pause', t('Pause'), call(`/system/workers/${w.name}/pause`)), w.status === 'paused' && iconBtn('play', t('Resume'), call(`/system/workers/${w.name}/resume`)),
          ['running', 'paused', 'error'].includes(w.status) && iconBtn('refresh', t('Restart'), call(`/system/workers/${w.name}/restart`)), ['running', 'paused'].includes(w.status) && iconBtn('x', t('Stop'), call(`/system/workers/${w.name}/stop`), 'danger')) }] }));
  }
  async function database() {
    const { data: d } = await get('/system/database'); const color = LEVEL_C[d.level]; const out = h('div');
    const gauge = h('div', { class: 'gauge' }, h('i', { style: { width: `${Math.min(100, d.percent)}%`, background: color } }), ...[70, 80, 90, 95, 98].map((p) => h('span', { class: 'tick', style: { insetInlineStart: `${p}%` } })));
    return h('div', { class: 'stack' },
      d.emergency_active && h('div', { class: 'callout bad' }, t('Emergency mode is ON: ingestion is paused to protect the database. Nothing was deleted.'), admin && h('div', { style: { marginTop: '8px' } }, btn(t('Clear emergency mode'), async () => { try { await post('/system/database/emergency/clear'); load(); } catch (e) { showError(e); } }, { sm: true }))),
      card(`${t('Database capacity')} — ${t(LEVEL_L[d.level])}`, h('div', { class: 'stack' }, gauge, h('div', { class: 'row sm muted' }, h('b', { style: { color } }, `${d.percent}%`), h('span', null, `${t('Size')}: ${fmt.bytes(d.size_bytes)}`), h('span', null, `${t('Limit')}: ${d.limit_bytes ? fmt.bytes(d.limit_bytes) : '–'} (${d.limit_source})`), h('span', { class: 'xs' }, d.ladder.slice().reverse().map((l) => `${l.min}% ${t(LEVEL_L[l.id])}`).join(' · '))))),
      h('div', { class: 'grid g4' }, kpi({ label: t('Connections'), value: `${d.connections.used}/${d.connections.max}` }), kpi({ label: t('WAL size'), value: d.wal_bytes == null ? 'n/a' : fmt.bytes(d.wal_bytes) }), kpi({ label: t('Temp files'), value: `${d.temp.files} · ${fmt.bytes(d.temp.bytes)}` }), kpi({ label: t('Replication slots'), value: d.replication_slots?.length ?? 'n/a' })),
      h('div', { class: 'grid g2' }, card(t('Largest tables'), table({ rows: d.tables, columns: [{ label: t('Name'), render: (x) => h('span', { class: 'mono xs' }, x.name) }, { label: t('Size'), render: (x) => h('span', { class: 'num' }, fmt.bytes(x.bytes)) }, { label: '#', render: (x) => h('span', { class: 'num' }, fmt.num(x.rows)) }] })), card(t('Largest indexes'), table({ rows: d.indexes, columns: [{ label: t('Name'), render: (x) => h('span', { class: 'mono xs' }, x.name) }, { label: t('Size'), render: (x) => h('span', { class: 'num' }, fmt.bytes(x.bytes)) }] }))),
      d.long_running_queries.length > 0 && card(t('Long-running queries'), table({ rows: d.long_running_queries, columns: [{ label: 'PID', render: (x) => x.pid }, { label: t('Duration'), render: (x) => `${x.seconds}s` }, { label: 'SQL', render: (x) => h('span', { class: 'mono xs' }, x.query) }] })),
      admin && card(t('Safe cleanup'), h('div', { class: 'stack' }, h('p', { class: 'muted sm' }, t('Old unmatched messages are soft-deleted first and purged only after a grace period. Messages behind cards are never touched.')),
        h('div', { class: 'row' }, btn(t('Preview cleanup'), async () => { try { const r = await post('/system/database/cleanup-preview'); clear(out).append(h('div', { class: 'pre' }, JSON.stringify(r.data, null, 2))); } catch (e) { showError(e); } }, { ic: 'eye' }), btn(t('Run cleanup'), async () => { if (await confirmBox(t('Run cleanup'), { danger: true, ok: t('Run cleanup') })) { try { await post('/system/database/cleanup'); toast(t('Tasks')); } catch (e) { showError(e); } } }, { kind: 'danger', ic: 'trash' })), out)));
  }
  async function backups() {
    const r = await get('/system/backups');
    const download = async (b) => {
      const pw = await askPassword(); if (!pw) return;
      try { const res = await api('GET', `/system/backups/${b.id}/download`, undefined, { raw: true, headers: { 'x-confirm-password': pw } }); if (!res.ok) throw new Error((await res.json()).error?.message ?? res.status); const url = URL.createObjectURL(await res.blob()); const a = h('a', { href: url, download: b.file_name }); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url); } catch (e) { showError(e); }
    };
    const create = (kind, label) => btn(label, async () => { try { await post('/system/backups', { kind }); toast(t('Tasks')); setTimeout(load, 1500); } catch (e) { showError(e); } }, { ic: 'database' });
    return h('div', { class: 'stack' }, h('div', { class: 'callout warn' }, t('Backups are encrypted with your MASTER_KEY. Keep that key safe — without it they cannot be restored.')),
      h('div', { class: 'row' }, create('database', t('Database backup')), create('config', t('Configuration backup')), create('rules', t('Rules backup'))),
      table({ rows: r.data, empty: t('No data'), columns: [{ label: t('Date'), render: (b) => h('span', { class: 'xs num' }, fmt.dt(b.created_at)) }, { label: t('Type'), render: (b) => badge(b.kind, 'info') }, { label: t('Name'), render: (b) => h('span', { class: 'mono xs' }, b.file_name) }, { label: t('Size'), render: (b) => fmt.bytes(b.size_bytes) }, { label: t('Status'), render: (b) => badge(b.status, b.status === 'ok' ? 'ok' : 'bad') },
        { label: '', act: true, render: (b) => b.status === 'ok' && h('div', { class: 'row tight' }, iconBtn('download', t('Download'), () => download(b)), iconBtn('trash', t('Delete'), async () => { if (await confirmBox(`${t('Delete')}: ${b.file_name}?`, { danger: true, ok: t('Delete') })) { try { await api('DELETE', `/system/backups/${b.id}`); load(); } catch (e) { showError(e); } } }, 'danger')) }] }));
  }
  async function health() {
    const { status } = await get('/system/status');
    return h('div', { class: 'stack' }, h('div', { class: 'row' }, ...['/health', '/ready', '/metrics'].map((p) => h('a', { class: 'btn', href: p, target: '_blank', rel: 'noopener' }, icon('external'), p))),
      h('div', { class: 'statusgrid' }, Object.entries(status).map(([k, c]) => h('div', { class: 'stat' }, h('span', { class: `dot ${c.status}`, style: { marginTop: '6px' } }), h('div', null, h('b', null, k), h('span', { style: { display: 'block' } }, `${c.status}${c.detail ? ` · ${c.detail}` : ''}`))))));
  }
  async function load() {
    try { const view = await ({ workers, database, backups, health }[tab])(); clear(box).append(view); } catch (e) { clear(box).append(errorBox(e, load)); }
  }
  box.append(skeletons(2)); await load();
  let tm; const soon = () => { clearTimeout(tm); tm = setTimeout(() => { if (tab === 'workers' || tab === 'health') load(); }, 800); }; ctx.onLeave(ws.on('worker.status', soon)); ctx.onLeave(ws.on('system.status', soon)); ctx.onLeave(() => clearTimeout(tm));
}
