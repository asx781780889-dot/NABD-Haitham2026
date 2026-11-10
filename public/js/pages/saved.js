import { h, icon, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get, patch, del } from '../lib/api.js';
import { pageHead, btn, iconBtn, modal, form, toast, showError, confirmBox, pager, debounce, exportMenu, emptyState, errorBox, skeletons, prioBadge, badge, copyText, can } from '../lib/ui.js';

export default async function saved(ctx) {
  const st = { page: 1, q: '', tag: '', priority: '' }; const box = h('div', { class: 'cards' }); const pg = h('div'); const exp = h('div'); const op = can('operator');
  const q = h('input', { type: 'search', placeholder: t('Search'), onInput: debounce(() => { st.q = q.value; st.page = 1; load(); }) }); const tag = h('input', { placeholder: t('Tags'), onInput: debounce(() => { st.tag = tag.value; st.page = 1; load(); }), style: { width: '140px' } });
  const pr = h('select', { onChange: () => { st.priority = pr.value; st.page = 1; load(); } }, h('option', { value: '' }, `${t('Priority')}: ${t('All')}`), ['low', 'medium', 'high', 'critical'].map((p) => h('option', { value: p }, t(p[0].toUpperCase() + p.slice(1)))));
  ctx.root.append(pageHead(t('Saved results'), null, exp), h('div', { class: 'filters' }, q, tag, pr), box, pg);
  const edit = (s) => { const f = form([{ key: 'notes', label: t('Notes'), type: 'textarea' }, { key: 'tags', label: t('Tags (comma separated)'), type: 'tags' }], s); const m = modal({ title: t('Edit notes'), body: f.el, footer: [btn(t('Cancel'), () => m.close()), btn(t('Save'), async () => { try { await patch(`/saved/${s.id}`, f.get()); m.close(); load(); } catch (e) { showError(e); } }, { kind: 'primary' })] }); };
  async function load() {
    try {
      const r = await get('/saved', { ...st, limit: 20 }); clear(box); clear(pg); clear(exp).append(exportMenu('/export/saved', Object.fromEntries(Object.entries({ q: st.q, tag: st.tag, priority: st.priority }).filter(([, v]) => v))));
      if (!r.data.length) box.append(emptyState(t('No results yet.'), 'bookmark'));
      for (const s of r.data) box.append(h('article', { class: `mc p-${s.priority ?? 'low'}` }, h('div', { class: 'ring', style: { '--p': s.score ?? 0, '--ringc': 'var(--accent)' } }, h('b', null, `${Math.round(s.score ?? 0)}%`)),
        h('div', { class: 'meta' }, s.priority && prioBadge(s.priority), s.intent && badge(s.intent, 'ok'), s.rule_name && h('span', { class: 'chip' }, s.rule_name), h('span', { class: 'end xs num' }, `${t('Saved')}: ${fmt.dt(s.created_at)}`)),
        h('div', { class: 'meta' }, h('b', { style: { color: 'var(--text)' } }, s.sender_username ? `@${s.sender_username}` : '–'), s.sender_id && h('span', { class: 'mono xs' }, `ID ${s.sender_id}`), h('span', null, '·'), h('span', null, s.source_title ?? '–'), h('span', { class: 'xs num' }, fmt.dt(s.message_at))),
        h('div', { class: 'txt full' }, s.message_text), s.notes && h('div', { class: 'why full' }, h('b', null, `${t('Notes')}: `), s.notes), h('div', { class: 'meta full' }, s.tags.map((x) => h('span', { class: 'chip' }, `#${x}`))),
        h('div', { class: 'acts full' }, iconBtn('copy', t('Copy message'), () => copyText(s.message_text)), s.message_link && iconBtn('link', t('Open message'), () => window.open(s.message_link, '_blank', 'noopener')), op && iconBtn('edit', t('Edit notes'), () => edit(s)),
          op && iconBtn('trash', t('Delete'), async () => { if (await confirmBox(`${t('Delete')}?`, { danger: true, ok: t('Delete') })) { try { await del(`/saved/${s.id}`); load(); } catch (e) { showError(e); } } }, 'danger'))));
      pg.append(pager(r.meta, (p) => { st.page = p; load(); }));
    } catch (e) { clear(box).append(errorBox(e, load)); }
  }
  box.append(skeletons(2)); await load();
}
