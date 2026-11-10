// Automation engine: Trigger -> Conditions -> Actions. Idempotent per (automation, trigger reference).
import { one, many, query } from '../lib/db.js';
import { evalNode, CHANNELS } from '../engine/conditions.js';
import { createAlert, notifyMatch } from './notifier.js';
import { saveMatch } from './saved.js';
import { blockUser } from './blocks.js';
import { hydrateCards } from './cards.js';
import { logger } from '../lib/logger.js';

const log = logger('automation');
export const TRIGGERS = ['new_message', 'new_match', 'high_priority_match', 'account_connected', 'account_disconnected', 'ai_failure', 'worker_down', 'job_failed', 'db_threshold'];
let cache = { at: 0, rows: [] };
export const invalidateAutomations = () => { cache.at = 0; };
async function enabled() {
  if (Date.now() - cache.at > 10000) cache = { at: Date.now(), rows: await many('SELECT * FROM automations WHERE enabled AND deleted_at IS NULL ORDER BY id') };
  return cache.rows;
}
export const render = (tpl, data) => String(tpl ?? '').replace(/\{\{\s*([a-zA-Z0-9_.]{1,60})\s*\}\}/g, (_, p) => String(p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data) ?? '').slice(0, 300));

async function runActions(actions, { payload, matchId }) {
  const out = [];
  for (const a of actions) {
    switch (a.type) {
      case 'create_alert': await createAlert({ title: render(a.title || 'Automation alert', { payload }), body: render(a.body, { payload }), severity: a.severity ?? 'info', kind: 'automation' }); break;
      case 'notify': {
        const chans = new Set(a.channels?.length ? a.channels : CHANNELS);
        if (matchId) { const [card] = await hydrateCards([matchId]); if (card) await notifyMatch(card, chans, { onlyForced: true }); }
        else await createAlert({ title: render(a.title || payload.title || 'Notification', { payload }), body: render(a.body || payload.body, { payload }), severity: a.severity ?? 'info', kind: 'automation', channels: [...chans] });
        break;
      }
      case 'save': if (matchId) await saveMatch(matchId, {}); break;
      case 'tag': if (matchId && a.tags?.length) await query('UPDATE message_matches SET tags = ARRAY(SELECT DISTINCT unnest(tags || $2::text[])) WHERE id = $1', [matchId, a.tags]); break;
      case 'set_priority': if (matchId && (a.value || a.priority)) await query('UPDATE message_matches SET priority = $2 WHERE id = $1', [matchId, a.value ?? a.priority]); break;
      case 'suppress': if (matchId) await query("UPDATE message_matches SET status = 'ignored' WHERE id = $1", [matchId]); break;
      case 'block_user': if (payload.senderId) await blockUser({ tgUserId: payload.senderId, username: payload.senderUsername ?? null, reason: 'automation' }); break;
      case 'pause_source': if (payload.sourceId) await query('UPDATE telegram_sources SET monitoring_enabled = false WHERE id = $1', [payload.sourceId]); break;
      default: break; // create_card is a rules-engine action
    }
    out.push(a.type);
  }
  return out;
}

/** payload should contain a stable id (matchId / messageId / accountId / jobId ...) used for idempotency. */
export async function fireTrigger(trigger, payload = {}, { evalCtx = {}, ref } = {}) {
  let list;
  try { list = (await enabled()).filter((a) => a.trigger === trigger); } catch { return 0; }
  let ran = 0;
  for (const a of list) {
    try {
      if (!evalNode(a.conditions, { ...evalCtx, payload }).ok) continue;
      const key = `${trigger}:${ref ?? payload.matchId ?? payload.messageId ?? payload.id ?? Date.now()}`;
      const run = await one('INSERT INTO automation_runs (automation_id, dedupe_key, trigger_ref) VALUES ($1,$2,$3) ON CONFLICT (automation_id, dedupe_key) DO NOTHING RETURNING id', [a.id, key, JSON.stringify({ trigger, ...Object.fromEntries(Object.entries(payload).filter(([, v]) => typeof v !== 'object')) })]);
      if (!run) continue;
      try {
        const result = await runActions(a.actions, { payload, matchId: payload.matchId });
        await query("UPDATE automation_runs SET status = 'success', result = $2, finished_at = now() WHERE id = $1", [run.id, JSON.stringify(result)]);
      } catch (e) { await query("UPDATE automation_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [run.id, String(e.message).slice(0, 300)]); log.warn('automation action failed', { automation: a.id, err: e.message }); }
      await query('UPDATE automations SET run_count = run_count + 1, last_run_at = now() WHERE id = $1', [a.id]);
      ran++;
    } catch (e) { log.warn('automation evaluation failed', { automation: a.id, err: e.message }); }
  }
  return ran;
}
