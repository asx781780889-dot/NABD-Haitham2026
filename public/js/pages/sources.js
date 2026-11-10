import { h, icon, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get, post, patch, del } from '../lib/api.js';
import { pageHead, btn, iconBtn, table, badge, modal, form, toast, showError, confirmBox, pager, toggle, debounce, errorBox, skeletons, can } from '../lib/ui.js';

const KINDS = ['group', 'supergroup', 'channel', 'private', 'saved'];
const KIND_L = { group: 'Group', supergroup: 'Supergroup', channel: 'Channel', private: 'Private', saved: 'Saved messages' };

export default async function sources(ctx) {
  const op = can('operator'); const st = { page: 1, account_id: '', kind: '', monitored: '', q: '' }; const sel = new Set();
  const [{ data: accs }, { data: radars }] = await Promise.all([get('/accounts'), get('/radar')]);
  const box = h('div'); const bulk = h('div', { class: 'row' });
  const resetSelection = () => { sel.clear(); syncBulk(); };
  const fAcc = h('select', { onChange: () => { st.account_id = fAcc.value; st.page = 1; resetSelection(); load(); } }, h('option', { value: '' }, `${t('Account')}: ${t('All')}`), accs.map((a) => h('option', { value: a.id }, a.name)));
  const fKind = h('select', { onChange: () => { st.kind = fKind.value; st.page = 1; resetSelection(); load(); } }, h('option', { value: '' }, `${t('Type')}: ${t('All')}`), KINDS.map((k) => h('option', { value: k }, t(KIND_L[k]))));
  const fMon = h('select', { onChange: () => { st.monitored = fMon.value; st.page = 1; resetSelection(); load(); } }, h('option', { value: '' }, `${t('Monitoring')}: ${t('All')}`), h('option', { value: 'true' }, t('Enabled')), h('option', { value: 'false' }, t('Disabled')));
  const fQ = h('input', { type: 'search', placeholder: t('Search'), onInput: debounce(() => { st.q = fQ.value; st.page = 1; resetSelection(); load(); }) });
  ctx.root.append(pageHead(t('Sources'), t('New sources from synced accounts are monitored automatically. Pause or resume any source using its toggle.'), op && btn(t('Add source'), addSource, { kind: 'primary', ic: 'plus' })), h('div', { class: 'filters' }, fAcc, fKind, fMon, fQ, op && bulk), box);

  function syncBulk() {
    clear(bulk).append(btn(t('Select all matching'), selectAllMatching, { sm: true }), btn(t('Clear selection'), () => { sel.clear(); syncBulk(); load(); }, { sm: true }));
    if (sel.size) bulk.append(h('span', { class: 'muted sm' }, `${sel.size} ${t('selected')}`), btn(t('Monitor selected'), () => doBulk('enable'), { sm: true, kind: 'primary' }), btn(t('Stop monitoring'), () => doBulk('disable'), { sm: true }), btn(t('Delete selected'), () => doBulk('remove'), { sm: true, kind: 'danger' }));
  }
  syncBulk();
  async function selectAllMatching() {
    try {
      const first = await get('/sources', { ...st, page: 1, limit: 200 }); const ids = first.data.map((s) => s.id);
      for (let page = 2; page <= first.meta.pages; page++) {
        const result = await get('/sources', { ...st, page, limit: 200 }); ids.push(...result.data.map((s) => s.id));
      }
      ids.forEach((id) => sel.add(id)); syncBulk(); load();
    } catch (e) { showError(e); }
  }
  async function doBulk(action) {
    const ids = [...sel];
    if (action === 'remove' && !(await confirmBox(`${t('Delete')} ${ids.length} ${t('selected sources')}?`, { danger: true, ok: t('Delete') }))) return;
    try {
      for (let i = 0; i < ids.length; i += 1000) await post('/sources/bulk', { ids: ids.slice(i, i + 1000), action });
      sel.clear(); syncBulk(); load();
    } catch (e) { showError(e); }
  }
  function addSource() {
    const f = form([{ key: 'account_id', label: t('Account'), type: 'select', options: accs.map((a) => ({ value: a.id, label: a.name })) }, { key: 'tg_chat_id', label: t('Chat ID'), type: 'number', dir: 'ltr', hint: 'e.g. -1001234567890' }, { key: 'kind', label: t('Type'), type: 'select', options: KINDS.map((k) => ({ value: k, label: t(KIND_L[k]) })), value: 'supergroup' }, { key: 'title', label: t('Title') }, { key: 'username', label: 'Username' }]);
    const m = modal({ title: t('Add source'), body: f.el, footer: [btn(t('Cancel'), () => m.close()), btn(t('Add'), async () => { const v = f.get(); try { await post('/sources', { ...v, account_id: Number(v.account_id), title: v.title || undefined, username: v.username || undefined }); m.close(); load(); } catch (e) { showError(e); } }, { kind: 'primary' })] });
  }
  function edit(s) {
    const f = form([
      { key: 'priority_weight', label: `${t('Priority weight')} (−30…+30)`, type: 'range', min: -30, max: 30, value: s.priority_weight },
      { key: 'ai_rule_ids', label: t('Use only these radars'), type: 'checks', options: radars.filter((r) => r.status === 'active').map((r) => ({ value: r.id, label: r.name })), value: s.ai_rule_ids, hint: t('Leave empty to apply all active ones.') },
      { key: 'keyword_ids', label: `${t('Use only these keywords')} (IDs)`, type: 'ids', value: s.keyword_ids, hint: t('Leave empty to apply all active ones.') },
    ], s);
    const m = modal({ title: s.title ?? String(s.tg_chat_id), body: f.el, footer: [btn(t('Cancel'), () => m.close()), btn(t('Save'), async () => { const v = f.get(); try { await patch(`/sources/${s.id}`, { priority_weight: v.priority_weight, ai_rule_ids: v.ai_rule_ids.map(Number), keyword_ids: v.keyword_ids }); m.close(); load(); toast(t('Saved.')); } catch (e) { showError(e); } }, { kind: 'primary' })] });
  }
  async function load() {
    try {
      const { data, meta } = await get('/sources', { ...st, limit: 40 }); clear(box);
      box.append(table({ rows: data, rowKey: (s) => s.id, empty: t('No data'), columns: [
        op && { label: '', render: (s) => h('input', { type: 'checkbox', checked: sel.has(s.id), 'aria-label': 'select', onChange: (e) => { e.target.checked ? sel.add(s.id) : sel.delete(s.id); syncBulk(); } }) },
        { label: t('Monitoring'), render: (s) => toggle(s.monitoring_enabled, async (v) => { try { await patch(`/sources/${s.id}`, { monitoring_enabled: v }); } catch (e) { showError(e); load(); } }) },
        { label: t('Title'), render: (s) => h('div', null, h('div', { class: 'b' }, s.title ?? '—'), h('div', { class: 'xs muted mono' }, [s.username && `@${s.username}`, s.tg_chat_id].filter(Boolean).join(' · '))) },
        { label: t('Type'), render: (s) => badge(t(KIND_L[s.kind]), s.kind === 'channel' ? 'info' : '') }, { label: t('Account'), render: (s) => s.account_name },
        { label: t('Members'), render: (s) => h('span', { class: 'num mono' }, s.members_count ?? '–') }, { label: t('Messages'), render: (s) => h('span', { class: 'num mono' }, fmt.num(s.messages_count)) },
        { label: t('Matches'), render: (s) => h('span', { class: 'num mono' }, fmt.num(s.matches_count)) }, { label: t('Last message'), render: (s) => h('span', { class: 'xs' }, fmt.ago(s.last_message_at)) },
        { label: t('Actions'), act: true, render: (s) => h('div', { class: 'row tight' }, s.link && iconBtn('external', t('Open chat'), () => window.open(s.link, '_blank', 'noopener')), op && iconBtn('sliders', t('Edit'), () => edit(s)), op && iconBtn('clock', t('Scan history'), async () => { try { await post(`/sources/${s.id}/scan`, { limit: 200 }); toast(t('Tasks')); } catch (e) { showError(e); } }), op && iconBtn('trash', t('Delete'), async () => { if (await confirmBox(`${t('Delete')}: ${s.title ?? s.tg_chat_id}?`, { danger: true, ok: t('Delete') })) { try { await del(`/sources/${s.id}`); load(); } catch (e) { showError(e); } } }, 'danger')) },
      ].filter(Boolean) }), pager(meta, (p) => { st.page = p; load(); }));
    } catch (e) { clear(box).append(errorBox(e, load)); }
  }
  box.append(skeletons(3)); await load();
}
