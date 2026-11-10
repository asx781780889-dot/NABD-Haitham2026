// The Live Card: one component for the feed, search, saved and dashboard.
import { h, icon } from './dom.js';
import { t, fmt } from './i18n.js';
import { post, del, get } from './api.js';
import { badge, prioBadge, iconBtn, copyText, confirmBox, modal, toast, showError, highlight, can, cap } from './ui.js';

const RING = { low: 'var(--low)', medium: 'var(--medium)', high: 'var(--high)', critical: 'var(--critical)' };
const TEMPLATES = (c) => [
  { id: 'prio_user', label: t('Always HIGH priority for this user'), cond: { type: 'sender', ids: [c.sender.id] }, actions: [{ type: 'set_priority', value: 'high' }], need: c.sender.id != null },
  { id: 'ignore_user', label: t('Always ignore this user'), cond: { type: 'sender', ids: [c.sender.id] }, actions: [{ type: 'suppress' }], need: c.sender.id != null },
  { id: 'notify_user', label: t('Notify me on Telegram for this user'), cond: { type: 'sender', ids: [c.sender.id] }, actions: [{ type: 'notify', channels: ['telegram'] }], need: c.sender.id != null },
  { id: 'prio_source', label: t('Always HIGH priority for this source'), cond: { type: 'source', ids: [c.source.id] }, actions: [{ type: 'set_priority', value: 'high' }], need: c.source.id != null },
].filter((x) => x.need);

async function ruleFromCard(c) {
  const opts = TEMPLATES(c); let pick = opts[0]?.id;
  if (!opts.length) return toast(t('No data'), 'warn');
  const sel = h('div', { class: 'stack tight' }, opts.map((o, i) => h('label', { class: 'row tight', style: { cursor: 'pointer' } }, h('input', { type: 'radio', name: 'tpl', checked: i === 0, onChange: () => { pick = o.id; } }), o.label)));
  const m = modal({ title: t('Rule from this message'), body: sel, footer: [h('button', { class: 'btn', onClick: () => m.close() }, t('Cancel')), h('button', { class: 'btn primary', onClick: async () => {
    const o = opts.find((x) => x.id === pick);
    try { await post('/rules', { name: `${o.label} (#${c.sender.id ?? c.source.id})`, conditions: o.cond, actions: o.actions }); toast(t('Saved.')); m.close(); } catch (e) { showError(e); }
  } }, t('Create'))] });
}

export function matchCard(c, { onChange, onRemove, fresh = false, compact = false } = {}) {
  const op = can('operator'); const who = c.sender.username ? `@${c.sender.username}` : c.sender.name || (c.sender.id ?? '—');
  const act = (fn) => async () => { try { await fn(); const nc = (await get(`/matches/${c.id}`)).data; onChange?.(nc); } catch (e) { showError(e); } };
  const remove = async (fn) => { try { await fn(); onRemove?.(c); } catch (e) { showError(e); } };
  const tip = (ic, title, fn, kind) => iconBtn(ic, title, fn, kind);
  const el = h('article', { class: `mc p-${c.priority} ${fresh ? 'fresh' : ''} ${c.status === 'ignored' ? 'ignored' : ''}`, 'data-id': c.id },
    h('div', { class: 'ring', style: { '--p': c.score, '--ringc': RING[c.priority] }, title: t('Match') }, h('b', null, `${Math.round(c.score)}%`)),
    h('div', { class: 'meta' }, prioBadge(c.priority), badge(t(cap(c.match_type)), 'info'), c.intent && badge(c.intent, 'ok'), c.keyword && h('span', { class: 'chip' }, icon('tag', 13), c.keyword),
      c.pinned && h('span', { class: 'chip' }, icon('pin', 13)), c.saved && h('span', { class: 'chip' }, icon('bookmark', 13)), c.ai_degraded && badge(t('degraded: keywords only'), 'warn'),
      h('span', { class: 'end num xs' }, `${fmt.date(c.sent_at)} ${fmt.time(c.sent_at)}`)),
    h('div', { class: 'meta' }, h('span', { class: 'b', style: { color: 'var(--text)' } }, who), c.sender.id != null && h('span', { class: 'mono xs' }, `ID ${c.sender.id}`), h('span', null, '·'),
      h('span', null, c.source.title ?? '—'), h('span', { class: 'faint' }, `(${c.account.name ?? '—'})`)),
    h('div', { class: 'txt full' }, highlight(c.text ?? '', c.keyword)),
    !compact && c.ai_reason && h('div', { class: 'why full' }, h('b', null, `${t('AI reason')}: `), c.ai_reason),
    !compact && h('div', { class: 'meta full' }, h('span', { class: 'mono xs' }, `${t('Message ID')}: ${c.tg_message_id}`),
      c.detected_by.length > 0 && h('span', null, `${t('Detected by')}: `, c.detected_by.map((a) => h('span', { class: 'chip', style: { marginInlineEnd: '4px' } }, a.name))),
      c.occurrences > 1 && badge(`+${c.occurrences - 1} ${t('repost(s)')}`, 'warn'), (c.tags ?? []).map((x) => h('span', { class: 'chip' }, `#${x}`))),
    h('div', { class: 'acts full' },
      tip('copy', t('Copy user ID'), () => c.sender.id != null && copyText(String(c.sender.id))), tip('message', t('Copy message'), () => copyText(c.text ?? '')),
      c.links.chat && tip('external', t('Open chat'), () => window.open(c.links.chat, '_blank', 'noopener')), c.links.message && tip('link', t('Open message'), () => window.open(c.links.message, '_blank', 'noopener')),
      op && h('span', { class: 'sep' }),
      op && tip('bookmark', c.saved ? t('Saved') : t('Save'), act(() => post(`/matches/${c.id}/${c.saved ? 'unsave' : 'save'}`)), c.saved ? 'on' : ''),
      op && tip('pin', c.pinned ? t('Unpin') : t('Pin'), act(() => post(`/matches/${c.id}/${c.pinned ? 'unpin' : 'pin'}`)), c.pinned ? 'on' : ''),
      op && tip('sliders', t('Add rule'), () => ruleFromCard(c)),
      op && tip('x', t('Ignore card'), () => remove(() => post(`/matches/${c.id}/ignore`))),
      op && c.sender.id != null && tip('ban', t('Block user'), async () => { if (await confirmBox(t('Block this user? Their messages will be hidden everywhere.'), { danger: true, ok: t('Block') })) remove(() => post(`/matches/${c.id}/block-user`)); }, 'danger'),
      op && tip('shield', t('Block group'), async () => { if (await confirmBox(t('Block this group? Its results will be hidden everywhere.'), { danger: true, ok: t('Block') })) remove(() => post(`/matches/${c.id}/block-source`)); }, 'danger'),
      op && tip('trash', t('Delete'), async () => { if (await confirmBox(t('Delete this card?'), { danger: true, ok: t('Delete') })) remove(() => del(`/matches/${c.id}`)); }, 'danger'),
      op && h('span', { class: 'end row tight' },
        tip('up', t('Correct match'), act(() => post(`/matches/${c.id}/feedback`, { value: 'correct' })), c.feedback === 'correct' ? 'on' : ''),
        tip('dn', t('Incorrect match'), act(() => post(`/matches/${c.id}/feedback`, { value: 'incorrect' })), c.feedback === 'incorrect' ? 'on' : ''))));
  return el;
}
