import { h, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get, post, patch, del } from '../lib/api.js';
import { pageHead, btn, iconBtn, table, modal, form, toast, showError, confirmBox, toggle, errorBox, skeletons, can, badge } from '../lib/ui.js';
import { conditionBuilder, actionBuilder, describe } from '../lib/builder.js';

const TRIG = { new_message: 'New message', new_match: 'New match', high_priority_match: 'High-priority match', account_connected: 'Account connected', account_disconnected: 'Account disconnected', ai_failure: 'AI failure', worker_down: 'Worker down', job_failed: 'Job failed', db_threshold: 'Database threshold' };

function editor(a, done) {
  const meta = form([{ key: 'name', label: t('Name') }, { key: 'description', label: t('Description') }, { key: 'trigger', label: t('Trigger'), type: 'select', options: Object.entries(TRIG).map(([value, l]) => ({ value, label: t(l) })) }, { key: 'enabled', label: t('Enabled'), type: 'toggle', value: true }], a ?? {});
  const cb = conditionBuilder(a?.conditions ?? {}); const ab = actionBuilder(a?.actions ?? [{ type: 'create_alert' }]);
  const m = modal({ title: a ? t('Edit') : t('New automation'), size: 'lg', body: h('div', { class: 'stack' }, meta.el, h('div', { class: 'callout' }, 'Trigger → Conditions → Actions'), h('h3', null, t('Conditions')), cb.el, h('h3', null, t('Actions')), ab.el, h('p', { class: 'xs muted mono', dir: 'ltr' }, t('Template variables: {{payload.field}}'))),
    footer: [btn(t('Cancel'), () => m.close()), btn(t('Save'), async () => { try { const v = meta.get(); const b = { ...v, description: v.description || null, conditions: cb.get(), actions: ab.get() }; a ? await patch(`/automations/${a.id}`, b) : await post('/automations', b); m.close(); toast(t('Saved.')); done?.(); } catch (e) { showError(e); } }, { kind: 'primary' })] });
}
export default async function automations(ctx) {
  const box = h('div'); const op = can('operator');
  ctx.root.append(pageHead(t('Automation'), 'Trigger → Conditions → Actions', op && btn(t('New automation'), () => editor(null, load), { kind: 'primary', ic: 'plus' })), box);
  async function runs(a) { const { data } = await get(`/automations/${a.id}/runs`); modal({ title: `${a.name} — ${t('Runs')}`, size: 'lg', body: table({ rows: data, empty: t('No data'), columns: [{ label: t('Started'), render: (r) => fmt.dt(r.started_at) }, { label: t('Status'), render: (r) => badge(r.status, r.status === 'success' ? 'ok' : r.status === 'failed' ? 'bad' : '') }, { label: 'Ref', render: (r) => h('span', { class: 'mono xs' }, r.dedupe_key) }, { label: t('Result'), render: (r) => h('span', { class: 'xs' }, r.error ?? (r.result ?? []).join(', ')) }] }) }); }
  async function load() {
    try {
      const { data } = await get('/automations'); clear(box);
      box.append(table({ rows: data, empty: t('No data'), columns: [
        { label: t('Name'), render: (a) => h('div', null, h('div', { class: 'b' }, a.name), h('div', { class: 'xs muted' }, a.description ?? '')) }, { label: t('Trigger'), render: (a) => badge(t(TRIG[a.trigger] ?? a.trigger), 'info') },
        { label: t('Conditions'), render: (a) => h('span', { class: 'xs mono muted' }, describe(a.conditions)) }, { label: t('Actions'), render: (a) => h('div', { class: 'row tight' }, a.actions.map((x) => h('span', { class: 'chip' }, x.type))) },
        { label: t('Enabled'), render: (a) => toggle(a.enabled, async (v) => { try { await patch(`/automations/${a.id}`, { enabled: v }); } catch (e) { showError(e); load(); } }) },
        { label: t('Runs'), render: (a) => h('span', { class: 'mono num' }, fmt.num(a.run_count)) }, { label: t('Last run'), render: (a) => h('span', { class: 'xs' }, fmt.ago(a.last_run_at)) },
        { label: '', act: true, render: (a) => h('div', { class: 'row tight' }, iconBtn('list', t('Runs'), () => runs(a)), op && iconBtn('edit', t('Edit'), () => editor(a, load)), op && iconBtn('trash', t('Delete'), async () => { if (await confirmBox(`${t('Delete')}: ${a.name}?`, { danger: true, ok: t('Delete') })) { try { await del(`/automations/${a.id}`); load(); } catch (e) { showError(e); } } }, 'danger')) },
      ] }));
    } catch (e) { clear(box).append(errorBox(e, load)); }
  }
  box.append(skeletons(2)); await load();
}
