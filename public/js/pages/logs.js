import { h, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get } from '../lib/api.js';
import { pageHead, tabs, table, pager, form, btn, levelBadge, badge, exportMenu, errorBox, skeletons, debounce, can, toggle } from '../lib/ui.js';

export default async function logs(ctx) {
  let tab = 'system'; const st = { page: 1 }; const box = h('div'); const bar = h('div'); let auto = false; let iv = null; const admin = can('admin');
  const tabList = [{ id: 'system', label: t('System log') }, ...(admin ? [{ id: 'audit', label: t('Audit log') }] : [])];
  ctx.root.append(pageHead(t('Logs')), tabs(tabList, tab, (id) => { tab = id; st.page = 1; drawBar(); load(); }), bar, box);
  const SYS = form([{ key: 'level', label: t('Level'), type: 'select', options: [{ value: '', label: t('All') }, 'debug', 'info', 'warning', 'error', 'critical'] }, { key: 'q', label: t('Search') }, { key: 'source', label: t('Source') }, { key: 'from', label: t('From'), type: 'datetime-local' }, { key: 'to', label: t('To'), type: 'datetime-local' }]);
  const AUD = form([{ key: 'action', label: t('Action') }, { key: 'user', label: t('User') }, { key: 'result', label: t('Result'), type: 'select', options: [{ value: '', label: t('All') }, 'success', 'denied', 'failure'] }, { key: 'q', label: t('Search') }, { key: 'from', label: t('From'), type: 'datetime-local' }, { key: 'to', label: t('To'), type: 'datetime-local' }]);
  const iso = (v) => (v ? new Date(v).toISOString() : ''); const params = (f) => { const v = f.get(); return { ...v, from: iso(v.from), to: iso(v.to) }; };
  function drawBar() {
    const f = tab === 'system' ? SYS : AUD; f.el.className = 'grid g4'; f.el.style.display = 'grid';
    clear(bar).append(f.el, h('div', { class: 'row', style: { margin: '10px 0 14px' } }, btn(t('Search'), () => { st.page = 1; load(); }, { kind: 'primary', ic: 'search' }), tab === 'system' && toggle(auto, (v) => { auto = v; clearInterval(iv); if (v) iv = setInterval(load, 5000); }, t('Auto refresh')), tab === 'audit' && h('span', { class: 'end' }, exportMenu('/export/audit', Object.fromEntries(Object.entries(params(AUD)).filter(([, v]) => v))))));
    f.el.onkeydown = debounce((e) => { if (e.key === 'Enter') { st.page = 1; load(); } }, 10);
  }
  async function load() {
    try {
      const f = tab === 'system' ? SYS : AUD; const r = await get(tab === 'system' ? '/system/logs' : '/system/audit', { ...params(f), page: st.page, limit: 50 }); clear(box);
      box.append(tab === 'system'
        ? table({ rows: r.data, empty: t('No data'), columns: [{ label: t('Time'), render: (x) => h('span', { class: 'xs num nowrap' }, fmt.dt(x.created_at)) }, { label: t('Level'), render: (x) => levelBadge(x.level) }, { label: t('Source'), render: (x) => h('span', { class: 'mono xs' }, x.source) }, { label: t('Message'), render: (x) => h('div', null, x.message, x.context && h('div', { class: 'xs muted mono clip', style: { maxWidth: '520px' }, title: JSON.stringify(x.context) }, JSON.stringify(x.context))) }, { label: t('Request'), render: (x) => h('span', { class: 'mono xs faint' }, x.request_id ?? '') }] })
        : table({ rows: r.data, empty: t('No data'), columns: [{ label: t('Time'), render: (x) => h('span', { class: 'xs num nowrap' }, fmt.dt(x.created_at)) }, { label: t('User'), render: (x) => x.username }, { label: t('Action'), render: (x) => h('span', { class: 'mono xs b' }, x.action) }, { label: t('Result'), render: (x) => badge(x.result, x.result === 'success' ? 'ok' : 'bad') }, { label: t('Details'), render: (x) => h('span', { class: 'xs muted mono clip', style: { display: 'inline-block', maxWidth: '360px' }, title: x.details ? JSON.stringify(x.details) : '' }, [x.entity && `${x.entity}#${x.entity_id}`, x.details && JSON.stringify(x.details)].filter(Boolean).join(' ')) }, { label: 'IP', render: (x) => h('span', { class: 'mono xs faint' }, x.ip ?? '') }, { label: t('Request'), render: (x) => h('span', { class: 'mono xs faint' }, x.request_id ?? '') }] }),
        pager(r.meta, (p) => { st.page = p; load(); }));
    } catch (e) { clear(box).append(errorBox(e, load)); }
  }
  drawBar(); box.append(skeletons(2)); await load(); ctx.onLeave(() => clearInterval(iv));
}
