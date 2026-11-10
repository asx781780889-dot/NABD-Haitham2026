// Thin adapter over GramJS (MTProto user client). Everything above this file is library-agnostic and testable with a fake.
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { getPeerId } from 'telegram/Utils.js';
import { AppError } from '../lib/errors.js';

const FATAL_AUTH = /AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|AUTH_KEY_DUPLICATED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|USER_DEACTIVATED_BAN/;
const msgOf = (e) => String(e?.errorMessage || e?.message || e);
export const isFatalAuth = (e) => FATAL_AUTH.test(msgOf(e));
export const floodSeconds = (e) => (e?.seconds ? Number(e.seconds) : (/FLOOD_WAIT_(\d+)/.exec(msgOf(e)) ? Number(/FLOOD_WAIT_(\d+)/.exec(msgOf(e))[1]) : null));

export function mapTelegramError(e) {
  if (e instanceof AppError) return e;
  const m = msgOf(e); const fs = floodSeconds(e);
  if (fs) return new AppError('TELEGRAM_FLOOD', { status: 429, details: { seconds: fs }, cause: e });
  if (/PHONE_CODE_INVALID/.test(m)) return new AppError('TELEGRAM_CODE_INVALID', { cause: e });
  if (/PHONE_CODE_EXPIRED|PHONE_CODE_EMPTY/.test(m)) return new AppError('TELEGRAM_CODE_EXPIRED', { cause: e });
  if (/PASSWORD_HASH_INVALID/.test(m)) return new AppError('TELEGRAM_PASSWORD_INVALID', { cause: e });
  if (/PHONE_NUMBER_INVALID|PHONE_NUMBER_BANNED|API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(m)) return new AppError('VALIDATION', { message: m, cause: e });
  if (FATAL_AUTH.test(m)) return new AppError('TELEGRAM_AUTH', { status: 401, cause: e });
  return new AppError('TELEGRAM_UNAVAILABLE', { status: 503, cause: e, message: m.slice(0, 200) });
}

const big = (x) => (x == null ? null : Number(x.toString()));
const fullName = (u) => [u?.firstName, u?.lastName].filter(Boolean).join(' ') || u?.username || null;

function describeEntity(chat, peer) {
  if (chat instanceof Api.Channel) return { kind: chat.megagroup ? 'supergroup' : 'channel', title: chat.title, username: chat.username ?? null, members: chat.participantsCount ?? null };
  if (chat instanceof Api.Chat) return { kind: 'group', title: chat.title, username: null, members: chat.participantsCount ?? null };
  if (chat instanceof Api.User) return { kind: chat.self ? 'saved' : 'private', title: chat.self ? 'Saved Messages' : fullName(chat), username: chat.username ?? null, members: null };
  if (peer instanceof Api.PeerChannel) return { kind: 'channel', title: null, username: null, members: null };
  if (peer instanceof Api.PeerChat) return { kind: 'group', title: null, username: null, members: null };
  return { kind: 'private', title: null, username: null, members: null };
}

async function normalizeMessage(m) {
  const chatId = Number(getPeerId(m.peerId));
  let chat = null; let sender = null;
  try { chat = await m.getChat(); } catch { /* entity not cached: fall back to peer type */ }
  const d = describeEntity(chat, m.peerId);
  if (d.kind !== 'channel') { try { sender = await m.getSender(); } catch { /* ignore */ } }
  return {
    chatId, kind: d.kind, title: d.title ?? (d.kind === 'private' ? fullName(sender) : null), username: d.username, members: d.members,
    tgMessageId: m.id, senderId: d.kind === 'channel' ? null : big(m.senderId), senderUsername: d.kind === 'channel' ? null : sender?.username ?? null, senderName: d.kind === 'channel' ? d.title : fullName(sender),
    text: m.message ?? '', hasMedia: !!m.media, replyToId: m.replyTo?.replyToMsgId ?? null, date: new Date((m.date ?? Math.floor(Date.now() / 1000)) * 1000), isOutgoing: !!m.out,
  };
}

export class GramAdapter {
  constructor({ apiId, apiHash, sessionString = '' }) {
    this.creds = { apiId: Number(apiId), apiHash };
    this.client = new TelegramClient(new StringSession(sessionString), this.creds.apiId, apiHash, {
      connectionRetries: 5, retryDelay: 2000, autoReconnect: true, floodSleepThreshold: 20, requestRetries: 3,
      deviceModel: 'NABD AI', systemVersion: 'Linux', appVersion: '1.0', baseLogger: new Logger(LogLevel.ERROR),
    });
  }
  async connect() { await this.client.connect(); }
  async disconnect() { try { await this.client.disconnect(); } finally { try { await this.client.destroy(); } catch { /* already closed */ } } }
  isConnected() { return !!this.client.connected; }
  async isAuthorized() { return this.client.checkAuthorization(); }
  async getMe() { const u = await this.client.getMe(); return { id: big(u.id), username: u.username ?? null, firstName: u.firstName ?? null, name: fullName(u) }; }
  saveSession() { return this.client.session.save(); }
  async sendCode(phone) { return this.client.sendCode(this.creds, phone); }
  /** Returns {needsPassword}. Wrong/expired codes throw RPC errors (mapped by mapTelegramError). */
  async signIn({ phone, code, phoneCodeHash }) {
    try { await this.client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code })); return { needsPassword: false }; }
    catch (e) { if (/SESSION_PASSWORD_NEEDED/.test(msgOf(e))) return { needsPassword: true }; throw e; }
  }
  async signInPassword(password) {
    let captured = null;
    try { await this.client.signInWithPassword(this.creds, { password: async () => password, onError: async (err) => { captured = err; return true; } }); }
    catch (e) { throw captured ?? e; }
  }
  onMessage(cb) {
    this.client.addEventHandler(async (ev) => { try { cb(await normalizeMessage(ev.message)); } catch { /* one bad update must never stop the stream */ } }, new NewMessage({ incoming: true }));
  }
  /** Read the complete dialog list; iterDialogs follows Telegram pagination. */
  async getDialogs(limit = null) {
    const out = [];
    const options = limit > 0 ? { limit } : {};
    for await (const dlg of this.client.iterDialogs(options)) {
      const e = dlg.entity; if (!e || e.deleted) continue;
      const chatId = Number(getPeerId(e)); const d = describeEntity(e, null);
      out.push({ chatId, kind: d.kind, title: dlg.title || dlg.name || d.title, username: d.username, members: d.members });
    }
    return out;
  }
  async getMessages(chatId, { limit = 50, minId = 0, offsetId = 0 } = {}) {
    const res = await this.client.getMessages(chatId, { limit, minId, offsetId });
    const out = [];
    for (const m of res) if (m && m.message !== undefined) out.push(await normalizeMessage(m));
    return out;
  }
  async sendMessage(target, text) { await this.client.sendMessage(target, { message: text, linkPreview: false }); }
  async logOut() { await this.client.invoke(new Api.auth.LogOut()); }
}

let factory = (opts) => new GramAdapter(opts);
export const createTelegramClient = (opts) => factory(opts);
/** Dependency injection point (tests install a fake transport here). */
export const setTelegramFactory = (fn) => { factory = fn; };
