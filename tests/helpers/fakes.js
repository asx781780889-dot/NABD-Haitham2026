// Test doubles: a fake Telegram transport (injected through setTelegramFactory) and fake AI / Bot-API HTTP services.
import http from 'node:http';

export const world = {
  accounts: new Map(), sessions: new Map(), live: new Set(), dialogs: new Map(), history: new Map(), failConnect: new Set(), sent: [],
  reset() { this.accounts.clear(); this.sessions.clear(); this.live.clear(); this.dialogs.clear(); this.history.clear(); this.failConnect.clear(); this.sent.length = 0; },
  addAccount(phone, { userId, username, code = '12345', password = null, dialogs = [] }) { this.accounts.set(phone, { userId, username, firstName: username, code, password }); this.dialogs.set(phone, dialogs); },
};
const rpc = (m) => Object.assign(new Error(m), { errorMessage: m });

export class FakeTelegram {
  constructor({ sessionString }) { this.phone = world.sessions.get(sessionString) ?? null; this.handlers = []; this.connected = false; }
  async connect() { if (this.phone && world.failConnect.has(this.phone)) throw new Error('simulated network failure'); this.connected = true; world.live.add(this); }
  async disconnect() { this.connected = false; world.live.delete(this); }
  isConnected() { return this.connected; }
  async isAuthorized() { return !!this.phone; }
  async getMe() { if (!this.connected) throw new Error('not connected'); const a = world.accounts.get(this.phone); if (!a) throw rpc('AUTH_KEY_UNREGISTERED'); return { id: a.userId, username: a.username, firstName: a.firstName, name: a.firstName }; }
  saveSession() { const s = `fake-session-${this.phone}`; world.sessions.set(s, this.phone); return s; }
  async sendCode(phone) { if (!world.accounts.has(phone)) throw rpc('PHONE_NUMBER_INVALID'); return { phoneCodeHash: `hash-${phone}`, isCodeViaApp: true }; }
  async signIn({ phone, code }) {
    const a = world.accounts.get(phone);
    if (code !== a.code) throw rpc('PHONE_CODE_INVALID');
    if (a.password) { this.pendingPw = phone; return { needsPassword: true }; }
    this.phone = phone; return { needsPassword: false };
  }
  async signInPassword(pw) { if (pw !== world.accounts.get(this.pendingPw).password) throw rpc('PASSWORD_HASH_INVALID'); this.phone = this.pendingPw; }
  onMessage(cb) { this.handlers.push(cb); }
  async getDialogs() { return world.dialogs.get(this.phone) ?? []; }
  async getMessages(chatId, { limit = 50, minId = 0, offsetId = 0 } = {}) {
    return (world.history.get(chatId) ?? []).filter((m) => m.tgMessageId > minId && (!offsetId || m.tgMessageId < offsetId)).sort((a, b) => b.tgMessageId - a.tgMessageId).slice(0, limit);
  }
  async sendMessage(target, text) { world.sent.push({ phone: this.phone, target, text }); }
}
export const fakeFactory = (opts) => new FakeTelegram(opts);
let mid = 1000;
export function deliver(phone, msg) {
  let n = 0;
  for (const a of world.live) if (a.phone === phone) { n++; for (const cb of a.handlers) cb({ isOutgoing: false, hasMedia: false, replyToId: null, date: new Date(), kind: 'supergroup', tgMessageId: msg.tgMessageId ?? ++mid, ...msg }); }
  return n;
}
export const dropConnection = (phone) => { for (const a of [...world.live]) if (a.phone === phone) { a.connected = false; world.live.delete(a); } };

export async function startFakeServices() {
  const st = { ai: { mode: 'ok', calls: 0, drafts: 0, lastUser: '' }, bot: { sent: [] } };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.includes('/bot') && req.url.endsWith('/sendMessage')) { st.bot.sent.push(JSON.parse(raw)); return json(200, { ok: true, result: {} }); }
    if (req.url.endsWith('/models')) return json(200, { data: [{ id: 'fake-model' }, { id: 'fake-model-2' }] });
    if (!req.url.endsWith('/chat/completions')) return json(404, { error: { message: 'not found' } });
    st.ai.calls++;
    if (st.ai.mode === 'fail') return json(500, { error: { message: 'simulated provider outage' } });
    if (st.ai.mode === 'rate') { res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'rate limited' } })); }
    const j = JSON.parse(raw); const system = j.messages[0].content; const user = j.messages.at(-1).content; st.ai.lastUser = user;
    let content;
    if (system.includes('Telegram monitoring radar')) { st.ai.drafts++; content = JSON.stringify({ name: 'Graduation help', intent: 'Graduation Help', intent_description: 'People asking for help with graduation projects', language: 'ar', signals: ['احتاج مساعدة في مشروع التخرج', 'ابي احد يساعدني في مشروع التخرج', 'من يساعدني في مشروع التخرج', 'عندي مشروع تخرج', 'احتاج شخص يفهم في مشروع التخرج'], negative_signals: ['نقدم خدمات مشاريع التخرج'], min_score: 70, priority_hint: 'high', context_mode: 'none' }); }
    else if (system.includes('improve a Telegram monitoring radar')) content = JSON.stringify({ new_signals: ['مين يقدر يساعدني بمشروع التخرج'], negative_signals: [], min_score_suggestion: 75, notes: 'ok' });
    else if (system.includes('{"ok":true}')) content = '{"ok":true}';
    else {
      const m = /<message>\n([\s\S]*?)\n<\/message>/.exec(user)?.[1] ?? '';
      const isMatch = /تخرج|graduation/i.test(m) && /(مساعد|ساعد|احتاج|محتاج|ابي|اريد|يقدر|help)/.test(m) && !/نقدم|نوفر|we offer/.test(m);
      content = JSON.stringify({ match: isMatch, confidence: isMatch ? 92 : 90, intent: 'Graduation Help', category: isMatch ? 'request' : 'other', priority: 'high', entities: [{ type: 'topic', value: 'graduation project' }], reason: isMatch ? 'الرسالة تطلب مساعدة في مشروع تخرج' : 'لا علاقة بمشروع التخرج', suggested_keywords: isMatch ? ['مين يقدر يساعدني بمشروع التخرج'] : [], summary: '' });
    }
    return json(200, { choices: [{ message: { content } }], usage: { prompt_tokens: 40, completion_tokens: 25 } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { ...st, url, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
