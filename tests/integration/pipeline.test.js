// End-to-end: Account -> Telegram -> Message -> Processor -> Keyword -> AI -> Match -> Live Card -> Notification -> Logs -> Database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, setupAdmin, waitFor, sleep } from '../helpers/harness.js';
import { deliver, dropConnection } from '../helpers/fakes.js';

const PHONE1 = '+966500000001'; const PHONE2 = '+966500000002';
const HUB = -1001111111111; const ADS = -1001222222222; const NEWS = -1003333333333; const PRIVATE_FUTURE = 700000001; const SAVED_FUTURE = 700000002;
const GROUP_FUTURE = -1004444444444; const CHANNEL_FUTURE = -1005555555555;
const dlg = (extra = []) => [{ chatId: HUB, kind: 'supergroup', title: 'Students Hub', username: null, members: 500 }, { chatId: ADS, kind: 'supergroup', title: 'Ads Group', username: null, members: 90 }, { chatId: NEWS, kind: 'channel', title: 'News', username: 'newsch', members: 9000 }, { chatId: 700000003, kind: 'private', title: 'Private chat', username: 'student', members: null }, { chatId: 700000004, kind: 'saved', title: 'Saved messages', username: null, members: null }, ...extra];
const msg = (text, o = {}) => ({ chatId: HUB, title: 'Students Hub', senderId: 111, senderUsername: 'student_a', senderName: 'Student A', text, ...o });
let h; let acc1; let acc2; let radarId; const S = {};

before(async () => {
  h = await startHarness(); await setupAdmin(h);
  h.world.addAccount(PHONE1, { userId: 7001, username: 'acc_one', password: 'two-step-pw', dialogs: dlg() });
  h.world.addAccount(PHONE2, { userId: 7002, username: 'acc_two', dialogs: dlg() });
});
after(async () => { await h.stop(); });

const cards = async (q = '') => (await h.ok('GET', `/api/matches?limit=100&sort=created${q}`)).data;
const cardFor = (list, text) => list.find((c) => c.text === text);
const settle = async (text, timeout = 15000) => waitFor(async () => cardFor(await cards(), text), { timeout, label: `card "${text}"` });

test('AI providers: configure, test, secrets never returned', async () => {
  await h.ok('PUT', '/api/ai/providers/custom', { enabled: true, base_url: `${h.svc.url}/v1`, model: 'fake-model', api_key: 'sk-secret-123' });
  await h.ok('PUT', '/api/settings', { values: { 'ai.primary': 'custom', 'ai.requests_per_minute': 600, 'telegram.reconnect_base_ms': 500, 'notify.telegram.enabled': false, 'notify.telegram.bot_token': 'bot-token-xyz', 'notify.telegram.chat_id': '42' } });
  const t = await h.ok('POST', '/api/ai/providers/custom/test'); assert.equal(t.ok, true);
  const list = await h.api('GET', '/api/ai/providers'); assert.ok(!list.text.includes('sk-secret-123'), 'API key leaked');
  assert.equal(list.body.data.find((p) => p.id === 'custom').has_api_key, true);
  const st = await h.api('GET', '/api/settings'); assert.ok(!st.text.includes('bot-token-xyz'), 'bot token leaked');
  const models = await h.ok('GET', '/api/ai/providers/custom/models'); assert.deepEqual(models.data, ['fake-model', 'fake-model-2']);
  await h.ok('PUT', '/api/settings', { values: { 'ai.primary': 'grok' } });
  const grok = (await h.ok('GET', '/api/ai/providers')).data.find((p) => p.id === 'grok');
  assert.ok(grok); assert.equal(grok.model, 'grok-4-fast'); assert.equal(grok.base_url, 'https://api.x.ai/v1');
  await h.ok('PUT', '/api/settings', { values: { 'ai.primary': 'custom' } });
});

test('Telegram login: wrong code, 2FA, wrong password, success -> worker connects; secrets hidden', async () => {
  const created = await h.api('POST', '/api/accounts', { name: 'Primary', phone: PHONE1, api_id: 12345, api_hash: 'a'.repeat(32), tags: ['main'] });
  assert.equal(created.status, 201, created.text); acc1 = created.body.data.id; assert.equal(created.body.login.step, 'code');
  assert.equal(created.body.data.phone_masked.includes('966500000001'), false);
  let r = await h.api('POST', `/api/accounts/${acc1}/login/code`, { code: '00000' }); assert.equal(r.status, 400); assert.equal(r.body.error.code, 'TELEGRAM_CODE_INVALID');
  r = await h.api('POST', `/api/accounts/${acc1}/login/code`, { code: '12345' }); assert.equal(r.body.login.step, 'password');
  r = await h.api('POST', `/api/accounts/${acc1}/login/password`, { password: 'wrong' }); assert.equal(r.status, 400); assert.equal(r.body.error.code, 'TELEGRAM_PASSWORD_INVALID');
  r = await h.api('POST', `/api/accounts/${acc1}/login/password`, { password: 'two-step-pw' }); assert.equal(r.body.login.step, 'done', r.text);
  await waitFor(async () => (await h.ok('GET', `/api/accounts/${acc1}`)).data.status === 'connected', { label: 'account connected' });
  const list = await h.api('GET', '/api/accounts');
  for (const secret of ['a'.repeat(32), 'fake-session', 'two-step-pw', '+966500000001', 'api_hash', 'session_enc']) assert.ok(!list.text.includes(secret), `leaked ${secret}`);
  const row = await h.db.one('SELECT phone_enc, api_hash_enc FROM telegram_accounts WHERE id = $1', [acc1]); assert.ok(row.api_hash_enc.startsWith('v1.'));
  const sess = await h.db.one('SELECT session_enc FROM telegram_sessions WHERE account_id = $1 AND is_active', [acc1]); assert.ok(sess.session_enc.startsWith('v1.') && !sess.session_enc.includes('fake-session'));
  const dup = await h.api('POST', '/api/accounts', { phone: PHONE1, api_id: 1, api_hash: 'b'.repeat(32) }); assert.equal(dup.status, 409);
  const bad = await h.api('POST', '/api/accounts', { phone: '123', api_id: 1, api_hash: 'zz' }); assert.equal(bad.status, 400); assert.equal(bad.body.error.code, 'VALIDATION');
});

test('second account via imported session; sync automatically monitors every source kind', async () => {
  h.world.sessions.set('fake-session-' + PHONE2, PHONE2);
  const r = await h.api('POST', '/api/accounts', { name: 'Second', phone: PHONE2, api_id: 12345, api_hash: 'c'.repeat(32), session: 'fake-session-' + PHONE2 + '-padding-padding' });
  assert.equal(r.status, 400, 'a session that is not authorised must be rejected'); assert.equal(r.body.error.code, 'SESSION_INVALID');
  const ok = await h.api('POST', '/api/accounts', { name: 'Second', phone: PHONE2, api_id: 12345, api_hash: 'c'.repeat(32) }); acc2 = ok.body.data.id;
  await h.ok('POST', `/api/accounts/${acc2}/login/code`, { code: '12345' });
  await waitFor(async () => (await h.ok('GET', `/api/accounts/${acc2}`)).data.status === 'connected', { label: 'account 2 connected' });
  const sync = await h.ok('POST', `/api/accounts/${acc1}/sync`); assert.equal(sync.task.state, 'completed'); assert.equal(sync.result.total, 5);
  const src = (await h.ok('GET', `/api/sources?account_id=${acc1}`)).data; assert.equal(src.length, 5); assert.ok(src.every((s) => s.monitoring_enabled === true));
  for (const a of [acc1, acc2]) for (const s of (await h.ok('GET', `/api/sources?account_id=${a}`)).data) {
    if (s.tg_chat_id === HUB || s.tg_chat_id === NEWS) await h.ok('PATCH', `/api/sources/${s.id}`, { monitoring_enabled: true });
    if (a === acc1 && s.tg_chat_id === ADS) await h.ok('PATCH', `/api/sources/${s.id}`, { monitoring_enabled: false });
  }
  S.hub1 = (await h.ok('GET', `/api/sources?account_id=${acc1}`)).data.find((s) => s.tg_chat_id === HUB);
  assert.equal((await h.ok('GET', '/api/accounts')).data.find((a) => a.id === acc1).groups_count, 2);
});

test('all existing and newly discovered groups are automatically monitored', async () => {
  const before = (await h.ok('GET', `/api/sources?account_id=${acc1}`)).data;
  assert.equal(before.find((s) => s.tg_chat_id === ADS).monitoring_enabled, false);
  const sync = await h.ok('POST', `/api/accounts/${acc1}/sync`);
  assert.equal(sync.task.state, 'completed');
  const after = (await h.ok('GET', `/api/sources?account_id=${acc1}`)).data;
  assert.ok(after.filter((s) => ['group', 'supergroup'].includes(s.kind)).every((s) => s.monitoring_enabled));

  await h.ok('PUT', '/api/settings', { values: { 'telegram.auto_monitor_new_sources': false } });
  try {
    assert.equal(deliver(PHONE1, msg('رسالة في مجموعة مكتشفة حديثاً', { chatId: GROUP_FUTURE, kind: 'supergroup', title: 'Future Group' })), 1);
    assert.equal(deliver(PHONE1, msg('رسالة في قناة مكتشفة حديثاً', { chatId: CHANNEL_FUTURE, kind: 'channel', title: 'Future Channel' })), 1);
    await waitFor(async () => {
      const group = await h.db.one('SELECT monitoring_enabled FROM telegram_sources WHERE account_id = $1 AND tg_chat_id = $2', [acc1, GROUP_FUTURE]);
      const channel = await h.db.one('SELECT monitoring_enabled FROM telegram_sources WHERE account_id = $1 AND tg_chat_id = $2', [acc1, CHANNEL_FUTURE]);
      return group && channel;
    }, { label: 'future group and channel sources created' });
    assert.equal((await h.db.one('SELECT monitoring_enabled FROM telegram_sources WHERE account_id = $1 AND tg_chat_id = $2', [acc1, GROUP_FUTURE])).monitoring_enabled, true);
    assert.equal((await h.db.one('SELECT monitoring_enabled FROM telegram_sources WHERE account_id = $1 AND tg_chat_id = $2', [acc1, CHANNEL_FUTURE])).monitoring_enabled, false);
  } finally {
    await h.ok('PUT', '/api/settings', { values: { 'telegram.auto_monitor_new_sources': true } });
  }
});

test('Smart Radar: AI draft -> operator confirms -> active', async () => {
  const d = await h.ok('POST', '/api/radar/draft', { description: 'أريد الأشخاص الذين يكتبون أنهم يحتاجون مساعدة في مشاريع التخرج' });
  assert.equal(d.data.source, 'ai'); assert.equal(d.data.requires_confirmation, true); assert.ok(d.data.signals.length >= 5);
  const created = await h.ok('POST', '/api/radar', { ...d.data, confirm: true }); radarId = created.data.id;
  assert.equal((await h.ok('GET', '/api/radar')).data.find((x) => x.id === radarId).status, 'active');
  const nc = await h.api('POST', '/api/radar', { ...d.data, name: 'Unconfirmed' }); assert.equal(nc.status, 201);
  assert.equal((await h.ok('GET', '/api/radar')).data.find((x) => x.id === nc.body.data.id).status, 'draft', 'without confirmation a radar must stay a draft');
  await h.ok('DELETE', `/api/radar/${nc.body.data.id}`);
  const t = await h.ok('POST', `/api/radar/${radarId}/test`, { text: 'احتاج مساعدة في مشروع التخرج', use_ai: true }); assert.ok(t.data.keyword.score >= 90); assert.equal(t.data.ai.isMatch, true);
});

test('pipeline: keyword hit, semantic (AI) hit, ignored noise, blocked user, unmonitored source, live WebSocket', async () => {
  const live = h.openWs(); await live.ready;
  const exact = 'السلام عليكم احتاج مساعدة في مشروع التخرج';
  const semantic = 'مين يقدر يساعدني بمشروع التخرج';
  await h.ok('POST', '/api/blocks/users', { tg_user_id: 999, username: 'spammer' });
  assert.equal(deliver(PHONE1, msg('رسالة خاصة جديدة', { chatId: PRIVATE_FUTURE, kind: 'private', title: 'New private chat' })), 1);
  assert.equal(deliver(PHONE1, msg('ملاحظة جديدة', { chatId: SAVED_FUTURE, kind: 'saved', title: 'New saved messages', isOutgoing: true })), 1);
  await waitFor(async () => {
    const p = await h.db.one('SELECT monitoring_enabled FROM telegram_sources WHERE account_id = $1 AND tg_chat_id = $2', [acc1, PRIVATE_FUTURE]);
    const s = await h.db.one('SELECT monitoring_enabled FROM telegram_sources WHERE account_id = $1 AND tg_chat_id = $2', [acc1, SAVED_FUTURE]);
    return p?.monitoring_enabled === true && s?.monitoring_enabled === true;
  }, { label: 'new private and saved sources auto-enabled' });
  const callsBefore = h.svc.ai.calls;
  assert.equal(deliver(PHONE1, msg(exact)), 1);
  assert.equal(deliver(PHONE1, msg(semantic, { senderId: 112, senderUsername: 'student_b' })), 1);
  deliver(PHONE1, msg('صباح الخير يا شباب'));
  deliver(PHONE1, msg('احتاج مساعدة في مشروع التخرج', { senderId: 999, senderUsername: 'spammer' }));
  deliver(PHONE1, msg('احتاج مساعدة في مشروع التخرج', { chatId: ADS, title: 'Ads Group' }));
  const c1 = await settle(exact); const c2 = await settle(semantic);
  assert.equal(c1.match_type, 'exact'); assert.equal(c1.score, 100); assert.equal(c1.priority, 'high'); assert.equal(c1.rule.id, radarId); assert.equal(c1.sender.id, 111); assert.equal(c1.source.title, 'Students Hub'); assert.ok(c1.links.message?.includes('t.me/c/1111111111/'));
  assert.equal(c2.intent, 'Graduation Help'); assert.ok(c2.ai_confidence >= 90 && c2.ai_reason.length > 5, JSON.stringify(c2)); assert.ok(['semantic', 'fuzzy', 'partial', 'exact', 'synonym'].includes(c2.match_type));
  assert.ok(h.svc.ai.calls > callsBefore, 'AI must be consulted for the uncertain message');
  assert.ok(!h.svc.ai.lastUser.includes('student_b'), 'no usernames in prompts'); assert.ok(h.svc.ai.lastUser.includes('<message>'));
  const all = await cards(); assert.ok(!all.some((c) => c.text === 'صباح الخير يا شباب' || c.sender.id === 999), 'noise / blocked users must not appear');
  const blocked = await h.db.one("SELECT state, skip_reason FROM messages WHERE sender_id = 999"); assert.equal(blocked.state, 'skipped'); assert.equal(blocked.skip_reason, 'blocked_user');
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM messages WHERE tg_chat_id = $1', [ADS])).n, 0, 'unmonitored sources are not stored');
  await waitFor(() => live.events.some((e) => e.t === 'match.new' && e.card.text === exact), { label: 'ws match.new' });
  const ev = live.events.find((e) => e.t === 'match.new' && e.card.text === exact); assert.equal(ev.ui.browser, true, 'high priority triggers browser notification'); assert.ok(!live.events.some((e) => e.card?.sender?.id === 999));
  assert.ok(live.events.some((e) => e.t === 'alert.new'), 'dashboard alert pushed'); live.close();
  S.c1 = c1; S.c2 = c2;
});

test('duplicates: same message seen by two accounts -> ONE card "detected by" both; reposts are merged', async () => {
  const text = 'احتاج مساعدة في مشروع التخرج اليوم من فضلكم'; const common = { tgMessageId: 5555 };
  deliver(PHONE1, msg(text, common)); deliver(PHONE2, msg(text, common));
  const c = await settle(text); await waitFor(async () => (await cards()).find((x) => x.text === text).occurrences === 2, { label: 'second occurrence merged' });
  const list = (await cards()).filter((x) => x.text === text); assert.equal(list.length, 1);
  assert.deepEqual(list[0].detected_by.map((a) => a.name).sort(), ['Primary', 'Second']);
  deliver(PHONE1, msg('احتاج  مساعدة في مشروع التخرج اليوم من فضلكم!!', { tgMessageId: 5556 })); // whitespace / symbol differences, same sender
  await waitFor(async () => (await cards()).find((x) => x.id === c.id).occurrences === 3, { label: 'normalised repost merged' });
  assert.equal((await cards()).filter((x) => x.sender.id === 111 && x.text.includes('اليوم')).length, 1);
});

test('rules engine + notifications (Telegram bot, forced channel) + standalone keyword + automation', async () => {
  const rule = await h.ok('POST', '/api/rules', { name: 'urgent', conditions: { all: [{ type: 'text', mode: 'partial', value: 'عاجل' }, { type: 'intent', value: 'graduation help' }, { type: 'confidence', gte: 80 }] }, actions: [{ type: 'create_card', priority: 'critical' }, { type: 'tag', tags: ['urgent'] }, { type: 'notify', channels: ['telegram'] }] });
  const dry = await h.ok('POST', '/api/rules/test', { text: 'عاجل احتاج مساعدة', conditions: { type: 'text', mode: 'partial', value: 'عاجل' }, actions: [{ type: 'suppress' }] }); assert.equal(dry.data.matched, true); assert.equal(dry.data.decision.suppress, true);
  await h.ok('POST', '/api/automations', { name: 'save criticals', trigger: 'high_priority_match', conditions: { type: 'field', path: 'payload.score', op: 'gte', value: 50 }, actions: [{ type: 'save' }, { type: 'tag', tags: ['auto'] }, { type: 'create_alert', title: 'High: {{payload.intent}}', severity: 'high' }] });
  await h.ok('POST', '/api/keywords', { phrase: 'سيارة للبيع', match_modes: ['exact', 'fuzzy'], min_score: 80, variants: [{ phrase: 'سياره للبيع مستعمله', kind: 'typo' }] });
  const t = 'عاجل احتاج مساعدة في مشروع التخرج'; deliver(PHONE1, msg(t, { senderId: 120, senderUsername: 'urgent_u' })); const c = await settle(t);
  assert.equal(c.priority, 'critical'); assert.ok(c.tags.includes('urgent') && c.tags.includes('auto'), JSON.stringify(c.tags)); assert.equal(c.saved, true);
  await waitFor(() => h.svc.bot.sent.length > 0, { label: 'telegram bot notification' }); const sent = h.svc.bot.sent.at(-1); assert.equal(sent.chat_id, '42'); assert.ok(sent.text.includes('CRITICAL') && sent.text.includes('t.me/'), sent.text);
  const alerts = await h.ok('GET', '/api/alerts'); assert.ok(alerts.data.some((a) => a.title.startsWith('High: Graduation Help')), 'automation create_alert rendered its template');
  deliver(PHONE1, msg('عندي سياره للبيع بحاله ممتازه', { senderId: 130, senderUsername: 'seller' })); const k = await settle('عندي سياره للبيع بحاله ممتازه');
  assert.equal(k.keyword, 'سيارة للبيع'); assert.equal(k.intent, null); assert.equal(k.rule, null);
  assert.ok((await h.ok('GET', `/api/automations`)).data[0].run_count >= 1);
  void rule;
});

test('feedback, pin/ignore, save + export, block user/source from a card, search & bucket filters', async () => {
  const id = S.c2.id;
  await h.ok('POST', `/api/matches/${id}/feedback`, { value: 'incorrect' }); await h.ok('POST', `/api/matches/${S.c1.id}/feedback`, { value: 'correct' });
  const ex = await h.db.many('SELECT label FROM feedback_examples WHERE ai_rule_id = $1 ORDER BY id', [radarId]); assert.deepEqual(ex.map((e) => e.label), ['negative', 'positive']);
  await h.ok('POST', `/api/matches/${S.c1.id}/pin`); assert.equal((await h.ok('GET', `/api/matches/${S.c1.id}`)).data.pinned, true);
  assert.equal((await cards('&buckets=100')).every((c) => c.bucket === 100 && c.score > 90), true); assert.ok((await cards('&buckets=70,80,90,100')).length >= 3);
  assert.equal((await cards('&priority=critical')).every((c) => c.priority === 'critical'), true);
  assert.ok((await h.ok('GET', '/api/search?q=التخرج&limit=5')).data.length > 0); assert.ok((await h.ok('GET', '/api/search?scope=messages&q=سيارة')).data.length > 0);
  const saved = await h.ok('POST', `/api/matches/${S.c2.id}/save`); assert.ok(saved.saved_id);
  const sv = (await h.ok('GET', '/api/saved')).data.find((s) => s.match_id === S.c2.id); await h.ok('PATCH', `/api/saved/${sv.id}`, { notes: 'follow up', tags: ['lead'] });
  const csv = await h.api('GET', '/api/export/saved?format=csv'); assert.ok(csv.text.includes('follow up') && csv.buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'CSV must carry a UTF-8 BOM so Excel renders Arabic');
  const xl = await h.api('GET', '/api/export/matches?format=xlsx'); assert.equal(xl.status, 200); assert.equal(xl.buf.subarray(0, 2).toString(), 'PK');
  assert.ok(Array.isArray(JSON.parse((await h.api('GET', '/api/export/matches?format=json')).text)));
  assert.ok((await h.api('GET', '/api/export/matches?format=pdf')).text.includes('window.print') === false && (await h.api('GET', '/api/export/matches?format=pdf')).text.includes('<table'));
  await h.ok('POST', `/api/matches/${id}/block-user`); const after = await cards(); assert.ok(!after.some((c) => c.sender.id === S.c2.sender.id), 'blocking hides existing cards at query time too');
  const blocks = await h.ok('GET', '/api/blocks'); assert.ok(blocks.users.some((u) => u.tg_user_id === S.c2.sender.id));
  await h.ok('POST', `/api/matches/${S.c1.id}/block-source`); assert.equal((await cards()).filter((c) => c.source.tg_chat_id === HUB).length, 0, 'blocked group results disappear');
  const bs = (await h.ok('GET', '/api/blocks')).sources[0]; await h.ok('DELETE', `/api/blocks/sources/${bs.id}`);
  const bu = (await h.ok('GET', '/api/blocks')).users.find((u) => u.tg_user_id === S.c2.sender.id); await h.ok('DELETE', `/api/blocks/users/${bu.id}`);
});

test('history scan task: progress, completion; analytics, tasks API, workers control, metrics', async () => {
  h.world.history.set(HUB, [1, 2, 3].map((i) => ({ chatId: HUB, kind: 'supergroup', title: 'Students Hub', tgMessageId: i, senderId: 300 + i, senderUsername: `old${i}`, senderName: `Old ${i}`, text: i === 2 ? 'ابي احد يساعدني في مشروع التخرج لو سمحتم' : `رسالة قديمة رقم ${i}`, date: new Date(Date.now() - i * 3600000) })));
  const t = await h.ok('POST', `/api/sources/${S.hub1.id}/scan`, { limit: 10 });
  const done = await waitFor(async () => { const x = (await h.ok('GET', `/api/system/tasks/${t.task.id}`)).data; return x.state === 'completed' ? x : null; }, { label: 'scan task' });
  assert.equal(done.result.scanned, 3); assert.equal(done.progress, 100);
  await settle('ابي احد يساعدني في مشروع التخرج لو سمحتم');
  await waitFor(async () => (await h.ok('GET', '/api/analytics/overview?range=24h')).totals.messages >= 6, { timeout: 20000, label: 'analytics flush' });
  const an = await h.ok('GET', '/api/analytics/overview?range=7d'); assert.ok(an.series.length > 0 && an.top.keywords.length > 0 && an.match_distribution.length > 0);
  const tasks = await h.ok('GET', '/api/system/tasks?state=completed'); assert.ok(tasks.data.length >= 2);
  const w = await h.ok('GET', '/api/system/workers'); assert.equal(w.process_online, true); assert.deepEqual(w.data.map((x) => x.status), Array(8).fill('running'));
  await h.ok('POST', '/api/system/workers/keyword/restart'); await waitFor(async () => (await h.ok('GET', '/api/system/workers')).data.find((x) => x.name === 'keyword').status === 'running', { label: 'keyword restart' });
  const noReauth = await h.api('POST', '/api/system/workers/ai/stop'); assert.equal(noReauth.status, 401); assert.equal(noReauth.body.error.code, 'REAUTH_REQUIRED');
  await h.ok('POST', '/api/system/queues/pause'); assert.equal((await h.ok('GET', '/api/system/queues')).paused, true); await h.ok('POST', '/api/system/queues/resume');
  const m = await h.api('GET', '/metrics'); assert.ok(m.text.includes('nabd_up 1') && m.text.includes('nabd_queue_jobs{queue="process"')); assert.equal((await h.api('GET', '/ready')).body.status, 'ready');
  const ov = await h.ok('GET', '/api/system/overview'); assert.equal(ov.stats.accounts_connected, 2); assert.ok(ov.stats.matches > 3 && ov.stats.ai_rules === 1); assert.equal(ov.status.telegram.status, 'online');
});

test('account lifecycle: disconnect, reconnect, connection failure -> backoff reconnect; audit trail is append-only', async () => {
  await h.ok('POST', `/api/accounts/${acc1}/disconnect`); await waitFor(async () => (await h.ok('GET', `/api/accounts/${acc1}`)).data.status === 'disconnected', { label: 'disconnected' });
  h.world.failConnect.add(PHONE1); await h.ok('POST', `/api/accounts/${acc1}/reconnect`);
  const a = await waitFor(async () => { const x = (await h.ok('GET', `/api/accounts/${acc1}`)).data; return x.reconnect_attempts >= 1 && x.status === 'disconnected' ? x : null; }, { label: 'failure recorded' }); assert.ok(a.last_error.includes('simulated'));
  h.world.failConnect.delete(PHONE1);
  await waitFor(async () => (await h.ok('GET', `/api/accounts/${acc1}`)).data.status === 'connected', { timeout: 20000, label: 'automatic reconnect' });
  const audit = await h.ok('GET', '/api/system/audit?limit=200'); const actions = new Set(audit.data.map((x) => x.action));
  for (const a2 of ['SETUP_COMPLETED', 'ADMIN_CREATED', 'ACCOUNT_ADDED', 'ACCOUNT_CONNECTED', 'ACCOUNT_DISCONNECTED', 'USER_BLOCKED', 'RULE_CREATED', 'AI_PROVIDER_CHANGED', 'SETTINGS_CHANGED', 'MATCH_FEEDBACK'].filter((x) => x !== 'SETUP_COMPLETED')) assert.ok(actions.has(a2), `audit missing ${a2}`);
  await assert.rejects(h.db.query("UPDATE audit_logs SET action = 'tampered'"), /append-only/);
  const logs = await h.ok('GET', '/api/system/logs?level=warning'); assert.ok(Array.isArray(logs.data));
});
