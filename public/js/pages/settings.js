import { h, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get, post, patch, del } from '../lib/api.js';
import { pageHead, btn, iconBtn, card, tabs, table, form, modal, toast, showError, confirmBox, badge, errorBox, skeletons, can, toggle } from '../lib/ui.js';
import { settingsEditor } from '../lib/settingsform.js';
import { applyPrefs } from '../app.js';

const GROUPS = [['general', 'General'], ['appearance', 'Appearance'], ['telegram', 'Telegram'], ['notifications', 'Notifications'], ['ai', 'AI Settings'], ['security', 'Security'], ['database', 'Database'], ['workers', 'Workers'], ['queue', 'Queue'], ['radar', 'Smart Radar'], ['keywords', 'Keywords'], ['backup', 'Backup'], ['logs', 'Logs']];
const ROLES = [['admin', 'Administrator'], ['operator', 'Operator'], ['viewer', 'Viewer']];

export default async function settings(ctx) {
  const admin = can('admin'); let tab = ctx.query.tab ?? (admin ? 'general' : 'profile'); const box = h('div');
  const items = [...(admin ? GROUPS : []).map(([id, l]) => ({ id, label: t(l) })), ...(admin ? [{ id: 'users', label: t('Users') }] : []), { id: 'profile', label: t('Profile') }];
  ctx.root.append(pageHead(t('Settings')), tabs(items, tab, (id) => { tab = id; load(); }), box);

  async function users() {
    const { data } = await get('/users');
    const add = btn(t('Add user'), () => { const f = form([{ key: 'username', label: t('Username') }, { key: 'password', label: t('Password'), type: 'password' }, { key: 'role', label: t('Role'), type: 'select', options: ROLES.map(([value, l]) => ({ value, label: t(l) })), value: 'operator' }, { key: 'display_name', label: t('Display name') }]); const m = modal({ title: t('Add user'), body: f.el, footer: [btn(t('Cancel'), () => m.close()), btn(t('Create'), async () => { try { await post('/users', f.get()); m.close(); load(); } catch (e) { showError(e); } }, { kind: 'primary' })] }); }, { kind: 'primary', ic: 'plus' });
    return h('div', { class: 'stack' }, h('div', null, add), table({ rows: data, columns: [{ label: t('Username'), render: (u) => h('div', null, h('b', null, u.username), h('div', { class: 'xs muted' }, u.display_name ?? '')) },
      { label: t('Role'), render: (u) => h('select', { style: { width: 'auto' }, onChange: async (e) => { try { await patch(`/users/${u.id}`, { role: e.target.value }); toast(t('Saved.')); } catch (er) { showError(er); load(); } } }, ROLES.map(([v, l]) => h('option', { value: v, selected: v === u.role }, t(l)))) },
      { label: t('Active'), render: (u) => toggle(u.is_active, async (v) => { try { await patch(`/users/${u.id}`, { is_active: v }); } catch (e) { showError(e); load(); } }) }, { label: t('Last login'), render: (u) => h('span', { class: 'xs' }, fmt.ago(u.last_login_at)) },
      { label: '', act: true, render: (u) => h('div', { class: 'row tight' }, iconBtn('key', t('Change password'), () => { const f = form([{ key: 'password', label: t('New password'), type: 'password' }]); const m = modal({ title: u.username, body: f.el, footer: [btn(t('Cancel'), () => m.close()), btn(t('Save'), async () => { try { await patch(`/users/${u.id}`, f.get()); m.close(); toast(t('Saved.')); } catch (e) { showError(e); } }, { kind: 'primary' })] }); }), iconBtn('trash', t('Delete'), async () => { if (await confirmBox(`${t('Delete')}: ${u.username}?`, { danger: true, ok: t('Delete') })) { try { await del(`/users/${u.id}`); load(); } catch (e) { showError(e); } } }, 'danger')) }] }));
  }
  function profile() {
    const me = ctx.user; const f = form([{ key: 'display_name', label: t('Display name'), value: me.display_name ?? me.username }]);
    const pw = form([{ key: 'current', label: t('Current password'), type: 'password' }, { key: 'next', label: t('New password'), type: 'password' }]);
    return h('div', { class: 'grid g2' }, card(t('Profile'), h('div', { class: 'stack' }, f.el, h('div', { class: 'row' }, btn(t('Save'), async () => { try { await patch('/auth/preferences', f.get()); toast(t('Saved.')); } catch (e) { showError(e); } }, { kind: 'primary' }), badge(t(ROLES.find(([r]) => r === me.role)[1]), 'info')))),
      card(t('Change password'), h('div', { class: 'stack' }, pw.el, btn(t('Change password'), async () => { try { await post('/auth/password', pw.get()); toast(t('Saved.')); } catch (e) { showError(e); } }, { kind: 'primary', ic: 'lock' }))));
  }
  async function appearance(reg) {
    const prefs = h('div', { class: 'row' }, h('span', { class: 'lbl' }, t('Theme')), ...['dark', 'light'].map((th) => btn(t(th === 'dark' ? 'Dark' : 'Light'), () => { applyPrefs({ theme: th }); patch('/auth/preferences', { theme: th }).catch(() => {}); }, { ic: th === 'dark' ? 'moon' : 'sun' })), h('span', { class: 'lbl' }, t('Language')), ...[['ar', 'العربية'], ['en', 'English']].map(([l, n]) => btn(n, () => { applyPrefs({ lang: l }); patch('/auth/preferences', { language: l }).catch(() => {}); location.reload(); }, { ic: 'globe' })));
    return h('div', { class: 'stack' }, card(null, prefs), card(t('Appearance'), settingsEditor(reg, Object.keys(reg).filter((k) => ['appearance', 'language'].includes(reg[k].group))).el));
  }
  async function load() {
    clear(box).append(skeletons(2));
    try {
      let view;
      if (tab === 'users') view = await users(); else if (tab === 'profile') view = profile();
      else { const { data: reg } = await get('/settings'); if (tab === 'appearance') view = await appearance(reg); else { const keys = Object.keys(reg).filter((k) => reg[k].group === tab && !['general.setup_complete'].includes(k)); view = card(t(GROUPS.find(([g]) => g === tab)?.[1] ?? tab), settingsEditor(reg, keys, { onSaved: () => { if (tab === 'ai') ctx.go('/ai'); } }).el); if (tab === 'ai') view = h('div', { class: 'stack' }, h('a', { class: 'btn', href: '#/ai' }, t('AI Settings')), view); } }
      clear(box).append(view);
    } catch (e) { clear(box).append(errorBox(e, load)); }
  }
  await load();
}
