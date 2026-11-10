// Batched, idempotent message ingestion: DB first (no data loss), then queue. Survives DB/Redis outages.
import { query } from '../lib/db.js';
import { enqueue, Q } from '../lib/queue.js';
import { getSetting } from '../lib/settings.js';
import { detectLang } from '../engine/normalize.js';
import { backoff } from '../lib/resilience.js';
import { logger } from '../lib/logger.js';

const log = logger('ingest');
const MAX_BUFFER = 5000;

export async function insertMessages(rows) {
  const g = (f) => rows.map((r) => r[f]);
  const res = await query(
    `INSERT INTO messages (account_id, source_id, tg_chat_id, tg_message_id, sender_id, sender_username, sender_name, text, lang, has_media, reply_to_id, sent_at)
     SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::bigint[], $5::bigint[], $6::text[], $7::text[], $8::text[], $9::text[], $10::boolean[], $11::bigint[], $12::timestamptz[])
     ON CONFLICT (account_id, tg_chat_id, tg_message_id) DO NOTHING RETURNING id, source_id`,
    [g('accountId'), g('sourceId'), g('chatId'), g('tgMessageId'), g('senderId'), g('senderUsername'), g('senderName'), g('text'), rows.map((r) => detectLang(r.text)), rows.map((r) => !!r.hasMedia), g('replyToId'), rows.map((r) => r.date)],
  );
  const bySource = new Map();
  for (const r of rows) { const o = bySource.get(r.sourceId) ?? { mid: 0, at: 0 }; o.mid = Math.max(o.mid, r.tgMessageId); o.at = Math.max(o.at, +new Date(r.date)); bySource.set(r.sourceId, o); }
  // Always lock/update source rows in the same order across concurrent ingestors.
  const ids = [...bySource.keys()].sort((a, b) => Number(a) - Number(b));
  await query(
    `UPDATE telegram_sources s SET last_tg_message_id = GREATEST(COALESCE(s.last_tg_message_id, 0), v.mid), last_message_at = GREATEST(COALESCE(s.last_message_at, 'epoch'), v.at)
       FROM unnest($1::bigint[], $2::bigint[], $3::timestamptz[]) AS v(id, mid, at) WHERE s.id = v.id`,
    [ids, ids.map((i) => bySource.get(i).mid), ids.map((i) => new Date(bySource.get(i).at))],
  );
  return res.rows.map((r) => r.id);
}

export class Ingestor {
  constructor({ flushMs = 250, maxBatch = 100 } = {}) { Object.assign(this, { flushMs, maxBatch, buf: [], timer: null, failures: 0, dropped: 0, inserted: 0, inflight: null }); }
  push(m) {
    this.buf.push(m);
    if (this.buf.length >= this.maxBatch) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.flushMs);
  }
  flush() {
    if (this.inflight) return this.inflight;
    const p = this._flush();
    this.inflight = p;
    p.finally(() => { if (this.inflight === p) this.inflight = null; }).catch(() => {});
    return p;
  }
  async _flush() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.buf.length) return 0;
    const rows = this.buf.splice(0, this.maxBatch);
    try {
      if (await getSetting('database.emergency_active') && await getSetting('database.emergency_pause_ingest')) {
        this.dropped += rows.length; log.error('ingestion paused: database in emergency mode', { dropped: rows.length }); return 0;
      }
      const ids = await insertMessages(rows);
      this.failures = 0; this.inserted += ids.length;
      for (const id of ids) await enqueue(Q.process, 'process', { messageId: id }, { jobId: `m-${id}-0` }); // false => stays pending; sweeper handles it
      if (this.buf.length) void this.flush();
      return ids.length;
    } catch (e) {
      this.failures++;
      this.buf.unshift(...rows);
      if (this.buf.length > MAX_BUFFER) { const over = this.buf.length - MAX_BUFFER; this.buf.splice(0, over); this.dropped += over; }
      log.error('ingest flush failed, will retry', { err: e.message, buffered: this.buf.length, failures: this.failures });
      this.timer = setTimeout(() => void this.flush(), backoff(this.failures, 1000, 30000));
      return 0;
    }
  }
  stats() { return { buffered: this.buf.length, inserted: this.inserted, dropped: this.dropped, failures: this.failures }; }
}
