// Priority scoring: LOW / MEDIUM / HIGH / CRITICAL from score, AI confidence, sensitivity, source, sender and hints.
export const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const HINT = { low: -10, medium: 0, high: 5, critical: 15 };
const AI_PRIORITY = { low: -3, medium: 0, high: 3, critical: 6 };
export const priorityRank = (p) => PRIORITIES.indexOf(p);
export const priorityAtLeast = (p, min) => priorityRank(p) >= priorityRank(min);
export const maxPriority = (a, b) => (priorityRank(a) >= priorityRank(b) ? a : b);

export function computePriority(i, thresholds = {}) {
  const th = { medium: 60, high: 80, critical: 95, ...thresholds };
  const factors = [['score', Math.round(i.score * 0.85)]];
  let pts = i.score * 0.85;
  const add = (name, v) => { if (v) { pts += v; factors.push([name, v]); } };
  if (i.aiConfidence >= 90) add('ai_confidence', 5);
  if (i.sensitiveHits) add('sensitive_words', Math.min(15, i.sensitiveHits * 10));
  if (i.sourceWeight) add('source', i.sourceWeight);
  if (i.repeatSender) add('repeat_sender', 5);
  if (i.radarHint) add('radar_hint', HINT[i.radarHint] ?? 0);
  if (i.aiPriority) add('ai_priority', AI_PRIORITY[i.aiPriority] ?? 0);
  const priority = pts >= th.critical ? 'critical' : pts >= th.high ? 'high' : pts >= th.medium ? 'medium' : 'low';
  return { priority, points: Math.round(pts), factors };
}
