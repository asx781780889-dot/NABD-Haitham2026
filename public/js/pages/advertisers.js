import { h, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get, patch } from '../lib/api.js';
import { pageHead, btn, badge, errorBox, emptyState, showError } from '../lib/ui.js';
export default async function advertisers(ctx) {
  const list = h('div', { class: 'stack' });
  async function load() {
    try {
      const { data } = await get('/advertisers', { limit: 100 }); clear(list);
      if (!data.length) return list.append(emptyState(t('No advertisers yet.'), 'users'));
      for (const p of data) {
        const select = h('select', { onChange: async () => { try { await patch(`/advertisers/${p.tg_user_id}`, { status: select.value }); } catch (e) { showError(e); } } },
          ['unknown', 'suspect', 'advertiser', 'trusted'].map((x) => h('option', { value: x, selected: x === p.status }, t(x))));
        list.append(h('article', { class: 'card row', style: { justifyContent: 'space-between' } },
          h('div', { class: 'stack tight' }, h('b', null, p.username ? `@${p.username}` : String(p.tg_user_id)), h('span', { class: 'faint' }, `${t('Ad score')}: ${Math.round(p.ad_score)}% · ${t('Ad messages')}: ${p.ad_messages} · ${t('Groups')}: ${p.groups_count}`)),
          h('div', { class: 'row tight' }, badge(t(p.status), p.status === 'advertiser' ? 'danger' : p.status === 'suspect' ? 'warn' : 'info'), select)));
      }
    } catch (e) { clear(list).append(errorBox(e, load)); }
  }
  ctx.root.append(pageHead(t('Advertisers'), null, btn(t('Refresh'), load)), list); await load();
}
