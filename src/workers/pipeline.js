// Message pipeline stages: process (claim/normalize/block) -> keyword (engine) -> ai (semantic) -> decide (rules/dedupe/cards/notify).
// Every stage is idempotent and derives its inputs from the database, so any stage can be retried or run inline.
import { one, many, query } from '../lib/db.js';
import { getSetting, getSettings } from '../lib/settings.js';
import { enqueue, Q } from '../lib/queue.js';
import { analyze, normalizeText } from '../engine/normalize.js';
import { evaluateKeywords, radarPrefilter, quickMatch } from '../engine/keywords.js';
import { computePriority, priorityAtLeast } from '../engine/priority.js';
import { evalNode, applyDecisionActions, newDecision } from '../engine/conditions.js';
import { fingerprint } from '../engine/dedupe.js';
import { getCompiled } from '../services/config-cache.js';
import { checkBlocked } from '../services/blocks.js';
import { persistCard } from '../services/matches.js';
import { hydrateCards } from '../services/cards.js';
import { notifyMatch } from '../services/notifier.js';
import { saveMatch } from '../services/saved.js';
import { fireTrigger } from '../services/automation.js';
import { bump, bumpRadar, bumpKeyword } from '../services/stats.js';
import { analyzeForRadar } from '../ai/analyzer.js';
import { aiAvailable } from '../ai/manager.js';
import { logger } from '../lib/logger.js';

const log = logger('pipeline');
const TYPE_AR = { exact: 'مطابق تمامًا', partial: 'جزئي', fuzzy: 'تقريبي', synonym: 'مرادف', semantic: 'دلالي', rule: 'قاعدة' };

async function loadContext(messageId) {
  const row = await one(
    `SELECT m.*, s.kind AS s_kind, s.title AS s_title, s.username AS s_username, s.monitoring_enabled AS s_monitor, s.priority_weight AS s_weight,
            s.ai_rule_ids AS s_radars, s.keyword_ids AS s_keywords, s.deleted_at AS s_deleted, a.name AS a_name
       FROM messages m JOIN telegram_sources s ON s.id = m.source_id JOIN telegram_accounts a ON a.id = m.account_id WHERE m.id = $1`, [messageId]);
  if (!row) return null;
  const cfg = await getCompiled();
  return {
    msg: row, cfg, an: analyze(row.text ?? '', cfg.canon),
    source: { id: row.source_id, kind: row.s_kind, title: row.s_title, username: row.s_username, tgChatId: row.tg_chat_id, weight: row.s_weight, monitor: row.s_monitor && !row.s_deleted, radars: row.s_radars, keywords: row.s_keywords },
    account: { id: row.account_id, name: row.a_name },
  };
}
async function finish(ctx, state, reason = null, error = null) {
  await query('UPDATE messages SET state = $2, skip_reason = $3, error = $4, processed_at = now() WHERE id = $1', [ctx.msg.id, state, reason, error]);
  bump({ accountId: ctx.msg.account_id, sourceId: ctx.msg.source_id, messages: 1 });
}
export async function markFailed(messageId, err) {
  const r = await one("UPDATE messages SET state = 'failed', error = $2, processed_at = now() WHERE id = $1 AND state NOT IN ('done','skipped') RETURNING account_id, source_id", [messageId, String(err?.message ?? err).slice(0, 300)]);
  if (r) bump({ accountId: r.account_id, sourceId: r.source_id, errors: 1 });
}

/** Stage 1 - claim the message, normalise, apply blocks / disabled sources, hand over to the keyword stage. */
export async function stageProcess(messageId) {
  const claimed = await one("UPDATE messages SET state = 'processing', attempts = attempts + 1, claimed_at = now() WHERE id = $1 AND state IN ('pending','processing') RETURNING attempts", [messageId]);
  if (!claimed) return { skipped: 'not_claimable' };
  if (await getSetting('processing.paused')) { await query("UPDATE messages SET state = 'pending' WHERE id = $1", [messageId]); return { paused: true }; }
  const ctx = await loadContext(messageId);
  if (!ctx) return { skipped: 'gone' };
  let reason = null;
  if (!ctx.source.monitor) reason = 'source_disabled';
  else if (!ctx.an.tokens.length) reason = 'empty';
  else reason = await checkBlocked({ senderId: ctx.msg.sender_id, tgChatId: ctx.msg.tg_chat_id, analysis: ctx.an });
  if (reason) { await finish(ctx, 'skipped', reason); return { skipped: reason }; }
  if (!(await enqueue(Q.keyword, 'keyword', { messageId }, { jobId: `k-${messageId}-${claimed.attempts}` }))) return stageKeyword(messageId); // degraded: no queue -> inline
  return { queued: 'keyword' };
}

async function evaluateLocal(ctx) {
  const { an, cfg, source } = ctx;
  const [contextPenalty, minContextTokens] = await Promise.all([getSetting('keywords.context_penalty'), getSetting('keywords.min_context_tokens')]);
  const radars = cfg.radars.filter((r) => !source.radars.length || source.radars.includes(r.id));
  const ids = new Set(radars.map((r) => r.id));
  const standalone = cfg.keywords.filter((k) => k.aiRuleId == null && (!source.keywords.length || source.keywords.includes(k.id)));
  const linked = cfg.keywords.filter((k) => k.aiRuleId != null && ids.has(k.aiRuleId));
  const hits = evaluateKeywords(an, [...standalone, ...linked, ...radars.map((r) => r.kw)], { contextPenalty, minContextTokens });
  const states = radars.map((radar) => {
    const kw = hits.find((h) => h.aiRuleId === radar.id) ?? null;
    return { radar, kw, kwScore: kw?.score ?? 0, pre: kw ? kw.score : radarPrefilter(an, radar.forms), neg: radar.negForms.length > 0 && radarPrefilter(an, radar.negForms) >= 88 };
  });
  return { hits, states, standalone: hits.filter((h) => h.aiRuleId == null) };
}

async function routeToAi(ctx, local) {
  const [semantic, minChars, thr] = await Promise.all([getSetting('ai.semantic_enabled'), getSetting('ai.min_chars'), getSetting('radar.prefilter_threshold')]);
  if (!semantic || ctx.an.norm.length < minChars || !local.states.length || !(await aiAvailable())) return [];
  return local.states.filter((s) => {
    if (s.radar.ai_mode === 'off') return false;
    if (s.radar.ai_mode === 'always') return true;
    return (ctx.cfg.rulesNeedAi || s.kwScore < 95) && (s.kwScore > 0 || s.pre >= thr * 100); // rules that test AI intent/confidence need AI evidence even for strong keyword hits
  }).map((s) => s.radar.id);
}

/** Stage 2 - keyword engine; decides whether AI confirmation is needed. */
export async function stageKeyword(messageId) {
  const ctx = await loadContext(messageId);
  if (!ctx || ['done', 'skipped'].includes(ctx.msg.state)) return { skipped: 'already' };
  const local = await evaluateLocal(ctx);
  const radarIds = await routeToAi(ctx, local);
  if (!radarIds.length) return decide(ctx, local, new Map(), { degraded: false });
  if (await enqueue(Q.ai, 'ai', { messageId, radarIds }, { jobId: `a-${messageId}-${ctx.msg.attempts}` })) return { queued: 'ai', radarIds };
  return stageAi(messageId, radarIds, { final: true });
}

const fromRow = (r) => ({ isMatch: r.is_match, confidence: r.confidence, intent: r.intent, category: r.category, priority: r.priority, entities: r.entities, reason: r.reason, suggested: r.suggested_keywords });

/** Stage 3 - semantic analysis. Provider outages retry via the queue; on the final attempt we degrade to keyword-only. */
export async function stageAi(messageId, radarIds, { final = false } = {}) {
  const ctx = await loadContext(messageId);
  if (!ctx || ['done', 'skipped'].includes(ctx.msg.state)) return { skipped: 'already' };
  const local = await evaluateLocal(ctx);
  const aiMap = new Map(); let degraded = false;
  const nEx = await getSetting('radar.few_shot_examples');
  const normHash = fingerprint(ctx.an).norm;
  for (const rid of radarIds) {
    const radar = ctx.cfg.radars.find((r) => r.id === rid);
    if (!radar) continue;
    const existing = await one('SELECT * FROM ai_results WHERE message_id = $1 AND ai_rule_id = $2', [messageId, rid]);
    if (existing) { aiMap.set(rid, fromRow(existing)); continue; }
    try {
      const examples = nEx ? await many('SELECT text, label FROM feedback_examples WHERE ai_rule_id = $1 ORDER BY created_at DESC LIMIT $2', [rid, nEx]) : [];
      const r = await analyzeForRadar({ radar, text: ctx.msg.text, normHash, sourceTitle: ctx.source.title, examples });
      await query(
        `INSERT INTO ai_results (message_id, ai_rule_id, provider, model, is_match, confidence, intent, category, priority, entities, reason, suggested_keywords, latency_ms, tokens_in, tokens_out)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (message_id, ai_rule_id) DO NOTHING`,
        [messageId, rid, r.provider, r.model, r.isMatch, r.confidence, r.intent, r.category, r.priority, JSON.stringify(r.entities), r.reason, r.suggested, r.latencyMs ?? null, r.tokensIn, r.tokensOut]);
      aiMap.set(rid, r);
    } catch (e) {
      if (!final && e.code === 'AI_UNAVAILABLE') throw e; // queue retries with exponential backoff
      degraded = true;
      log.warn('AI stage degraded to keyword-only', { messageId, radar: rid, err: e.message });
    }
  }
  return decide(ctx, local, aiMap, { degraded });
}

const localReason = (h, lang) => (lang === 'ar'
  ? `تطابق ${TYPE_AR[h.type] ?? h.type} مع «${h.keywordId == null ? h.matchedForm : h.phrase}»${h.contextOk === false ? ' (بدون سياق كافٍ)' : ''}`
  : `${h.type} match on "${h.keywordId == null ? h.matchedForm : h.phrase}"${h.contextOk === false ? ' (little context)' : ''}`);

async function learnSuggestions(radar, ai, msg, hadKeyword) {
  if (!ai?.isMatch || ai.confidence < 70) return;
  const phrases = new Set(ai.suggested ?? []);
  if (!hadKeyword && phrases.size === 0 && (msg.text ?? '').length <= 60) phrases.add(msg.text);
  const known = new Set(radar.signals.map(normalizeText));
  for (const p of phrases) {
    const norm = normalizeText(p);
    if (norm.length < 4 || norm.length > 80 || known.has(norm)) continue;
    await query(`INSERT INTO keyword_suggestions (ai_rule_id, phrase, norm_phrase, example) VALUES ($1,$2,$3,$4)
      ON CONFLICT (ai_rule_id, norm_phrase) DO UPDATE SET hits = keyword_suggestions.hits + 1, updated_at = now() WHERE keyword_suggestions.status = 'pending'`, [radar.id, p.slice(0, 120), norm, String(msg.text).slice(0, 200)]);
  }
}

/** Final stage - merge keyword + AI evidence into candidates, run rules, de-duplicate, persist the card, notify, trigger automations. */
export async function decide(ctx, local, aiMap, { degraded }) {
  const { msg, an, cfg, source, account } = ctx;
  const candidates = [];
  for (const s of local.states) {
    const ai = aiMap.get(s.radar.id); const kw = s.kw; let score; let type;
    if (ai) {
      if (ai.isMatch) { score = kw ? Math.round(0.4 * kw.score + 0.6 * ai.confidence) : Math.round(ai.confidence); type = kw ? kw.type : 'semantic'; }
      else { score = Math.round((kw?.score ?? 0) * (1 - ai.confidence / 100)); type = kw?.type ?? 'semantic'; }
    } else if (kw) { score = kw.score; type = kw.type; } else continue;
    if (s.neg) score = Math.round(score * 0.4);
    candidates.push({
      origin: 'radar', aiRuleId: s.radar.id, keywordId: kw?.keywordId ?? null, keywordText: kw ? (kw.keywordId == null ? kw.matchedForm : kw.phrase) : null, matchType: type, score,
      intent: ai?.intent || s.radar.intent, aiConfidence: ai?.confidence ?? null, aiReason: ai?.reason || (kw ? localReason(kw, msg.lang) : null), aiPriority: ai?.priority ?? null,
      entities: ai?.entities ?? [], contextOk: kw?.contextOk ?? null, sensitive: !!kw?.sensitive, radarHint: s.radar.priority_hint, qualifies: score >= s.radar.min_score,
    });
  }
  for (const h of local.standalone) {
    candidates.push({ origin: 'keyword', aiRuleId: null, keywordId: h.keywordId, keywordText: h.phrase, matchType: h.type, score: h.score, intent: null, aiConfidence: null, aiReason: localReason(h, msg.lang), aiPriority: null, entities: [], contextOk: h.contextOk, sensitive: h.sensitive, radarHint: null, qualifies: h.score >= h.minScore });
  }
  const qualified = candidates.filter((c) => c.qualifies).sort((a, b) => b.score - a.score);
  let best = qualified[0] ?? null;

  const prio = async (c) => {
    const sens = cfg.sensitiveWords.filter((w) => quickMatch(an, w, 'contains').ok).length + (c.sensitive ? 1 : 0);
    const repeat = msg.sender_id != null ? await one("SELECT 1 AS x FROM message_matches WHERE sender_id = $1 AND created_at > now() - interval '24 hours' LIMIT 1", [msg.sender_id]) : null;
    return computePriority({ score: c.score, aiConfidence: c.aiConfidence, aiPriority: c.aiPriority, radarHint: c.radarHint, sensitiveHits: sens, sourceWeight: source.weight, repeatSender: !!repeat }, cfg.thresholds);
  };
  let pr = best ? await prio(best) : null;
  const d = newDecision(); d.create = !!best; d.priority = pr?.priority ?? null;
  const evalCtx = { message: { text: msg.text, senderId: msg.sender_id, senderUsername: msg.sender_username, lang: msg.lang, hasLink: /https?:\/\/|t\.me\//i.test(msg.text ?? '') }, source, account, analysis: an, candidates: qualified, best, ai: [...aiMap.values()], priority: d.priority };
  let ruleScore = null;
  for (const rule of cfg.rules) {
    const r = evalNode(rule.conditions, evalCtx);
    if (!r.ok) continue;
    applyDecisionActions(rule.actions, d); d.ruleIds.push(rule.id);
    if (r.score != null) ruleScore = Math.max(ruleScore ?? 0, r.score);
    evalCtx.priority = d.priority ?? evalCtx.priority;
    if (rule.stop_on_match) break;
  }
  if (d.ruleIds.length) await query('UPDATE rules SET hits = hits + 1, last_hit_at = now() WHERE id = ANY($1::bigint[])', [d.ruleIds]);
  if (d.create && !best) {
    best = { origin: 'rule', aiRuleId: null, keywordId: null, keywordText: null, matchType: 'rule', score: Math.round(ruleScore ?? 100), intent: null, aiConfidence: null, aiReason: null, aiPriority: null, entities: [], contextOk: null, sensitive: false, radarHint: null };
    pr = await prio(best); d.priority ??= pr.priority;
  }
  void fireTrigger('new_message', { messageId: msg.id, id: msg.id, senderId: msg.sender_id, sourceId: source.id, text: (msg.text ?? '').slice(0, 200) }, { evalCtx, ref: msg.id });
  if (d.suppress || !d.create || !best) {
    await query("UPDATE messages SET state = 'done', skip_reason = $2, processed_at = now(), error = NULL WHERE id = $1", [msg.id, d.suppress ? 'suppressed' : null]);
    bump({ accountId: msg.account_id, sourceId: msg.source_id, messages: 1 });
    return { matched: false };
  }

  const priority = d.priority ?? 'low';
  const res = await persistCard({
    msg, an, fp: fingerprint(an),
    card: {
      aiRuleId: best.aiRuleId, keywordId: best.keywordId, ruleId: d.ruleIds[0] ?? null, matchType: best.matchType, score: best.score, priority, intent: best.intent, aiConfidence: best.aiConfidence,
      aiReason: best.aiReason, keywordText: best.keywordText, contextOk: best.contextOk, tags: d.tags,
      extra: { candidates: qualified.slice(0, 5).map((c) => ({ radar: c.aiRuleId, kw: c.keywordId, type: c.matchType, score: c.score, intent: c.intent })), factors: pr?.factors ?? [], ai_degraded: degraded, force_channels: [...d.forceChannels], rule_ids: d.ruleIds, entities: best.entities },
    },
  });
  bump({ accountId: msg.account_id, sourceId: msg.source_id, messages: 1, ...(res.created ? { matches: 1, high: priorityAtLeast(priority, 'high') ? 1 : 0 } : {}), ...(res.duplicate ? { duplicates: 1 } : {}) });
  if (res.created) {
    if (best.aiRuleId) bumpRadar(best.aiRuleId);
    if (best.keywordId) bumpKeyword(best.keywordId);
    const [card] = await hydrateCards([res.id]);
    if (card) {
      await notifyMatch(card, d.forceChannels);
      if (d.save) await saveMatch(res.id);
      const payload = { matchId: res.id, id: res.id, priority, score: best.score, intent: best.intent, source: card.source.title, senderId: msg.sender_id, senderUsername: msg.sender_username, sourceId: source.id, accountId: account.id, text: (msg.text ?? '').slice(0, 200) };
      await fireTrigger('new_match', payload, { evalCtx: { ...evalCtx, priority }, ref: res.id });
      if (priorityAtLeast(priority, 'high')) await fireTrigger('high_priority_match', payload, { evalCtx: { ...evalCtx, priority }, ref: res.id });
    }
    const radar = best.aiRuleId ? cfg.radars.find((r) => r.id === best.aiRuleId) : null;
    if (radar) await learnSuggestions(radar, aiMap.get(radar.id), msg, !!local.states.find((s) => s.radar.id === radar.id)?.kw);
  }
  return { matched: true, cardId: res.id, created: res.created, duplicate: res.duplicate };
}

/** Used by the sweeper and by "scan history": run the whole pipeline inline for one message (no queue needed). */
export async function processInline(messageId) {
  const r = await stageProcess(messageId);
  return r;
}
