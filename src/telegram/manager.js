// Owns the long-lived Telegram connections (worker process). Safe reconnects with capped exponential backoff, no infinite loops.
import { one, many, query } from '../lib/db.js';
import { getSetting } from '../lib/settings.js';
import { publish } from '../lib/bus.js';
import { backoff, sleep, withTimeout } from '../lib/resilience.js';
import { AppError } from '../lib/errors.js';
import { createTelegramClient, isFatalAuth, floodSeconds, mapTelegramError } from './adapter.js';
import { loadAccountSecrets } from '../services/accounts.js';
import { createAlert } from '../services/notifier.js';
import { fireTrigger } from '../services/automation.js';
import { logger } from '../lib/logger.js';

const log = logger('telegram');

export class TelegramManager {
  constructor({ ingestor }) {
    this.ingestor = ingestor; this.clients = new Map(); this.locks = new Set(); this.timers = new Map(); this.stopped = true; this.startTimers = [];
  }

  async start() {
    this.stopped = false;
    if (!(await getSetting('telegram.autostart_accounts'))) return;
    const rows = await many(`SELECT a.id FROM telegram_accounts a JOIN telegram_sessions s ON s.account_id = a.id AND s.is_active
      WHERE a.deleted_at IS NULL AND a.enabled AND a.status <> 'auth_required' ORDER BY a.id`);
    rows.forEach((r, i) => this.startTimers.push(setTimeout(() => this.connect(r.id).catch(() => {}), i * 2000)));
  }
  async stop() {
    this.stopped = true;
    for (const t of [...this.startTimers, ...this.timers.values()]) clearTimeout(t);
    this.startTimers = []; this.timers.clear();
    await Promise.all([...this.clients.keys()].map((id) => this.dropClient(id)));
    await this.ingestor.flush();
  }

  snapshot() {
    return { connected: [...this.clients.keys()], count: this.clients.size, pending_reconnects: [...this.timers.keys()] };
  }
  async setStatus(id, status, err = null, extra = {}) {
    await query(`UPDATE telegram_accounts SET status = $2, last_error = COALESCE($3, CASE WHEN $2 = 'connected' THEN NULL ELSE last_error END),
        last_error_at = CASE WHEN $3 IS NOT NULL THEN now() ELSE last_error_at END, reconnect_attempts = COALESCE($4, reconnect_attempts), cooldown_until = $5 WHERE id = $1`,
      [id, status, err ? String(err).slice(0, 300) : null, extra.attempts ?? null, extra.cooldownUntil ?? null]);
    await publish('account.status', { id, status });
  }

  async dropClient(id) {
    const e = this.clients.get(id); this.clients.delete(id);
    if (e) { clearInterval(e.watchdog); clearInterval(e.refresh); try { await e.adapter.disconnect(); } catch { /* already gone */ } }
  }

  async connect(id) {
    if (this.stopped || this.locks.has(id)) return;
    this.locks.add(id); clearTimeout(this.timers.get(id)); this.timers.delete(id);
    try {
      const acc = await loadAccountSecrets(id);
      if (!acc || !acc.enabled) return;
      if (!acc.session) throw Object.assign(new Error('AUTH_KEY_UNREGISTERED'), { errorMessage: 'AUTH_KEY_UNREGISTERED' });
      await this.setStatus(id, 'connecting');
      await this.dropClient(id);
      const adapter = createTelegramClient({ apiId: acc.apiId, apiHash: acc.apiHash, sessionString: acc.session });
      await withTimeout(adapter.connect(), 30000, 'telegram connect');
      if (!(await withTimeout(adapter.isAuthorized(), 20000, 'authorization check'))) throw Object.assign(new Error('AUTH_KEY_UNREGISTERED'), { errorMessage: 'AUTH_KEY_UNREGISTERED' });
      const me = await withTimeout(adapter.getMe(), 20000, 'getMe');
      const entry = { id, adapter, sources: new Map(), failures: 0, connectedAt: Date.now() };
      this.clients.set(id, entry);
      adapter.onMessage((m) => { this.onMessage(id, m).catch((e) => log.debug('message handling failed', { err: e.message })); });
      await this.loadSources(id);
      await query("UPDATE telegram_accounts SET tg_user_id = $2, tg_username = $3, tg_first_name = $4, last_connected_at = now() WHERE id = $1", [id, me.id, me.username, me.firstName]);
      await this.setStatus(id, 'connected', null, { attempts: 0 });
      log.info('telegram account connected', { accountId: id });
      void fireTrigger('account_connected', { id, accountId: id, name: acc.name }, { ref: `${id}:${Date.now()}` });
      const ping = (Number(process.env.NABD_PING_S) || Math.max(10, await getSetting('telegram.ping_interval_s'))) * 1000;
      entry.watchdog = setInterval(() => this.watch(id), ping + Math.floor(Math.random() * 3000));
      entry.refresh = setInterval(() => this.loadSources(id).catch(() => {}), 60000);
      this.syncDialogs(id).then(() => this.catchUp(id)).catch((e) => log.warn('post-connect sync failed', { accountId: id, err: e.message }));
    } catch (e) { await this.handleFailure(id, e); } finally { this.locks.delete(id); }
  }

  async watch(id) {
    const e = this.clients.get(id); if (!e || this.locks.has(id)) return;
    try { await withTimeout(e.adapter.getMe(), 20000, 'ping'); e.failures = 0; }
    catch (err) { e.failures++; if (isFatalAuth(err) || e.failures >= 2 || !e.adapter.isConnected()) await this.handleFailure(id, err); }
  }

  async handleFailure(id, err) {
    if (this.stopped) return;
    const msg = String(err?.errorMessage || err?.message || err).slice(0, 250);
    await this.dropClient(id);
    const acc = await one('SELECT name, reconnect_attempts, status FROM telegram_accounts WHERE id = $1', [id]);
    if (!acc) return;
    if (isFatalAuth(err)) {
      await this.setStatus(id, 'auth_required', msg);
      await createAlert({ title: `Telegram account "${acc.name}" needs to sign in again`, body: msg, severity: 'high', kind: 'account', dedupeKey: `acc-auth:${id}:${new Date().toISOString().slice(0, 13)}`, channels: ['telegram'] });
      void fireTrigger('account_disconnected', { id, accountId: id, name: acc.name, reason: 'auth_required' }, { ref: `${id}:auth:${Date.now()}` });
      return;
    }
    const attempts = acc.reconnect_attempts + 1; const max = await getSetting('telegram.reconnect_max_attempts');
    const flood = floodSeconds(err);
    if (attempts > max) {
      await this.setStatus(id, 'error', `reconnect attempts exhausted: ${msg}`, { attempts });
      await createAlert({ title: `Telegram account "${acc.name}" is offline`, body: `Gave up after ${max} reconnect attempts: ${msg}`, severity: 'high', kind: 'account', dedupeKey: `acc-down:${id}:${new Date().toISOString().slice(0, 13)}`, channels: ['telegram'] });
      void fireTrigger('account_disconnected', { id, accountId: id, name: acc.name, reason: 'reconnect_exhausted' }, { ref: `${id}:down:${Date.now()}` });
      return;
    }
    const base = await getSetting('telegram.reconnect_base_ms');
    const delay = Math.max(flood ? flood * 1000 + 1000 : 0, backoff(attempts - 1, base, 15 * 60 * 1000));
    await this.setStatus(id, 'disconnected', msg, { attempts, cooldownUntil: new Date(Date.now() + delay) });
    log.warn('telegram connection failed; scheduling reconnect', { accountId: id, attempts, delayMs: delay, err: msg });
    this.timers.set(id, setTimeout(() => this.connect(id).catch(() => {}), delay));
  }

  async disconnect(id, status = 'disconnected') {
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    await this.dropClient(id);
    await this.setStatus(id, status);
  }
  async reconnect(id) { await query('UPDATE telegram_accounts SET reconnect_attempts = 0 WHERE id = $1', [id]); await this.dropClient(id); return this.connect(id); }

  async loadSources(id) {
    const e = this.clients.get(id); if (!e) return;
    const rows = await many('SELECT * FROM telegram_sources WHERE account_id = $1 AND deleted_at IS NULL', [id]);
    e.sources = new Map(rows.map((r) => [r.tg_chat_id, r]));
  }
  async ensureSource(id, m) {
    const auto = await getSetting('telegram.auto_monitor_new_sources');
    const monitoringEnabled = ['group', 'supergroup'].includes(m.kind) || auto;
    const row = await one(`INSERT INTO telegram_sources (account_id, tg_chat_id, kind, title, username, monitoring_enabled) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (account_id, tg_chat_id) DO UPDATE SET deleted_at = NULL, title = COALESCE(EXCLUDED.title, telegram_sources.title), username = COALESCE(EXCLUDED.username, telegram_sources.username),
        monitoring_enabled = CASE WHEN EXCLUDED.kind IN ('group','supergroup') THEN true ELSE telegram_sources.monitoring_enabled END
      RETURNING *`, [id, m.chatId, m.kind, m.title, m.username, monitoringEnabled]);
    this.clients.get(id)?.sources.set(m.chatId, row);
    return row;
  }
  async onMessage(id, m) {
    const e = this.clients.get(id); if (!e) return;
    if (m.isOutgoing && m.kind !== 'saved') return;
    if (!m.text || !m.text.trim()) return;
    const src = e.sources.get(m.chatId) ?? await this.ensureSource(id, m);
    if (!src.monitoring_enabled) return;
    this.ingestor.push({ accountId: id, sourceId: src.id, chatId: m.chatId, tgMessageId: m.tgMessageId, senderId: m.senderId, senderUsername: m.senderUsername, senderName: m.senderName, text: m.text, hasMedia: m.hasMedia, replyToId: m.replyToId, date: m.date });
  }

  /** Lists the account's dialogs and applies the automatic monitoring policy to every source kind. */
  async syncDialogs(id) {
    const e = this.clients.get(id);
    if (!e) throw new AppError('TELEGRAM_UNAVAILABLE', { status: 409, message: 'account is not connected' });
    // The adapter paginates through the complete Telegram dialog list.
    const dialogs = await e.adapter.getDialogs();
    const auto = await getSetting('telegram.auto_monitor_new_sources');
    const g = (f) => dialogs.map((d) => d[f]);
    const monitoring = dialogs.map((d) => ['group', 'supergroup'].includes(d.kind) || auto);
    const res = await query(`INSERT INTO telegram_sources (account_id, tg_chat_id, kind, title, username, members_count, monitoring_enabled)
      SELECT $1, v.chat_id, v.kind, v.title, v.username, v.members, v.monitoring_enabled
        FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[], $6::int[], $7::boolean[]) AS v(chat_id, kind, title, username, members, monitoring_enabled)
      ON CONFLICT (account_id, tg_chat_id) DO UPDATE SET kind = EXCLUDED.kind, title = COALESCE(EXCLUDED.title, telegram_sources.title), username = EXCLUDED.username,
        deleted_at = NULL,
        members_count = EXCLUDED.members_count,
        monitoring_enabled = CASE WHEN EXCLUDED.kind IN ('group','supergroup') THEN true ELSE telegram_sources.monitoring_enabled END
      RETURNING (xmax = 0) AS inserted`, [id, g('chatId'), g('kind'), g('title'), g('username'), g('members'), monitoring]);
    const count = (ks) => dialogs.filter((d) => ks.includes(d.kind)).length;
    await query('UPDATE telegram_accounts SET groups_count = $2, channels_count = $3, chats_count = $4 WHERE id = $1', [id, count(['group', 'supergroup']), count(['channel']), count(['private', 'saved'])]);
    await this.loadSources(id); await publish('account.status', { id });
    return { total: dialogs.length, added: res.rows.filter((r) => r.inserted).length, groups: count(['group', 'supergroup']), channels: count(['channel']), chats: count(['private', 'saved']) };
  }

  /** After (re)connect: fetch a bounded number of missed messages per monitored source, politely rate limited. */
  async catchUp(id) {
    const [per, delay] = await Promise.all([getSetting('telegram.catchup_per_source'), getSetting('telegram.catchup_delay_ms')]);
    if (!per) return 0;
    const rows = await many('SELECT id, tg_chat_id, last_tg_message_id FROM telegram_sources WHERE account_id = $1 AND monitoring_enabled AND deleted_at IS NULL AND last_tg_message_id IS NOT NULL ORDER BY last_message_at DESC NULLS LAST LIMIT 200', [id]);
    let n = 0;
    for (const s of rows) {
      const e = this.clients.get(id); if (!e || this.stopped) break;
      try {
        const msgs = await e.adapter.getMessages(s.tg_chat_id, { limit: per, minId: s.last_tg_message_id });
        for (const m of msgs.reverse()) if (m.text?.trim() && !m.isOutgoing) { this.ingestor.push({ accountId: id, sourceId: s.id, chatId: m.chatId, tgMessageId: m.tgMessageId, senderId: m.senderId, senderUsername: m.senderUsername, senderName: m.senderName, text: m.text, hasMedia: m.hasMedia, replyToId: m.replyToId, date: m.date }); n++; }
      } catch (err) { const fs = floodSeconds(err); if (fs) { await sleep(Math.min(fs, 60) * 1000); } else log.debug('catch-up skipped a source', { source: s.id, err: err.message }); }
      await sleep(delay);
    }
    if (n) log.info('catch-up queued missed messages', { accountId: id, count: n });
    return n;
  }

  async test(id) {
    const e = this.clients.get(id);
    if (!e) throw new AppError('TELEGRAM_UNAVAILABLE', { status: 409, message: 'account is not connected' });
    const t = Date.now();
    try { const me = await withTimeout(e.adapter.getMe(), 20000, 'getMe'); return { ok: true, latency_ms: Date.now() - t, me }; } catch (err) { throw mapTelegramError(err); }
  }
  async sendToSelf(id, text) {
    const e = this.clients.get(id);
    if (!e) throw new AppError('TELEGRAM_UNAVAILABLE', { status: 503, message: 'account is not connected' });
    await e.adapter.sendMessage('me', text);
  }

  /** Task handler: scan the latest N messages of a source through the normal pipeline (cancel/pause/resume aware). */
  async scanHistory(job, h) {
    const { sourceId, limit = 200 } = job.payload;
    const src = await one('SELECT * FROM telegram_sources WHERE id = $1 AND deleted_at IS NULL', [sourceId]);
    if (!src) throw new AppError('NOT_FOUND', { status: 404 });
    const e = this.clients.get(src.account_id);
    if (!e) throw new AppError('TELEGRAM_UNAVAILABLE', { status: 409, message: 'account is not connected' });
    const delay = await getSetting('telegram.catchup_delay_ms');
    let offsetId = job.checkpoint?.offsetId ?? 0; let done = job.checkpoint?.done ?? 0;
    while (done < limit) {
      const batch = await e.adapter.getMessages(src.tg_chat_id, { limit: Math.min(100, limit - done), offsetId });
      if (!batch.length) break;
      for (const m of batch) if (m.text?.trim()) this.ingestor.push({ accountId: src.account_id, sourceId: src.id, chatId: m.chatId, tgMessageId: m.tgMessageId, senderId: m.senderId, senderUsername: m.senderUsername, senderName: m.senderName, text: m.text, hasMedia: m.hasMedia, replyToId: m.replyToId, date: m.date });
      offsetId = Math.min(...batch.map((m) => m.tgMessageId)); done += batch.length;
      await this.ingestor.flush();
      await h.checkpoint(Math.round((done / limit) * 100), { offsetId, done });
      await sleep(delay);
    }
    return { scanned: done };
  }

  async command({ action, id }) {
    if (!id) return;
    if (action === 'connect') return this.connect(id);
    if (action === 'disconnect') return this.disconnect(id);
    if (action === 'reconnect') return this.reconnect(id);
    if (action === 'refresh_sources') return this.loadSources(id);
    if (action === 'remove') { await this.disconnect(id, 'disabled'); }
  }
}
