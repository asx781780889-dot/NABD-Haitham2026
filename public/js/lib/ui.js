// Reusable UI building blocks: toast, modal, confirm, forms, tables, pager, tabs, badges, KPI, empty/error states.
import { h, icon, clear, add } from './dom.js';
import { t, fmt } from './i18n.js';
import { state, ApiError } from './api.js';

export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const debounce = (fn, ms = 300) => { let tm; return (...a) => { clearTimeout(tm); tm = setTimeout(() => fn(...a), ms); }; };
export const can = (role) => ({ viewer: 1, operator: 2, admin: 3 }[state.user?.role] >= { viewer: 1, operator: 2, admin: 3 }[role]);

let toastBox;
export function toast(msg, kind = 'info', ms = 4200, extra) {
  toastBox ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const el = h('div', { class: `toast ${kind}` }, h('div', null, msg), extra);
  toastBox.append(el); if (ms) setTimeout(() => el.remove(), ms);
  return el;
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }); ta.value = text; document.body.append(ta); ta.select(); try { document.execCommand('copy'); } catch { /* ignore */ } ta.remove();
  }
  toast(t('Copied'), 'info', 1200);
}
/** Friendly error with Retry / View details / Copy error ID (never a bare "Error 500"). */
export function showError(err, retry) {
  if (err instanceof ApiError && err.code === 'UNAUTHENTICATED') return;
  const id = err.errorId; const acts = h('div', { class: 'row tight' },
    retry && h('button', { class: 'btn sm', onClick: () => { el.remove(); retry(); } }, icon('refresh'), t('Retry')),
    h('button', { class: 'btn sm ghost', onClick: () => errorDetails(err) }, t('View details')),
    id && h('button', { class: 'btn sm ghost', onClick: () => copyText(id) }, icon('copy'), t('Copy error ID')));
  const el = toast(err.message || t('Something went wrong'), 'error', 12000, acts);
}
export function errorDetails(err) {
  const rows = [[t('Status'), err.status || '—'], ['Code', err.code], [t('Error ID'), err.errorId || '—'], [t('Details'), err.detail || (err.details ? JSON.stringify(err.details) : '—')]];
  modal({ title: t('Something went wrong'), body: h('div', { class: 'stack' }, h('p', null, err.message), h('dl', { class: 'kvs' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', { class: 'mono' }, String(v))]))) });
}
export function errorBox(err, retry) {
  return h('div', { class: 'errbox stack tight' }, h('b', null, err.message || t('Something went wrong')), err.errorId && h('span', { class: 'xs muted' }, `${t('Error ID')}: ${err.errorId}`),
    h('div', { class: 'row tight' }, retry && h('button', { class: 'btn sm', onClick: retry }, icon('refresh'), t('Retry')), h('button', { class: 'btn sm ghost', onClick: () => errorDetails(err) }, t('View details')), err.errorId && h('button', { class: 'btn sm ghost', onClick: () => copyText(err.errorId) }, icon('copy'), t('Copy error ID'))));
}
export const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { showError(e); return undefined; } };

export function modal({ title, body, footer, size = '', onClose, dismiss = true } = {}) {
  const bg = h('div', { class: 'modalbg' }); const prev = document.activeElement;
  const close = () => { bg.remove(); document.removeEventListener('keydown', key); onClose?.(); prev?.focus?.(); };
  const key = (e) => { if (e.key === 'Escape' && dismiss && bg === [...document.querySelectorAll('.modalbg')].pop()) close(); };
  const bodyEl = h('div', { class: 'body' }, body); const foot = footer ? h('footer', null, footer) : null;
  const box = h('div', { class: `modal ${size}`, role: 'dialog', 'aria-modal': 'true' }, h('header', null, h('h2', null, title), h('button', { class: 'btn icon ghost sm', 'aria-label': t('Close'), onClick: close }, icon('x'))), bodyEl, foot);
  bg.append(box); bg.addEventListener('mousedown', (e) => { if (e.target === bg && dismiss) close(); });
  document.body.append(bg); document.addEventListener('keydown', key);
  box.querySelector('input,select,textarea,button.primary')?.focus();
  return { close, el: box, body: bodyEl, setFooter: (f) => { if (foot) { clear(foot); add(foot, [f]); } } };
}
export function confirmBox(message, { danger = false, ok = t('Confirm'), title = t('Confirm') } = {}) {
  return new Promise((res) => {
    let done = false; const fin = (v) => { if (!done) { done = true; res(v); } };
    const m = modal({ title, body: h('p', null, message), onClose: () => fin(false), footer: [h('button', { class: 'btn', onClick: () => m.close() }, t('Cancel')), h('button', { class: `btn ${danger ? 'danger solid' : 'primary'}`, onClick: () => { fin(true); m.close(); } }, ok)] });
  });
}
export function askPassword() {
  return new Promise((res) => {
    let done = false; const fin = (v) => { if (!done) { done = true; res(v); } };
    const input = h('input', { type: 'password', autocomplete: 'current-password', placeholder: t('Password') });
    const go = () => { fin(input.value || null); m.close(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    const m = modal({ title: t('Confirm with your password'), body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('This is a sensitive action. Enter your password to continue.')), input), onClose: () => fin(null),
      footer: [h('button', { class: 'btn', onClick: () => m.close() }, t('Cancel')), h('button', { class: 'btn primary', onClick: go }, t('Confirm'))] });
  });
}
state.askPassword = askPassword;

export const badge = (text, kind = '') => h('span', { class: `badge ${kind}` }, text);
export const prioBadge = (p) => badge(t(cap(p)), p);
export const statusDot = (s, label) => h('span', { class: 'row tight', style: { flexWrap: 'nowrap' } }, h('span', { class: `dot ${s}` }), label ?? t(cap(s)));
export function kpi({ label, value, sub, ic, tone = '' }) { return h('div', { class: `card kpi t-${tone}` }, ic && icon(ic), h('span', { class: 'l' }, label), h('span', { class: 'v' }, value ?? '–'), sub && h('span', { class: 'sub' }, sub)); }
export const emptyState = (text, ic = 'search') => h('div', { class: 'empty' }, icon(ic), h('div', null, text));
export const skeletons = (n = 3) => h('div', { class: 'stack' }, Array.from({ length: n }, () => h('div', { class: 'skeleton' })));
export const pageHead = (title, sub, ...actions) => h('div', { class: 'pagehead' }, h('div', { class: 'grow' }, h('h1', null, title), sub && h('p', null, sub)), h('div', { class: 'row' }, actions));
export const card = (title, body, ...actions) => h('section', { class: 'card' }, title && h('div', { class: 'hd' }, h('h3', null, title), actions), body);
export const btn = (label, onClick, { kind = '', ic, sm, title, disabled } = {}) => h('button', { class: `btn ${kind} ${sm ? 'sm' : ''} ${label ? '' : 'icon'}`, onClick, title, 'aria-label': title || label, disabled }, ic && icon(ic), label);
export const iconBtn = (ic, title, onClick, kind = '') => h('button', { class: `btn icon sm ghost ${kind}`, title, 'aria-label': title, onClick }, icon(ic));

export function table({ columns, rows, empty, rowKey }) {
  if (!rows.length) return emptyState(empty ?? t('No data'));
  return h('div', { class: 'tablewrap' }, h('table', null,
    h('thead', null, h('tr', null, columns.map((c) => h('th', { class: c.cls }, c.label)))),
    h('tbody', null, rows.map((r) => h('tr', { 'data-id': rowKey?.(r) }, columns.map((c) => h('td', { class: `${c.cls ?? ''} ${c.act ? 'act' : ''}` }, c.render ? c.render(r) : r[c.key] ?? '–')))))));
}
export function pager(meta, onPage) {
  if (!meta || meta.pages <= 1) return h('div');
  const rtl = document.documentElement.dir === 'rtl';
  return h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '14px' } },
    h('button', { class: 'btn sm', disabled: meta.page <= 1, 'aria-label': 'previous', onClick: () => onPage(meta.page - 1) }, rtl ? '›' : '‹'),
    h('span', { class: 'muted sm num' }, `${meta.page} / ${meta.pages} · ${fmt.num(meta.total)}`),
    h('button', { class: 'btn sm', disabled: meta.page >= meta.pages, 'aria-label': 'next', onClick: () => onPage(meta.page + 1) }, rtl ? '‹' : '›'));
}
export function tabs(items, active, onChange) {
  const el = h('div', { class: 'tabs', role: 'tablist' }); let cur = active ?? items[0].id;
  const draw = () => { clear(el); for (const it of items) el.append(h('button', { class: cur === it.id ? 'on' : '', role: 'tab', 'aria-selected': cur === it.id, onClick: () => { cur = it.id; draw(); onChange(it.id); } }, it.label)); };
  draw(); return el;
}

/* ---- forms ---- */
export function toggle(checked, onChange, label) {
  const input = h('input', { type: 'checkbox', checked: !!checked, onChange: () => onChange?.(input.checked) });
  const sw = h('span', { class: 'switch' }, input, h('i'));
  return label ? h('label', { class: 'row tight', style: { cursor: 'pointer' } }, sw, label) : sw;
}
export function field(label, control, hint) { return h('div', { class: 'field' }, label && h('label', null, label), control, hint && h('span', { class: 'hint' }, hint)); }
/** Declarative form. Field: {key,label,type,options,hint,placeholder,min,max,step,rows,value,show}. Returns {el,get,set,values}. */
export function form(fields, values = {}) {
  const ctl = {}; const wrap = {};
  const read = {
    text: (c) => c.value.trim(), password: (c) => c.value, textarea: (c) => c.value, select: (c) => c.value, range: (c) => Number(c.value),
    number: (c) => (c.value === '' ? undefined : Number(c.value)), toggle: (c) => c.checked,
    lines: (c) => c.value.split('\n').map((s) => s.trim()).filter(Boolean), tags: (c) => c.value.split(/[,،]/).map((s) => s.trim()).filter(Boolean),
    checks: (c) => [...c.querySelectorAll('input:checked')].map((i) => i.value), ids: (c) => c.value.split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n !== 0),
  };
  const el = h('div', { class: 'stack' });
  const update = () => { for (const f of fields) if (f.show) wrap[f.key].classList.toggle('hide', !f.show(get())); };
  for (const f of fields) {
    const v = values[f.key] ?? f.value; let c;
    const common = { id: `f-${f.key}`, placeholder: f.placeholder, onInput: update, onChange: update };
    if (f.type === 'select') c = h('select', common, (f.options ?? []).map((o) => h('option', { value: o.value ?? o, selected: String(o.value ?? o) === String(v ?? '') }, o.label ?? o)));
    else if (f.type === 'textarea') { c = h('textarea', { ...common, rows: f.rows ?? 4 }); c.value = v ?? ''; }
    else if (f.type === 'lines') { c = h('textarea', { ...common, rows: f.rows ?? 6 }); c.value = (v ?? []).join('\n'); }
    else if (f.type === 'tags') { c = h('input', { ...common, type: 'text' }); c.value = (v ?? []).join(', '); }
    else if (f.type === 'ids') { c = h('input', { ...common, type: 'text', inputmode: 'numeric' }); c.value = (v ?? []).join(', '); }
    else if (f.type === 'toggle') c = h('input', { ...common, type: 'checkbox', checked: !!v });
    else if (f.type === 'checks') c = h('div', { class: 'checks', onChange: update }, f.options.map((o) => h('label', null, h('input', { type: 'checkbox', value: o.value ?? o, checked: (v ?? []).map(String).includes(String(o.value ?? o)) }), o.label ?? o)));
    else if (f.type === 'range') c = h('input', { ...common, type: 'range', min: f.min ?? 0, max: f.max ?? 100, step: f.step ?? 1, value: v ?? f.min ?? 0 });
    else { c = h('input', { ...common, type: f.type ?? 'text', min: f.min, max: f.max, step: f.step, autocomplete: f.type === 'password' ? 'new-password' : 'off', dir: f.dir }); if (f.type === 'number') c.value = v ?? ''; else c.value = v ?? ''; }
    ctl[f.key] = c;
    const inner = f.type === 'toggle' ? h('div', { class: 'field inline' }, h('span', { class: 'switch' }, c, h('i')), h('label', { for: c.id }, f.label)) : field(f.label, f.type === 'range' ? h('div', { class: 'row' }, c, h('span', { class: 'mono' }, v ?? f.min ?? 0)) : c, f.hint);
    if (f.type === 'range') c.addEventListener('input', () => { c.nextSibling.textContent = c.value; });
    wrap[f.key] = h('div', null, inner, f.type === 'toggle' && f.hint && h('span', { class: 'hint faint xs' }, f.hint)); el.append(wrap[f.key]);
  }
  function get() { const o = {}; for (const f of fields) o[f.key] = (read[f.type ?? 'text'] ?? read.text)(ctl[f.key]); return o; }
  update();
  return { el, get, ctl, set(k, v) { const c = ctl[k]; if (c.type === 'checkbox') c.checked = v; else c.value = Array.isArray(v) ? v.join(f_join(fields, k)) : v ?? ''; update(); }, setVisible: update };
}
const f_join = (fields, k) => (fields.find((f) => f.key === k)?.type === 'lines' ? '\n' : ', ');

export function exportMenu(path, params = {}) {
  const q = (fmt2) => `/api${path}?${new URLSearchParams({ ...params, format: fmt2, lang: document.documentElement.lang })}`;
  return h('div', { class: 'row tight' }, h('span', { class: 'muted sm' }, icon('download', 15)),
    [['CSV', 'csv'], ['JSON', 'json'], [t('Excel'), 'xlsx'], [t('PDF (print)'), 'pdf']].map(([l, f2]) => h('a', { class: 'btn sm', href: q(f2), target: f2 === 'pdf' ? '_blank' : '_self', rel: 'noopener', download: f2 === 'pdf' ? null : '' }, l)));
}
export function highlight(text, needle) {
  if (!needle || needle.length < 2) return text;
  const i = text.toLowerCase().indexOf(needle.toLowerCase()); if (i < 0) return text;
  return [text.slice(0, i), h('mark', null, text.slice(i, i + needle.length)), text.slice(i + needle.length)];
}
export const levelBadge = (l) => badge(l.toUpperCase(), { critical: 'critical', error: 'bad', warning: 'warn', info: 'info', debug: '' }[l] ?? '');
export const progress = (p) => h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': p }, h('i', { style: { width: `${Math.max(0, Math.min(100, p))}%` } }));
