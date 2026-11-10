import { h, icon, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get, post, patch, del } from '../lib/api.js';
import { pageHead, btn, iconBtn, modal, form, toast, showError, confirmBox, badge, errorBox, skeletons, can, card, emptyState, prioBadge } from '../lib/ui.js';

const PRI = [{ value: '', label: '—' }, ...['low', 'medium', 'high', 'critical'].map((p) => ({ value: p, label: t(p[0].toUpperCase() + p.slice(1)) }))];
const radarFields = () => [
  { key: 'name', label: t('Name') }, { key: 'intent', label: t('Intent') }, { key: 'intent_description', label: t('Description'), type: 'textarea', rows: 2 },
  { key: 'signals', label: t('Signals (one per line)'), type: 'lines', rows: 9 }, { key: 'negative_signals', label: t('Negative signals (one per line)'), type: 'lines', rows: 3 },
  { key: 'min_score', label: `${t('Minimum match %')}`, type: 'range', min: 30, max: 100, value: 70 },
  { key: 'ai_mode', label: t('AI confirmation'), type: 'select', options: [{ value: 'uncertain', label: t('Only when uncertain') }, { value: 'always', label: t('Always') }, { value: 'off', label: t('Off') }] },
  { key: 'context_mode', label: t('Context'), type: 'select', options: [{ value: 'none', label: t('No context required') }, { value: 'before', label: t('Require text before') }, { value: 'after', label: t('Require text after') }, { value: 'both', label: t('Require both') }] },
  { key: 'priority_hint', label: t('Priority hint'), type: 'select', options: PRI },
];
const payload = (v, extra = {}) => ({ name: v.name, intent: v.intent, intent_description: v.intent_description || null, signals: v.signals, negative_signals: v.negative_signals, min_score: v.min_score, ai_mode: v.ai_mode, context_mode: v.context_mode, priority_hint: v.priority_hint || null, ...extra });

/** Natural-language -> draft -> operator review -> explicit confirmation. Also used by the onboarding wizard. */
export function openRadarBuilder(done, existing) {
  const body = h('div', { class: 'stack' }); let desc = existing?.description ?? '';
  const m = modal({ title: existing ? t('Edit') : t('New radar'), size: 'lg', body, footer: [] });
  const review = (draft, note) => {
    const f = form(radarFields(), draft); clear(body).append(note && h('div', { class: 'callout warn' }, note), !existing && h('div', { class: 'callout' }, t('Review the generated rule. It stays a draft until you confirm it.')), f.el);
    const save = (confirm) => async () => { const v = f.get(); try { existing ? await patch(`/radar/${existing.id}`, payload(v)) : await post('/radar', { ...payload(v, { description: desc }), confirm }); toast(t('Saved.')); m.close(); done?.(); } catch (e) { showError(e); } };
    m.setFooter(existing ? [btn(t('Cancel'), () => m.close()), btn(t('Save'), save(false), { kind: 'primary' })] : [btn(t('Cancel'), () => m.close()), btn(t('Save as draft'), save(false)), btn(t('Confirm & activate'), save(true), { kind: 'primary', ic: 'check' })]);
  };
  if (existing) return review(existing);
  const ta = h('textarea', { rows: 4, placeholder: 'أريد الأشخاص الذين يكتبون أنهم يحتاجون مساعدة في مشاريع التخرج' });
  clear(body).append(h('label', { class: 'lbl' }, t('Describe what you are looking for')), ta);
  const gen = btn(t('Generate'), async () => { if (ta.value.trim().length < 5) return; desc = ta.value.trim(); gen.disabled = true; gen.textContent = t('Loading…'); try { const r = (await post('/radar/draft', { description: desc })).data; review(r, r.source === 'heuristic' ? t('AI needs to be configured for better results; a basic draft was generated locally.') : null); } catch (e) { showError(e); gen.disabled = false; gen.textContent = t('Generate'); } }, { kind: 'primary', ic: 'spark' });
  m.setFooter([btn(t('Cancel'), () => m.close()), gen]);
}

function testModal(r) {
  const ta = h('textarea', { rows: 3, placeholder: t('Sample message') }); let ai = false; const out = h('div', { class: 'stack' });
  const run = btn(t('Run test'), async () => {
    try { const d = (await post(`/radar/${r.id}/test`, { text: ta.value, use_ai: ai })).data; clear(out).append(h('div', { class: 'callout' }, h('b', null, t('Keyword engine result')), h('div', null, d.keyword ? `${d.keyword.score}% · ${t(d.keyword.type[0].toUpperCase() + d.keyword.type.slice(1))} · «${d.keyword.matchedForm}»` : t('No match')), h('div', { class: 'xs muted' }, `${t('Normalized')}: ${d.normalized}`)),
      (d.ai || d.ai_error) && h('div', { class: `callout ${d.ai ? '' : 'bad'}` }, h('b', null, t('AI result')), d.ai ? h('div', null, `${d.ai.isMatch ? '✔' : '✘'} ${Math.round(d.ai.confidence)}% · ${d.ai.intent}`, h('div', { class: 'muted' }, d.ai.reason)) : h('div', null, d.ai_error))); } catch (e) { showError(e); }
  }, { kind: 'primary', ic: 'play' });
  const m = modal({ title: `${t('Test')}: ${r.name}`, body: h('div', { class: 'stack' }, ta, h('div', { class: 'row' }, h('label', { class: 'row tight' }, h('input', { type: 'checkbox', onChange: (e) => { ai = e.target.checked; } }), t('Use AI')), run), out) });
}
async function suggestModal(r, reload) {
  const list = h('div'); const note = h('div');
  const load = async () => { const { data } = await get(`/radar/${r.id}/suggestions`); clear(list).append(data.length ? h('div', { class: 'list' }, data.map((s) => h('div', null, h('div', { class: 'grow' }, h('div', { class: 'b' }, s.phrase), h('div', { class: 'xs muted' }, `${t('Seen')} ${s.hits} ${t('times')}${s.example ? ` · ${s.example}` : ''}`)), btn(t('Add keyword'), async () => { try { await post(`/radar/suggestions/${s.id}/accept`); load(); reload(); } catch (e) { showError(e); } }, { sm: true, kind: 'primary' }), btn(t('Ignore'), async () => { try { await post(`/radar/suggestions/${s.id}/ignore`); load(); reload(); } catch (e) { showError(e); } }, { sm: true })))) : emptyState(t('No data'), 'spark')); };
  modal({ title: `${t('Suggestions')}: ${r.name}`, size: 'lg', body: h('div', { class: 'stack' }, btn(t('Ask AI for proposals'), async () => { try { const x = await post(`/radar/${r.id}/suggest`); clear(note).append(h('div', { class: 'callout' }, x.data.notes || x.note)); load(); } catch (e) { showError(e); } }, { ic: 'spark' }), note, list) });
  await load();
}
async function examplesModal(r) {
  const { data } = await get(`/radar/${r.id}/examples`); const body = h('div');
  const draw = (rows) => { clear(body).append(rows.length ? h('div', { class: 'list' }, rows.map((e) => h('div', null, badge(e.label === 'positive' ? '✔' : '✘', e.label === 'positive' ? 'ok' : 'bad'), h('div', { class: 'grow sm' }, e.text), iconBtn('trash', t('Delete'), async () => { await del(`/radar/examples/${e.id}`); draw(rows.filter((x) => x.id !== e.id)); }, 'danger')))) : emptyState(t('No data'), 'spark')); };
  draw(data); modal({ title: `${t('Examples')}: ${r.name}`, size: 'lg', body });
}

export default async function radar(ctx) {
  const box = h('div', { class: 'grid g2' }); const op = can('operator');
  ctx.root.append(pageHead(t('Smart Radar'), 'Describe it in plain words — the AI turns it into an executable intent.', op && btn(t('New radar'), () => openRadarBuilder(load), { kind: 'primary', ic: 'spark' })), box);
  async function load() {
    try {
      const { data } = await get('/radar'); clear(box);
      if (!data.length) return box.append(emptyState(t('No data'), 'radar'));
      for (const r of data) {
        const judged = r.confirmed + r.rejected; const prec = judged ? Math.round((r.confirmed / judged) * 100) : null;
        box.append(card(null, h('div', { class: 'stack' },
          h('div', { class: 'row' }, h('h3', { class: 'grow' }, r.name), badge(t(r.status[0].toUpperCase() + r.status.slice(1)), r.status === 'active' ? 'ok' : r.status === 'paused' ? 'warn' : ''), r.priority_hint && prioBadge(r.priority_hint)),
          h('div', { class: 'row tight' }, badge(r.intent, 'info'), h('span', { class: 'chip' }, `${t('Min score')} ${r.min_score}%`), h('span', { class: 'chip' }, `AI: ${t({ uncertain: 'Only when uncertain', always: 'Always', off: 'Off' }[r.ai_mode])}`)),
          h('div', { class: 'muted sm' }, r.signals.slice(0, 3).map((s) => `«${s}»`).join('  '), r.signals.length > 3 && ` +${r.signals.length - 3}`),
          h('div', { class: 'row sm muted' }, h('span', null, `${t('Hits')}: `, h('b', { class: 'num' }, fmt.num(r.hits))), h('span', null, `${t('Confirmed')}: `, h('b', { class: 'num' }, r.confirmed)), h('span', null, `${t('Rejected')}: `, h('b', { class: 'num' }, r.rejected)), prec != null && h('span', null, `${prec}%`)),
          h('div', { class: 'row tight' }, btn(t('Test'), () => testModal(r), { sm: true, ic: 'play' }), op && btn(t('Edit'), () => openRadarBuilder(load, r), { sm: true, ic: 'edit' }),
            op && (r.status === 'active' ? btn(t('Pause'), async () => { try { await post(`/radar/${r.id}/pause`); load(); } catch (e) { showError(e); } }, { sm: true, ic: 'pause' }) : btn(t('Activate'), async () => { if (await confirmBox(`${t('Activate')}: ${r.name}?`, { ok: t('Activate') })) { try { await post(`/radar/${r.id}/activate`, { confirm: true }); load(); } catch (e) { showError(e); } } }, { sm: true, kind: 'primary', ic: 'check' })),
            op && h('span', { style: { position: 'relative' } }, btn(t('Suggestions'), () => suggestModal(r, load), { sm: true, ic: 'spark' }), r.suggestions > 0 && h('span', { class: 'pill', style: { position: 'absolute', insetBlockStart: '-7px', insetInlineEnd: '-7px' } }, r.suggestions)),
            btn(`${t('Examples')} (${r.examples})`, () => examplesModal(r), { sm: true }), op && iconBtn('trash', t('Delete'), async () => { if (await confirmBox(`${t('Delete')}: ${r.name}?`, { danger: true, ok: t('Delete') })) { try { await del(`/radar/${r.id}`); load(); } catch (e) { showError(e); } } }, 'danger')))));
      }
    } catch (e) { clear(box).append(errorBox(e, load)); }
  }
  box.append(skeletons(2)); await load();
}
