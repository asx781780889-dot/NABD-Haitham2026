import { h, icon, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get, post } from '../lib/api.js';
import * as ws from '../lib/ws.js';
import { pageHead, btn, iconBtn, card, table, tabs, pager, badge, progress, statusDot, showError, toast, confirmBox, errorBox, skeletons, can, kpi } from '../lib/ui.js';

const ST = ['', 'running', 'queued', 'completed', 'failed', 'cancelled']; const LABEL = { '': 'All', running: 'Running', queued: 'Queued', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', paused: 'Paused' };
export default async function tasks(ctx) {
  const st = { state: '', page: 1 }; const op = can('operator'); const admin = can('admin'); const tbox = h('div'); const qbox = h('div'); const tabHost = h('div');
  ctx.root.append(pageHead(t('Tasks'), null, btn(t('Refresh'), () => { load(); loadQ(); }, { ic: 'refresh' })), qbox, h('div', { style: { height: '16px' } }), tabHost, tbox);
  const act = (path, ok) => async () => { try { await post(path); if (ok) toast(ok); load(); loadQ(); } catch (e) { showError(e); } };
  async function loadQ() {
    try {
      const q = await get('/system/queues'); clear(qbox);
      const names = Object.keys(q.counts ?? {});
      qbox.append(card(`${t('Queue')} · ${t('Processing')}: ${q.paused ? t('Paused') : t('Running')}`, h('div', { class: 'stack' },
        !q.redis && h('div', { class: 'callout warn' }, t('Redis is offline — the system keeps working in degraded mode.'), q.error && h('div', { class: 'xs mono' }, q.error)),
        q.counts && table({ rows: names.map((n) => ({ n, ...(q.counts[n] ?? {}) })), columns: [{ label: t('Queue'), render: (r) => h('b', null, r.n) }, ...['waiting', 'active', 'delayed', 'failed', 'completed'].map((k) => ({ label: t({ waiting: 'Waiting', active: 'Active', delayed: 'Delayed', failed: 'Failed', completed: 'Completed' }[k]), render: (r) => h('span', { class: `mono num ${k === 'failed' && r[k] ? 'b' : ''}`, style: k === 'failed' && r[k] ? { color: 'var(--bad)' } : {} }, r[k] ?? '–') }))] }),
        h('div', { class: 'row sm muted' }, h('span', null, `${t('Pending messages')}: `, h('b', { class: 'num' }, q.messages.pending)), h('span', null, `${t('Failed')}: `, h('b', { class: 'num' }, q.messages.failed))),
        admin && h('div', { class: 'row tight' }, q.paused ? btn(t('Resume processing'), act('/system/queues/resume'), { kind: 'primary', ic: 'play' }) : btn(t('Pause processing'), act('/system/queues/pause'), { ic: 'pause' }),
          btn(t('Retry failed jobs'), act('/system/queues/retry-failed', t('Done')), { ic: 'refresh' }),
          btn(t('Clear queue'), async () => { if (await confirmBox(t('Clearing the queue skips every pending message. Continue?'), { danger: true, ok: t('Clear queue') })) act('/system/queues/clear', t('Done'))(); }, { kind: 'danger', ic: 'trash' })))));
    } catch (e) { clear(qbox).append(errorBox(e, loadQ)); }
  }
  async function load() {
    try {
      const r = await get('/system/tasks', { state: st.state, page: st.page, limit: 20 }); const c = r.meta.counts ?? {};
      clear(tabHost).append(tabs(ST.map((s) => ({ id: s, label: `${t(LABEL[s])}${s ? ` (${c[s] ?? 0})` : ''}` })), st.state, (id) => { st.state = id; st.page = 1; load(); }));
      clear(tbox).append(table({ rows: r.data, empty: t('No data'), rowKey: (x) => x.id, columns: [
        { label: t('Task'), render: (x) => h('div', null, h('div', { class: 'b' }, x.title ?? x.name), h('div', { class: 'xs muted mono' }, `${x.name} · ${x.queue}`)) },
        { label: t('Status'), render: (x) => statusDot(x.state, t(LABEL[x.state] ?? x.state)) }, { label: t('Progress'), render: (x) => h('div', { style: { minWidth: '100px' } }, progress(x.progress), h('span', { class: 'xs num muted' }, `${x.progress}%`)) },
        { label: t('Started'), render: (x) => h('span', { class: 'xs num' }, fmt.dt(x.started_at)) }, { label: t('Ended'), render: (x) => h('span', { class: 'xs num' }, fmt.dt(x.finished_at)) }, { label: t('Duration'), render: (x) => h('span', { class: 'xs num' }, fmt.ms(x.duration_ms)) },
        { label: t('Errors'), render: (x) => x.error ? h('span', { class: 'xs clip', style: { color: 'var(--bad)', display: 'inline-block', maxWidth: '220px' }, title: x.error }, x.error) : '' },
        { label: '', act: true, render: (x) => op && h('div', { class: 'row tight' },
          ['queued', 'running'].includes(x.state) && iconBtn('pause', t('Pause'), act(`/system/tasks/${x.id}/pause`)), x.state === 'paused' && iconBtn('play', t('Resume'), act(`/system/tasks/${x.id}/resume`)),
          ['queued', 'running', 'paused'].includes(x.state) && iconBtn('x', t('Cancel task'), act(`/system/tasks/${x.id}/cancel`), 'danger'), ['failed', 'cancelled'].includes(x.state) && iconBtn('refresh', t('Retry task'), act(`/system/tasks/${x.id}/retry`))) },
      ] }), pager(r.meta, (p) => { st.page = p; load(); }));
    } catch (e) { clear(tbox).append(errorBox(e, load)); }
  }
  tbox.append(skeletons(2)); await Promise.all([load(), loadQ()]);
  let tm; const soon = () => { clearTimeout(tm); tm = setTimeout(() => { load(); loadQ(); }, 600); };
  ctx.onLeave(ws.on('job.update', soon)); const iv = setInterval(soon, 10000); ctx.onLeave(() => { clearInterval(iv); clearTimeout(tm); });
}
