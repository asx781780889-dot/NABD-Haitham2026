// Append-only audit trail for every important operation.
import { query } from './db.js';
import { logger } from './logger.js';

const log = logger('audit');
/** ctx can be an express request or {user, ip, reqId}. */
export async function audit(ctx, action, { entity = null, entityId = null, result = 'success', details = null } = {}) {
  try {
    const u = ctx?.user;
    await query(
      `INSERT INTO audit_logs (user_id, username, action, entity, entity_id, result, ip, user_agent, request_id, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [u?.id ?? null, u?.username ?? ctx?.username ?? 'system', action, entity, entityId == null ? null : String(entityId), result,
        ctx?.ip ?? null, ctx?.headers?.['user-agent']?.slice(0, 200) ?? null, ctx?.id ?? ctx?.reqId ?? null, details ? JSON.stringify(details) : null],
    );
  } catch (e) { log.error('audit write failed', { action, err: e }); }
}
