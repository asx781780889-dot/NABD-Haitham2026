import { h, icon, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get, post, patch, del } from '../lib/api.js';
import { pageHead, btn, iconBtn, table, modal, form, toast, showError, confirmBox, toggle, errorBox, skeletons, can, card } from '../lib/ui.js';
import { conditionBuilder, actionBuilder, describe } from '../lib/builder.js';

const DECISION = ['create_card', 'set_priority', 'suppress', 'notify', 'tag', 'save'];
const MSG_LEAVES = ['text', 'intent', 'confidence', 'score', 'radar', 'keyword', 'source', 'account', 'sender', 'lang', 'priority', 'has_link', 'length', 'hour'];

export function openRuleEditor(rule, done) {
  const meta = form([{ key: 'name', label: t('Name') }, { key: 'description', label: t('Description') }, { key: 'sort_order', label: t('Order'), type: 'number', value: 100 }, { key: 'stop_on_match', label: t('Stop after this rule'), type: 'toggle' }, { key: 'enabled', label: t('Enabled'), type: 'toggle', value: true }], rule ?? {});
  const cb = conditionBuilder(rule?.conditions ?? {}, { types: MSG_LEAVES }); const ab = actionBuilder(rule?.actions ?? [{ type: 'create_card' }], { types: DECISION });
  const sample = h('input', { placeholder: t('Sample message') }); const out = h('div');
  const build = () => ({ ...meta.get(), description: meta.get().description || null, conditions: cb.get(), actions: ab.get() });
  const body = h('div', { class: 'stack' }, meta.el, h('h3', null, t('Conditions')), cb.el, h('h3', null, t('Actions')), ab.el, h('h3', null, t('Test rule')), h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, sample, btn(t('Run test'), async () => {
    try { const b = build(); const r = (await post('/rules/test', { text: sample.value, conditions: b.conditions, actions: b.actions })).data; clear(out).append(h('div', { class: `callout ${r.matched ? '' : 'warn'}` }, r.matched ? `✔ ${t('Match')}${r.score != null ? ` ${r.score}%` : ''}` : `✘ ${t('No match')}`, h('div', { class: 'pre', style: { marginTop: '6px' } }, JSON.stringify(r.decision, null, 1)))); } catch (e) { showError(e); }
  }, { ic: 'play' })), out);
  const m = modal({ title: rule ? t('Edit') : t('New rule'), size: 'lg', body, footer: [btn(t('Cancel'), () => m.close()), btn(t('Save'), async () => {
    try { const b = build(); rule ? await patch(`/rules/${rule.id}`, b) : await post('/rules', b); m.close(); toast(t('Saved.')); done?.(); } catch (e) { showError(e); }
  }, { kind: 'primary' })] });
}

export default async function rules(ctx) {
  const box = h('div'); const op = can('operator');
  ctx.root.append(pageHead(t('Rules'), 'IF conditions → THEN actions', op && btn(t('New rule'), () => openRuleEditor(null, load), { kind: 'primary', ic: 'plus' })), box);
  async function load() {
    try {
      const { data } = await get('/rules'); clear(box);
      box.append(table({ rows: data, empty: t('No data'), rowKey: (r) => r.id, columns: [
        { label: t('Order'), render: (r) => h('span', { class: 'mono num' }, r.sort_order) },
        { label: t('Name'), render: (r) => h('div', null, h('div', { class: 'b' }, r.name), h('div', { class: 'xs muted mono clip', style: { maxWidth: '420px' }, title: JSON.stringify(r.conditions) }, describe(r.conditions))) },
        { label: t('Actions'), render: (r) => h('div', { class: 'row tight' }, r.actions.map((a) => h('span', { class: 'chip' }, a.type))) },
        { label: t('Enabled'), render: (r) => toggle(r.enabled, async (v) => { try { await patch(`/rules/${r.id}`, { enabled: v }); } catch (e) { showError(e); load(); } }) },
        { label: t('Hits'), render: (r) => h('span', { class: 'mono num' }, fmt.num(r.hits)) }, { label: t('Last run'), render: (r) => h('span', { class: 'xs' }, fmt.ago(r.last_hit_at)) },
        { label: '', act: true, render: (r) => op && h('div', { class: 'row tight' }, iconBtn('edit', t('Edit'), () => openRuleEditor(r, load)), iconBtn('trash', t('Delete'), async () => { if (await confirmBox(`${t('Delete')}: ${r.name}?`, { danger: true, ok: t('Delete') })) { try { await del(`/rules/${r.id}`); load(); } catch (e) { showError(e); } } }, 'danger')) },
      ] }));
    } catch (e) { clear(box).append(errorBox(e, load)); }
  }
  box.append(skeletons(2)); await load();
}
