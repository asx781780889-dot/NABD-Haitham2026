// Visual condition / action builders shared by the Rules engine and Automations (same JSON the backend validates).
import { h, icon, clear } from './dom.js';
import { t } from './i18n.js';
import { form, btn, iconBtn, field } from './ui.js';

const PRI = ['low', 'medium', 'high', 'critical'].map((p) => ({ value: p, label: t(p[0].toUpperCase() + p.slice(1)) }));
const CTX = [['none', 'No context required'], ['before', 'Require text before'], ['after', 'Require text after'], ['both', 'Require both']].map(([value, l]) => ({ value, label: t(l) }));
const CH = ['dashboard', 'browser', 'sound', 'telegram', 'email'];
export const LEAVES = {
  text: { label: 'Message text', fields: [{ key: 'mode', label: t('Match modes'), type: 'select', options: [{ value: 'partial', label: t('Partial') }, { value: 'exact', label: t('Exact') }, { value: 'fuzzy', label: t('Fuzzy') }, { value: 'contains', label: 'Contains' }] }, { key: 'value', label: t('Phrase') }, { key: 'context', label: t('Context'), type: 'select', options: CTX }] },
  intent: { label: 'AI intent', fields: [{ key: 'value', label: t('Intent') }] },
  confidence: { label: 'AI confidence ≥', fields: [{ key: 'gte', label: '%', type: 'number', min: 0, max: 100 }] },
  score: { label: 'Match score ≥', fields: [{ key: 'gte', label: '≥', type: 'number', min: 0, max: 100 }, { key: 'lte', label: '≤', type: 'number', min: 0, max: 100 }] },
  radar: { label: 'Radar', fields: [{ key: 'ids', label: 'IDs', type: 'ids' }] }, keyword: { label: 'Keywords', fields: [{ key: 'ids', label: 'IDs', type: 'ids' }] },
  source: { label: 'Source', fields: [{ key: 'ids', label: 'IDs', type: 'ids' }, { key: 'kinds', label: t('Type'), type: 'checks', options: ['group', 'supergroup', 'channel', 'private'] }] },
  account: { label: 'Account', fields: [{ key: 'ids', label: 'IDs', type: 'ids' }] },
  sender: { label: 'Sender', fields: [{ key: 'ids', label: t('User ID'), type: 'ids' }, { key: 'usernames', label: t('Username'), type: 'tags' }] },
  lang: { label: 'Language', fields: [{ key: 'in', label: t('Language'), type: 'checks', options: ['ar', 'en', 'mixed'] }] },
  priority: { label: 'Priority ≥', fields: [{ key: 'gte', label: t('Priority'), type: 'select', options: PRI }] },
  has_link: { label: 'Has link', fields: [{ key: 'value', label: '', type: 'select', options: [{ value: 'true', label: t('Yes') }, { value: 'false', label: t('No') }] }] },
  length: { label: 'Length', fields: [{ key: 'gte', label: '≥', type: 'number' }, { key: 'lte', label: '≤', type: 'number' }] },
  hour: { label: 'Hour of day', fields: [{ key: 'from', label: t('From'), type: 'number', min: 0, max: 24 }, { key: 'to', label: t('To'), type: 'number', min: 0, max: 24 }] },
  field: { label: 'Event field', fields: [{ key: 'path', label: 'payload.field', dir: 'ltr' }, { key: 'op', label: 'op', type: 'select', options: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'] }, { key: 'value', label: t('Value') }] },
};
const ACTIONS = {
  create_card: { label: 'Create live card', fields: [{ key: 'priority', label: t('Priority'), type: 'select', options: [{ value: '', label: '—' }, ...PRI] }] },
  set_priority: { label: 'Set priority', fields: [{ key: 'value', label: t('Priority'), type: 'select', options: PRI, value: 'high' }] },
  suppress: { label: 'Suppress (no card)', fields: [] },
  notify: { label: 'Send notification', fields: [{ key: 'channels', label: t('Notification channels'), type: 'checks', options: CH }] },
  tag: { label: 'Add tags', fields: [{ key: 'tags', label: t('Tags'), type: 'tags' }] },
  save: { label: 'Save result', fields: [] },
  create_alert: { label: 'Create alert', fields: [{ key: 'title', label: t('Title') }, { key: 'body', label: t('Message') }, { key: 'severity', label: t('Level'), type: 'select', options: ['info', 'low', 'medium', 'high', 'critical'] }] },
  block_user: { label: 'Block user', fields: [] }, pause_source: { label: 'Pause source', fields: [] },
};
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length) && !Number.isNaN(v)));

function typedRow(defs, initial, onRemove, { negate }) {
  const types = Object.keys(defs); const cur = { type: initial.type ?? types[0] }; const holder = h('div', { class: 'grow' }); let f = null;
  const sel = h('select', { style: { width: 'auto' }, onChange: () => { cur.type = sel.value; draw({}); } }, types.map((k) => h('option', { value: k, selected: k === cur.type }, t(defs[k].label))));
  const neg = negate ? h('label', { class: 'row tight xs' }, h('input', { type: 'checkbox', checked: !!initial.negate }), t('NOT')) : null;
  function draw(vals) {
    const fields = defs[cur.type].fields.map((x) => (x.key === 'value' && cur.type === 'has_link' ? { ...x, value: String(vals.value ?? true) } : x));
    f = form(fields, vals); clear(holder).append(f.el); f.el.classList.add('row'); f.el.style.alignItems = 'flex-end';
  }
  draw(initial);
  const el = h('div', { class: 'row card', style: { padding: '10px', alignItems: 'flex-start', flexWrap: 'nowrap' } }, h('div', { class: 'stack tight' }, sel, neg), holder, iconBtn('x', t('Delete'), onRemove, 'danger'));
  return { el, get() { const v = clean(f.get()); if (cur.type === 'has_link') v.value = v.value !== 'false'; if (v.value !== undefined && cur.type === 'field' && !Number.isNaN(Number(v.value)) && v.value !== '') v.value = Number(v.value); const out = { type: cur.type, ...v }; if (neg?.querySelector('input').checked) out.negate = true; return out; } };
}

const isLeaf = (n) => n && typeof n.type === 'string';
function flatten(n) {
  if (!n || (typeof n === 'object' && !Object.keys(n).length)) return { mode: 'all', leaves: [] };
  if (isLeaf(n)) return { mode: 'all', leaves: [n] };
  for (const m of ['all', 'any']) if (Array.isArray(n[m]) && n[m].every(isLeaf)) return { mode: m, leaves: n[m] };
  return null;
}
export function conditionBuilder(initial = {}, { types } = {}) {
  const defs = types ? Object.fromEntries(types.map((k) => [k, LEAVES[k]])) : LEAVES; const flat = flatten(initial);
  let advanced = !flat; let mode = flat?.mode ?? 'all'; const rows = []; const list = h('div', { class: 'stack tight' });
  const json = h('textarea', { rows: 8, class: 'mono', dir: 'ltr' }); json.value = JSON.stringify(initial, null, 2);
  const modeSel = h('select', { style: { width: 'auto' }, onChange: () => { mode = modeSel.value; } }, h('option', { value: 'all', selected: mode === 'all' }, t('Match ALL conditions')), h('option', { value: 'any', selected: mode === 'any' }, t('Match ANY condition')));
  const addRow = (leaf = {}) => { const r = typedRow(defs, leaf, () => { rows.splice(rows.indexOf(r), 1); r.el.remove(); }, { negate: true }); rows.push(r); list.append(r.el); };
  (flat?.leaves ?? []).forEach(addRow);
  const simple = h('div', { class: 'stack tight' }, modeSel, list, btn(t('Add condition'), () => addRow(), { sm: true, ic: 'plus' }));
  const adv = h('div', { class: 'stack tight' }, json);
  const toggleAdv = h('label', { class: 'row tight xs' }, h('input', { type: 'checkbox', checked: advanced, onChange: (e) => { advanced = e.target.checked; paint(); } }), t('Advanced (JSON)'));
  const el = h('div', { class: 'stack tight' }, toggleAdv, simple, adv);
  function paint() { simple.classList.toggle('hide', advanced); adv.classList.toggle('hide', !advanced); }
  paint();
  return { el, get() { if (advanced) return JSON.parse(json.value || '{}'); const leaves = rows.map((r) => r.get()); return leaves.length === 0 ? {} : leaves.length === 1 && mode === 'all' ? leaves[0] : { [mode]: leaves }; } };
}
export function actionBuilder(initial = [], { types } = {}) {
  const defs = types ? Object.fromEntries(types.map((k) => [k, ACTIONS[k]])) : ACTIONS; const rows = []; const list = h('div', { class: 'stack tight' });
  const addRow = (a = {}) => { const r = typedRow(defs, a, () => { rows.splice(rows.indexOf(r), 1); r.el.remove(); }, { negate: false }); rows.push(r); list.append(r.el); };
  (initial.length ? initial : [{}]).forEach(addRow);
  return { el: h('div', { class: 'stack tight' }, list, btn(t('Add action'), () => addRow(), { sm: true, ic: 'plus' })), get: () => rows.map((r) => r.get()) };
}
export const describe = (node) => { try { return JSON.stringify(node).length > 90 ? `${JSON.stringify(node).slice(0, 90)}…` : JSON.stringify(node); } catch { return ''; } };
