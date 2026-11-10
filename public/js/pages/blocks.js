import { h, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get, post, del } from '../lib/api.js';
import { pageHead, btn, iconBtn, table, form, card, tabs, showError, toast, errorBox, skeletons, can, badge, kpi } from '../lib/ui.js';

export default async function blocks(ctx) {
  const op = can('operator'); let tab = 'users'; const box = h('div');
  const specs = {
    users: { title: t('Blocked users'), fields: [{ key: 'tg_user_id', label: t('Telegram user ID'), type: 'number', dir: 'ltr' }, { key: 'username', label: t('Username') }, { key: 'reason', label: t('Reason') }], path: '/blocks/users', cols: (r) => [{ label: t('User ID'), render: () => h('span', { class: 'mono' }, r.tg_user_id) }] },
    sources: { title: t('Blocked groups & channels'), fields: [{ key: 'tg_chat_id', label: t('Chat ID'), type: 'number', dir: 'ltr' }, { key: 'kind', label: t('Type'), type: 'select', options: ['group', 'supergroup', 'channel'] }, { key: 'title', label: t('Title') }, { key: 'reason', label: t('Reason') }], path: '/blocks/sources' },
    keywords: { title: t('Blocked keywords'), fields: [{ key: 'phrase', label: t('Phrase') }, { key: 'reason', label: t('Reason') }], path: '/blocks/keywords', hint: t('Messages containing a blocked keyword are never shown.') },
  };
  const tabBar = tabs([{ id: 'users', label: t('Blocked users') }, { id: 'sources', label: t('Blocked groups & channels') }, { id: 'keywords', label: t('Blocked keywords') }], tab, (id) => { tab = id; load(); });
  ctx.root.append(pageHead(t('Blocks'), 'Applied in the backend before anything reaches the browser.'), tabBar, box);
  async function load() {
    clear(box).append(skeletons(1)); const spec = specs[tab];
    try {
      const all = await get('/blocks'); const rows = all[tab]; clear(box);
      if (tab === 'users') box.append(kpi({ label: t('Total blocked users'), value: fmt.num(all.counts?.users ?? rows.length), ic: 'ban', tone: 'bad' }), h('div', { style: { height: '14px' } }));
      const f = form(spec.fields.map((x) => ({ ...x, type: x.type === 'select' ? 'select' : x.type })));
      if (op) box.append(card(t('Add'), h('div', { class: 'stack' }, spec.hint && h('div', { class: 'muted sm' }, spec.hint), f.el, h('div', null, btn(t('Block'), async () => { const v = f.get(); try { await post(spec.path, Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x !== undefined))); toast(t('Saved.')); load(); } catch (e) { showError(e); } }, { kind: 'danger', ic: 'ban' })))), h('div', { style: { height: '14px' } }));
      const idCol = tab === 'users' ? { label: t('User'), render: (r) => h('div', null, h('span', { class: 'mono' }, r.tg_user_id), r.username && h('div', { class: 'xs muted' }, `@${r.username}`)) } : tab === 'sources' ? { label: t('Title'), render: (r) => h('div', null, r.title ?? '—', h('div', { class: 'xs muted mono' }, r.tg_chat_id)) } : { label: t('Phrase'), render: (r) => r.phrase };
      box.append(table({ rows, empty: t('No data'), columns: [idCol, { label: t('Reason'), render: (r) => r.reason ?? '–' }, { label: t('Date'), render: (r) => h('span', { class: 'xs num' }, fmt.dt(r.created_at)) }, { label: '', act: true, render: (r) => op && btn(t('Unblock'), async () => { try { await del(`${spec.path}/${r.id}`); load(); } catch (e) { showError(e); } }, { sm: true }) }] }));
    } catch (e) { clear(box).append(errorBox(e, load)); }
  }
  await load();
}
