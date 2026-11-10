import { h, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get, post, patch, del } from '../lib/api.js';
import { pageHead, btn, iconBtn, table, modal, form, toast, showError, confirmBox, toggle, badge, pager, debounce, errorBox, skeletons, can, card } from '../lib/ui.js';

const CTX = () => [['none', 'No context required'], ['before', 'Require text before'], ['after', 'Require text after'], ['both', 'Require both']].map(([value, l]) => ({ value, label: t(l) }));
const MODES = () => [['exact', 'Exact'], ['partial', 'Partial'], ['fuzzy', 'Fuzzy'], ['semantic', 'Semantic']].map(([value, l]) => ({ value, label: t(l) }));

function editor(k, radars, done) {
  const f = form([
    { key: 'phrase', label: t('Phrase') }, { key: 'match_modes', label: t('Match modes'), type: 'checks', options: MODES(), value: ['exact', 'partial', 'fuzzy'] },
    { key: 'fuzzy_threshold', label: t('Fuzzy threshold %'), type: 'range', min: 50, max: 100, value: 82 }, { key: 'context_mode', label: t('Context'), type: 'select', options: CTX() }, { key: 'context_strict', label: t('Strict context'), type: 'toggle' },
    { key: 'min_score', label: t('Min score'), type: 'range', min: 0, max: 100, value: 60 }, { key: 'weight', label: t('Weight'), type: 'range', min: 1, max: 100, value: 100 },
    { key: 'ai_rule_id', label: t('Radar'), type: 'select', options: [{ value: '', label: t('Standalone') }, ...radars.map((r) => ({ value: r.id, label: r.name }))], value: k?.ai_rule_id ?? '' },
    { key: 'is_sensitive', label: t('Sensitive'), type: 'toggle' }, { key: 'enabled', label: t('Enabled'), type: 'toggle', value: true }, { key: 'notes', label: t('Notes') },
    ...(k ? [] : [{ key: 'variants', label: t('Variants / synonyms'), type: 'lines', rows: 4 }]),
  ], k ?? {});
  const vbox = h('div', { class: 'stack tight' });
  const drawVariants = () => { clear(vbox).append(h('h3', null, t('Variants / synonyms')), h('div', { class: 'row tight' }, (k.variants ?? []).map((v) => h('span', { class: 'chip' }, v.phrase, h('button', { class: 'btn icon sm ghost', style: { width: '20px', height: '20px', padding: 0 }, onClick: async () => { await del(`/keywords/variants/${v.id}`); k.variants = k.variants.filter((x) => x.id !== v.id); drawVariants(); } }, '×')))));
    const inp = h('input', { placeholder: t('Add') }); vbox.append(h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, inp, btn(t('Add'), async () => { if (!inp.value.trim()) return; try { await post(`/keywords/${k.id}/variants`, { phrase: inp.value.trim(), kind: 'synonym' }); const r = (await get('/keywords', { q: k.phrase, limit: 5 })).data.find((x) => x.id === k.id); k.variants = r?.variants ?? k.variants; drawVariants(); } catch (e) { showError(e); } }, { sm: true }))); };
  if (k) drawVariants();
  const m = modal({ title: k ? t('Edit') : t('Add keyword'), size: 'lg', body: h('div', { class: 'stack' }, f.el, k && vbox), footer: [btn(t('Cancel'), () => m.close()), btn(t('Save'), async () => {
    const v = f.get(); const body = { ...v, ai_rule_id: v.ai_rule_id ? Number(v.ai_rule_id) : null, notes: v.notes || null };
    try { if (k) { delete body.variants; await patch(`/keywords/${k.id}`, body); } else await post('/keywords', { ...body, variants: (v.variants ?? []).map((p) => ({ phrase: p, kind: 'synonym' })) }); m.close(); toast(t('Saved.')); done(); } catch (e) { showError(e); }
  }, { kind: 'primary' })] });
}

export default async function keywords(ctx) {
  const op = can('operator'); const st = { page: 1, q: '' }; const box = h('div'); const { data: radars } = await get('/radar');
  const q = h('input', { type: 'search', placeholder: t('Search'), onInput: debounce(() => { st.q = q.value; st.page = 1; load(); }) });
  const ta = h('textarea', { rows: 2, placeholder: t('Type a message to see which keywords match') }); const out = h('div');
  const test = btn(t('Run test'), async () => { try { const r = (await post('/keywords/test', { text: ta.value })).data; clear(out).append(h('div', { class: 'muted xs' }, `${t('Normalized')}: ${r.normalized}`), r.hits.length ? h('div', { class: 'list' }, r.hits.map((x) => h('div', null, badge(`${x.score}%`, x.score >= 80 ? 'ok' : 'warn'), h('b', null, x.phrase || x.matchedForm), badge(t(x.type[0].toUpperCase() + x.type.slice(1)), 'info'), !x.contextOk && badge(t('No context required').replace(/.*/, '⚠ context'), 'warn')))) : h('div', { class: 'callout warn' }, t('No match'))); } catch (e) { showError(e); } }, { ic: 'play' });
  ctx.root.append(pageHead(t('Keywords'), 'Exact · Partial · Fuzzy · Synonyms · Context', op && btn(t('Add keyword'), () => editor(null, radars, load), { kind: 'primary', ic: 'plus' })), card(t('Test keywords'), h('div', { class: 'stack' }, ta, h('div', null, test), out)), h('div', { style: { height: '14px' } }), h('div', { class: 'filters' }, q), box);
  async function load() {
    try {
      const { data, meta } = await get('/keywords', { ...st, limit: 30 }); clear(box);
      box.append(table({ rows: data, empty: t('No data'), rowKey: (k) => k.id, columns: [
        { label: t('Phrase'), render: (k) => h('div', null, h('div', { class: 'b' }, k.phrase, k.is_sensitive && ' ⚠'), h('div', { class: 'xs muted' }, (k.variants ?? []).slice(0, 3).map((v) => v.phrase).join(' · '))) },
        { label: t('Match modes'), render: (k) => h('div', { class: 'row tight' }, k.match_modes.map((m) => h('span', { class: 'chip' }, t(m[0].toUpperCase() + m.slice(1))))) },
        { label: t('Context'), render: (k) => h('span', { class: 'xs' }, CTX().find((c) => c.value === k.context_mode)?.label) }, { label: t('Min score'), render: (k) => h('span', { class: 'mono num' }, k.min_score) },
        { label: t('Radar'), render: (k) => k.rule_name ?? t('Standalone') }, { label: t('Hits'), render: (k) => h('span', { class: 'mono num' }, fmt.num(k.hits)) },
        { label: t('Enabled'), render: (k) => toggle(k.enabled, async (v) => { try { await patch(`/keywords/${k.id}`, { enabled: v }); } catch (e) { showError(e); load(); } }) },
        { label: '', act: true, render: (k) => op && h('div', { class: 'row tight' }, iconBtn('edit', t('Edit'), () => editor(k, radars, load)), iconBtn('trash', t('Delete'), async () => { if (await confirmBox(`${t('Delete')}: ${k.phrase}?`, { danger: true, ok: t('Delete') })) { try { await del(`/keywords/${k.id}`); load(); } catch (e) { showError(e); } } }, 'danger')) },
      ] }), pager(meta, (p) => { st.page = p; load(); }));
    } catch (e) { clear(box).append(errorBox(e, load)); }
  }
  box.append(skeletons(2)); await load();
}
