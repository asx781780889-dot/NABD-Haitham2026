import { h, icon, clear } from '../lib/dom.js';
import { t, fmt } from '../lib/i18n.js';
import { get, post, patch, del } from '../lib/api.js';
import * as ws from '../lib/ws.js';
import { pageHead, btn, iconBtn, table, statusDot, badge, modal, form, toast, showError, confirmBox, emptyState, skeletons, can, errorBox } from '../lib/ui.js';

const ST = { connected: 'Connected', disconnected: 'Disconnected', connecting: 'Connecting', error: 'Error', auth_required: 'Error', pending: 'Pending', disabled: 'Disabled' };

/** Multi-step secure login: details -> Telegram code -> optional 2FA password. Exported for the onboarding wizard. */
export function openAddAccount(onDone) {
  let accId = null; let finished = false;
  const f = form([
    { key: 'name', label: t('Account name (optional)') }, { key: 'phone', label: t('Phone number'), placeholder: '+9665XXXXXXXX', dir: 'ltr' },
    { key: 'api_id', label: t('API ID'), type: 'number', dir: 'ltr' }, { key: 'api_hash', label: t('API Hash'), type: 'password', dir: 'ltr' },
    { key: 'session', label: t('Session string (optional)'), type: 'password', hint: 'GramJS / Telethon StringSession' },
    { key: 'description', label: t('Description') }, { key: 'tags', label: t('Tags (comma separated)'), type: 'tags' },
  ]);
  const body = h('div', { class: 'stack' }); const foot = [];
  const m = modal({ title: t('Add account'), body, footer: [], onClose: () => { if (accId && !finished) post(`/accounts/${accId}/login/cancel`).catch(() => {}); }, dismiss: false });
  const setFoot = (...els) => m.setFooter(els);
  const busy = (b, on) => { b.disabled = on; };
  const done = (login) => { finished = true; clear(body).append(h('div', { class: 'stack', style: { alignItems: 'center', padding: '16px' } }, h('span', { style: { color: 'var(--ok)' } }, icon('check', 44)), h('h3', null, t('Account linked successfully')), h('p', { class: 'muted' }, `${login?.me?.name ?? ''} ${login?.me?.username ? `@${login.me.username}` : ''} — ${t('Your session is stored encrypted on the server.')}`))); setFoot(btn(t('Done'), () => { m.close(); onDone?.(); }, { kind: 'primary' })); };
  const stepCode = (login) => {
    const c = form([{ key: 'code', label: t('Login code'), hint: login.via === 'app' ? t('Code sent via the Telegram app') : t('Code sent via SMS'), dir: 'ltr' }]);
    clear(body).append(h('p', { class: 'muted' }, t('Enter the code Telegram sent you')), c.el); c.ctl.code.inputMode = 'numeric'; c.ctl.code.focus();
    const go = btn(t('Verify'), async () => { busy(go, true); try { const r = await post(`/accounts/${accId}/login/code`, { code: c.get().code }); r.login.step === 'password' ? stepPassword() : done(r.login); } catch (e) { showError(e); } busy(go, false); }, { kind: 'primary' });
    c.el.addEventListener('keydown', (e) => e.key === 'Enter' && go.click()); setFoot(btn(t('Cancel'), () => m.close()), go);
  };
  const stepPassword = () => {
    const c = form([{ key: 'password', label: t('Two-step verification password'), type: 'password' }]); clear(body).append(c.el); c.ctl.password.focus();
    const go = btn(t('Verify'), async () => { busy(go, true); try { done((await post(`/accounts/${accId}/login/password`, { password: c.get().password })).login); } catch (e) { showError(e); } busy(go, false); }, { kind: 'primary' });
    c.el.addEventListener('keydown', (e) => e.key === 'Enter' && go.click()); setFoot(btn(t('Cancel'), () => m.close()), go);
  };
  clear(body).append(h('div', { class: 'callout' }, t('Get the API ID and API Hash from my.telegram.org → API development tools. They are stored encrypted and never shown again.')), f.el);
  const submit = btn(t('Next'), async () => {
    const v = f.get(); busy(submit, true);
    try { const r = await post('/accounts', { name: v.name || undefined, phone: v.phone, api_id: v.api_id, api_hash: v.api_hash, session: v.session || undefined, description: v.description || undefined, tags: v.tags }); accId = r.data.id; r.login.step === 'done' ? done(r.login) : stepCode(r.login); }
    catch (e) { showError(e); } busy(submit, false);
  }, { kind: 'primary' });
  setFoot(btn(t('Cancel'), () => m.close()), submit);
}

function details(a) {
  const logs = h('div', { class: 'pre' }, t('Loading…'));
  get(`/accounts/${a.id}/logs`).then((r) => { logs.textContent = r.data.map((l) => `${fmt.dt(l.created_at)}  ${l.level.toUpperCase().padEnd(5)} ${l.message} ${l.details ?? ''}`).join('\n') || '—'; }).catch((e) => { logs.textContent = e.message; });
  modal({ title: a.name, size: 'lg', body: h('div', { class: 'stack' }, h('dl', { class: 'kvs' }, [[t('Status'), statusDot(a.status, t(ST[a.status] ?? a.status))], ['Username', a.tg_username ? `@${a.tg_username}` : '–'], [t('User ID'), a.tg_user_id ?? '–'], [t('Phone'), h('span', { class: 'mono' }, a.phone_masked)], [t('Last connected'), fmt.dt(a.last_connected_at)], [t('Groups'), a.groups_count], [t('Channels'), a.channels_count], [t('Chats'), a.chats_count], [t('Messages processed'), fmt.num(a.messages_processed)], [t('Matches'), fmt.num(a.matches_count)], [t('Errors'), a.last_error ?? a.errors_count], [t('Tags'), (a.tags ?? []).join(', ') || '–']].flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])), h('h3', null, t('Logs')), logs) });
}

export default async function accounts(ctx) {
  const box = h('div'); const admin = can('admin'); const op = can('operator');
  const head = pageHead(t('Telegram Accounts'), null, btn(t('Refresh'), () => load(), { ic: 'refresh' }), admin && btn(t('Add account'), () => openAddAccount(load), { kind: 'primary', ic: 'plus' }));
  ctx.root.append(head, box);
  async function act(fn, ok) { try { await fn(); if (ok) toast(ok); load(); } catch (e) { showError(e); } }
  async function load() {
    try {
      const { data } = await get('/accounts'); clear(box);
      if (!data.length) return box.append(emptyState(t('No accounts yet. Add your first Telegram account to start monitoring.'), 'users'));
      box.append(table({ rows: data, rowKey: (a) => a.id, columns: [
        { label: t('Account'), render: (a) => h('div', null, h('div', { class: 'b' }, a.name), h('div', { class: 'xs muted' }, [a.tg_username && `@${a.tg_username}`, a.tg_user_id && `ID ${a.tg_user_id}`].filter(Boolean).join(' · ') || '–')) },
        { label: t('Status'), render: (a) => h('div', null, statusDot(a.status, t(ST[a.status] ?? a.status)), a.last_error && a.status !== 'connected' && h('div', { class: 'xs faint clip', style: { maxWidth: '220px' }, title: a.last_error }, a.last_error)) },
        { label: t('Phone'), render: (a) => h('span', { class: 'mono xs' }, a.phone_masked) },
        { label: t('Last connected'), render: (a) => h('span', { class: 'xs' }, fmt.ago(a.last_connected_at)) },
        { label: `${t('Groups')}/${t('Channels')}/${t('Chats')}`, render: (a) => h('span', { class: 'num mono xs' }, `${a.groups_count} / ${a.channels_count} / ${a.chats_count}`) },
        { label: t('Processed'), render: (a) => h('span', { class: 'num mono' }, fmt.num(a.messages_processed)) },
        { label: t('Matches'), render: (a) => h('span', { class: 'num mono' }, fmt.num(a.matches_count)) },
        { label: t('Errors'), render: (a) => h('span', { class: 'num mono' }, a.errors_count) },
        { label: t('Actions'), act: true, render: (a) => h('div', { class: 'row tight' },
          iconBtn('eye', t('Open'), () => details(a)),
          op && iconBtn('refresh', t('Reconnect'), () => act(() => post(`/accounts/${a.id}/reconnect`))),
          op && iconBtn('layers', t('Sync'), () => act(async () => { const r = await post(`/accounts/${a.id}/sync`); if (r.error) throw Object.assign(new Error(r.error), { errorId: null }); toast(`${r.result?.total ?? 0} ${t('Sources')}`); })),
          op && iconBtn('activity', t('Test'), () => act(async () => { const r = await post(`/accounts/${a.id}/test`); if (r.error) throw new Error(r.error); toast(`${t('Provider works')}: ${r.result?.latency_ms ?? ''} ms`); })),
          op && (a.enabled ? iconBtn('pause', t('Pause'), () => act(() => post(`/accounts/${a.id}/disable`))) : iconBtn('play', t('Resume'), () => act(() => post(`/accounts/${a.id}/enable`)))),
          admin && iconBtn('edit', t('Edit'), () => { const f = form([{ key: 'name', label: t('Name') }, { key: 'description', label: t('Description') }, { key: 'tags', label: t('Tags (comma separated)'), type: 'tags' }], a); const m = modal({ title: t('Edit'), body: f.el, footer: [btn(t('Cancel'), () => m.close()), btn(t('Save'), async () => { try { await patch(`/accounts/${a.id}`, f.get()); m.close(); load(); } catch (e) { showError(e); } }, { kind: 'primary' })] }); }),
          admin && iconBtn('trash', t('Delete'), async () => { if (await confirmBox(t('Delete this account? Its session will be revoked.'), { danger: true, ok: t('Delete') })) act(() => del(`/accounts/${a.id}`)); }, 'danger')) },
      ] }));
    } catch (e) { clear(box).append(errorBox(e, load)); }
  }
  box.append(skeletons(2)); await load();
  let tm; ctx.onLeave(ws.on('account.status', () => { clearTimeout(tm); tm = setTimeout(load, 400); }));
}
