import { h, icon, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get, post, del } from '../lib/api.js';
import * as ws from '../lib/ws.js';
import { pageHead, btn, iconBtn, card, tabs, pager, badge, table, showError, toast, errorBox, emptyState, skeletons, can } from '../lib/ui.js';
import { settingsEditor } from '../lib/settingsform.js';
import { enableBrowser, beep, browserSupported } from '../lib/notify.js';

const SEV = { info: 'info', low: '', medium: 'info', high: 'warn', critical: 'critical', warning: 'warn', error: 'bad' };
export default async function alerts(ctx) {
  let tab = 'list'; const box = h('div'); const st = { page: 1 };
  ctx.root.append(pageHead(t('Alerts'), null, btn(t('Mark all read'), async () => { try { await post('/alerts/read-all'); load(); } catch (e) { showError(e); } }, { ic: 'check' })), tabs([{ id: 'list', label: t('Alerts') }, { id: 'channels', label: t('Notification channels') }, { id: 'deliveries', label: t('Deliveries') }], tab, (id) => { tab = id; load(); }), box);
  async function load() {
    clear(box).append(skeletons(2));
    try {
      if (tab === 'list') {
        const r = await get('/alerts', { page: st.page, limit: 30 }); clear(box);
        if (!r.data.length) return box.append(emptyState(t('No alerts.'), 'bell'));
        box.append(h('div', { class: 'cards' }, r.data.map((a) => h('div', { class: `card ${a.status === 'read' ? '' : 'on'}`, style: { padding: '12px 14px', borderInlineStart: `3px solid var(--${a.severity === 'critical' ? 'critical' : a.severity === 'high' ? 'high' : 'line2'})`, opacity: a.status === 'read' ? 0.65 : 1 } },
          h('div', { class: 'row' }, badge(a.severity, SEV[a.severity]), badge(a.kind), h('b', { class: 'grow' }, a.title), h('span', { class: 'xs muted num' }, fmt.dt(a.created_at)), a.status !== 'read' && iconBtn('check', t('Done'), async () => { await post(`/alerts/${a.id}/read`); load(); }), can('operator') && iconBtn('trash', t('Delete'), async () => { await del(`/alerts/${a.id}`); load(); }, 'danger')),
          a.body && h('div', { class: 'muted sm', style: { whiteSpace: 'pre-wrap', marginTop: '6px' } }, a.body)))), pager(r.meta, (p) => { st.page = p; load(); }));
      } else if (tab === 'channels') {
        const { data: reg } = await get('/settings'); clear(box);
        const test = (ch) => btn(`${t('Send test')}: ${ch}`, async () => { try { const r = await post(`/settings/test/${ch}`); toast(r.ok ? t('Saved.') : r.error, r.ok ? 'info' : 'error', 6000); } catch (e) { showError(e); } }, { sm: true, ic: 'play' });
        const local = h('div', { class: 'row' }, browserSupported() && btn(t('Enable browser notifications'), enableBrowser, { ic: 'bell' }), btn(t('Play test sound'), () => beep('critical', true), { ic: 'play' }), h('span', { class: 'muted xs' }, `${t('Sound')} / ${t('Notifications')}: ${t('Mute alerts')} ↑`));
        const keys = (p) => Object.keys(reg).filter((k) => k.startsWith(`notify.${p}.`));
        const admin = can('admin');
        box.append(card(t('Browser notifications'), h('div', { class: 'stack' }, local, settingsEditor(reg, [...keys('dashboard'), ...keys('browser'), ...keys('sound')], { readOnly: !admin }).el)), h('div', { style: { height: '14px' } }),
          card('Telegram', settingsEditor(reg, keys('telegram'), { readOnly: !admin, extra: admin ? test('telegram') : null }).el), h('div', { style: { height: '14px' } }), card('Email', settingsEditor(reg, keys('email'), { readOnly: !admin, extra: admin ? test('email') : null }).el));
      } else {
        const { data } = await get('/alerts/deliveries'); clear(box);
        box.append(table({ rows: data, empty: t('No data'), columns: [{ label: t('Date'), render: (r) => h('span', { class: 'xs num' }, fmt.dt(r.created_at)) }, { label: t('Type'), render: (r) => badge(r.channel, 'info') }, { label: t('Title'), render: (r) => r.title }, { label: t('Status'), render: (r) => badge(r.status, r.status === 'sent' ? 'ok' : r.status === 'failed' ? 'bad' : 'warn') }, { label: t('Errors'), render: (r) => h('span', { class: 'xs muted' }, r.error ?? '') }] }));
      }
    } catch (e) { clear(box).append(errorBox(e, load)); }
  }
  await load(); ctx.onLeave(ws.on('alert.new', () => { if (tab === 'list' && st.page === 1) load(); }));
}
