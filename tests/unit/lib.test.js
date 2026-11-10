import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
process.env.NODE_ENV = 'test'; process.env.DATABASE_URL ??= 'postgres://x'; process.env.MASTER_KEY ??= 'dGVzdC1tYXN0ZXIta2V5LWZvci1uYWJkLWFpLTMyYnl0ZXM=';
const crypto = await import('../../src/lib/crypto.js');
const res = await import('../../src/lib/resilience.js');
const exp = await import('../../src/services/export.js');
const { parseAiJson, analysisSchema } = await import('../../src/ai/analyzer.js');
const { createProvider, ProviderError } = await import('../../src/ai/providers.js');
const { telegramLinks } = await import('../../src/telegram/links.js');
const { heuristicDraft } = await import('../../src/ai/radar.js');
const { redact } = await import('../../src/lib/logger.js');

test('crypto: AES-GCM round trip (Arabic safe), tamper + wrong-key detection, key id tag', () => {
  const secret = 'جلسة-سرية 🔐 api_hash=abc123'; const c = crypto.encrypt(secret);
  assert.ok(c.startsWith('v1.') && !c.includes('abc123')); assert.equal(crypto.decrypt(c), secret); assert.notEqual(crypto.encrypt(secret), c, 'random IV per call');
  const parts = c.split('.'); parts[4] = `${parts[4].slice(0, -2)}AA`; assert.throws(() => crypto.decrypt(parts.join('.')));
  parts[1] = 'deadbeef'; assert.throws(() => crypto.decrypt(parts.join('.')), /unknown encryption key/); assert.equal(crypto.needsRewrap(c), false);
  assert.equal(crypto.keyedHash('+966500000001'), crypto.keyedHash('+966500000001')); assert.notEqual(crypto.keyedHash('a'), crypto.keyedHash('b'));
});
test('crypto: scrypt passwords, masking, constant-time compare', async () => {
  const h = await crypto.hashPassword('Correct-Horse-1'); assert.ok(h.startsWith('scrypt$')); assert.equal(await crypto.verifyPassword('Correct-Horse-1', h), true);
  assert.equal(await crypto.verifyPassword('wrong', h), false); assert.equal(await crypto.verifyPassword('x', 'garbage'), false);
  const m = crypto.maskPhone('+966500000001'); assert.ok(m.endsWith('0001') && !m.includes('5000000')); assert.ok(crypto.safeEqual('abc', 'abc') && !crypto.safeEqual('abc', 'abd') && !crypto.safeEqual('abc', 'ab'));
});
test('resilience: backoff bounds, retry policy, circuit breaker lifecycle, semaphore, token bucket', async () => {
  for (let a = 0; a < 8; a++) { const d = res.backoff(a, 100, 5000); assert.ok(d >= Math.min(5000, 100 * 2 ** a) / 2 && d <= Math.min(5000, 100 * 2 ** a)); }
  let calls = 0; assert.equal(await res.retry(async () => { if (++calls < 3) throw new Error('flaky'); return 'ok'; }, { retries: 3, base: 1, cap: 2 }), 'ok'); assert.equal(calls, 3);
  calls = 0; await assert.rejects(res.retry(async () => { calls++; throw new Error('fatal'); }, { retries: 5, base: 1, shouldRetry: () => false })); assert.equal(calls, 1);
  const b = new res.CircuitBreaker({ threshold: 2, cooldownMs: 40 }); assert.equal(b.canPass(), true); b.fail(new Error('x')); assert.equal(b.state, 'closed'); b.fail(new Error('y')); assert.equal(b.state, 'open'); assert.equal(b.canPass(), false);
  await res.sleep(60); assert.equal(b.state, 'half-open'); assert.equal(b.canPass(), true); assert.equal(b.canPass(), false, 'only one probe while half-open'); b.success(); assert.equal(b.state, 'closed');
  const sem = new res.Semaphore(2); let active = 0; let peak = 0; await Promise.all(Array.from({ length: 8 }, () => sem.run(async () => { active++; peak = Math.max(peak, active); await res.sleep(5); active--; }))); assert.equal(peak, 2);
  const tb = new res.TokenBucket({ ratePerSec: 1000, burst: 2 }); assert.ok(tb.tryTake() && tb.tryTake() && !tb.tryTake()); await tb.take();
  await assert.rejects(res.withTimeout(res.sleep(200), 10, 'slow'), /timed out/);
});
test('export: CSV (BOM, quoting, formula-injection guard), XLSX is a valid OOXML zip, HTML escapes', () => {
  const cols = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]; const rows = [{ a: '=HYPERLINK("http://evil")', b: 'سطر, "اقتباس"\nجديد' }, { a: 5, b: null }];
  const csv = exp.toCSV(cols, rows); assert.ok(csv.startsWith('\uFEFF"A","B"')); assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`)); assert.ok(csv.includes('"سطر, ""اقتباس""\nجديد"'));
  const z = unzipSync(new Uint8Array(exp.toXLSX(cols, [{ a: '<b>&x</b>', b: 'مرحبا' }, { a: 7, b: 'x\u0001y' }], { rtl: true })));
  for (const f of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']) assert.ok(z[f], f);
  const sheet = strFromU8(z['xl/worksheets/sheet1.xml']); assert.ok(sheet.includes('&lt;b&gt;&amp;x&lt;/b&gt;') && sheet.includes('مرحبا') && sheet.includes('<v>7</v>') && sheet.includes('rightToLeft="1"') && !sheet.includes('\u0001'));
  const html = exp.toHTML('T<script>', cols, [{ a: '<img onerror=1>', b: 1 }], 'ar'); assert.ok(!html.includes('<img onerror') && html.includes('&lt;img') && html.includes('dir="rtl"') && !html.includes('<script>alert'));
});
test('AI: tolerant JSON extraction and strict normalisation of model output', () => {
  assert.deepEqual(parseAiJson('```json\n{"match": true}\n```'), { match: true }); assert.deepEqual(parseAiJson('Sure! Here you go: {"a":1} hope that helps'), { a: 1 }); assert.throws(() => parseAiJson('no json here'));
  const a = analysisSchema.parse({ match: 'true', confidence: 0.93, priority: 'urgent!!', entities: 'oops', reason: 'x'.repeat(900), suggested_keywords: ['a', 'b'] });
  assert.equal(a.match, true); assert.equal(a.confidence, 93); assert.equal(a.priority, 'medium'); assert.deepEqual(a.entities, []); assert.ok(a.reason === '' || a.reason.length <= 400);
  assert.equal(analysisSchema.parse({ match: 'false', confidence: 250 }).match, false); assert.equal(analysisSchema.parse({ match: 'false', confidence: 250 }).confidence, 100); assert.equal(analysisSchema.parse({ match: 1, confidence: -5 }).confidence, 0);
});
test('AI providers: request shapes for Gemini / OpenAI / Anthropic / local / custom (stubbed fetch)', async () => {
  const seen = []; const real = globalThis.fetch;
  globalThis.fetch = async (url, o) => { seen.push({ url: String(url), headers: o.headers, body: o.body ? JSON.parse(o.body) : null }); const u = String(url);
    const body = u.endsWith('/interactions') ? { steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"ok":1}' }] }], usage: { total_input_tokens: 3, total_output_tokens: 2 } }
      : u.endsWith('/v1/messages') ? { content: [{ type: 'text', text: '{"ok":1}' }], usage: { input_tokens: 4, output_tokens: 1 } } : { choices: [{ message: { content: '{"ok":1}' } }], usage: { prompt_tokens: 5, completion_tokens: 6 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    const req = { system: 'sys', user: 'hi', json: true, maxTokens: 123, temperature: 0.2 }; const base = { model: 'm', timeoutMs: 5000 };
    let r = await createProvider('gemini', { ...base, apiKey: 'G', model: 'gemini-3.8-flash' }).complete(req); assert.equal(r.tokensIn, 3); assert.equal(r.tokensOut, 2);
    let s = seen.at(-1); assert.equal(s.url, 'https://generativelanguage.googleapis.com/v1beta/interactions'); assert.equal(s.headers['x-goog-api-key'], 'G'); assert.equal(s.body.model, 'gemini-3.8-flash'); assert.equal(s.body.input, 'hi'); assert.equal(s.body.system_instruction, 'sys'); assert.equal(s.body.store, false); assert.deepEqual(s.body.response_format, [{ type: 'text', mime_type: 'application/json' }]); assert.equal(s.body.generation_config.max_output_tokens, 123); assert.equal(s.body.generation_config.thinking_level, 'low'); assert.ok(!('temperature' in s.body.generation_config)); assert.ok(!s.url.includes('key='), 'API key must be sent in a header, not the URL');
    await createProvider('openai', { ...base, apiKey: 'O' }).complete(req); s = seen.at(-1); assert.equal(s.url, 'https://api.openai.com/v1/chat/completions'); assert.equal(s.headers.authorization, 'Bearer O'); assert.equal(s.body.max_completion_tokens, 123); assert.deepEqual(s.body.response_format, { type: 'json_object' });
    await createProvider('grok', { ...base, apiKey: 'XAI_KEY' }).complete(req); s = seen.at(-1); assert.equal(s.url, 'https://api.x.ai/v1/chat/completions'); assert.equal(s.headers.authorization, 'Bearer XAI_KEY'); assert.equal(s.body.max_tokens, 123);
    await createProvider('anthropic', { ...base, apiKey: 'A' }).complete(req); s = seen.at(-1); assert.equal(s.url, 'https://api.anthropic.com/v1/messages'); assert.equal(s.headers['x-api-key'], 'A'); assert.equal(s.headers['anthropic-version'], '2023-06-01'); assert.equal(s.body.system, 'sys'); assert.equal(s.body.max_tokens, 123); assert.deepEqual(s.body.messages, [{ role: 'user', content: 'hi' }]);
    await createProvider('local', { ...base, baseUrl: 'http://127.0.0.1:11434/v1' }).complete(req); s = seen.at(-1); assert.equal(s.url, 'http://127.0.0.1:11434/v1/chat/completions'); assert.equal(s.body.max_tokens, 123); assert.ok(!s.headers.authorization);
    await createProvider('custom', { ...base, baseUrl: 'https://llm.example/v1/', apiKey: 'C', headers: { 'x-team': 'z' } }).complete(req); s = seen.at(-1); assert.equal(s.url, 'https://llm.example/v1/chat/completions'); assert.equal(s.headers['x-team'], 'z');
    // adaptive retry: a model that rejects `temperature` is retried without it
    let n = 0; globalThis.fetch = async (url, o) => { const b = JSON.parse(o.body); n++; if ('temperature' in b) return new Response(JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0.2" } }), { status: 400 }); seen.push({ body: b }); return new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 }); };
    await createProvider('openai', { ...base, apiKey: 'O' }).complete(req); assert.equal(n, 2); assert.ok(!('temperature' in seen.at(-1).body));
    const groqBodies = []; globalThis.fetch = async (_url, o) => { const b = JSON.parse(o.body); groqBodies.push(b); if (b.response_format) return new Response(JSON.stringify({ error: { message: "Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details." } }), { status: 400 }); return new Response(JSON.stringify({ choices: [{ message: { content: '{\"ok\":true}' } }] }), { status: 200 }); };
    await createProvider('grok', { ...base, apiKey: 'GROQ_KEY', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' }).complete(req);
    assert.equal(groqBodies.length, 2); assert.deepEqual(groqBodies[0].response_format, { type: 'json_object' }); assert.equal(groqBodies[0].include_reasoning, false); assert.equal(groqBodies[0].reasoning_effort, 'low'); assert.ok(!('response_format' in groqBodies[1])); assert.equal(groqBodies[1].max_tokens, 123);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'retry-after': '2' } });
    await assert.rejects(createProvider('openai', { ...base, apiKey: 'O' }).complete(req), (e) => e instanceof ProviderError && e.retryable && e.retryAfterMs === 2000 && e.status === 429);
    globalThis.fetch = async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }); await assert.rejects(createProvider('anthropic', { ...base, apiKey: 'A' }).complete(req), (e) => !e.retryable && e.status === 401);
  } finally { globalThis.fetch = real; }
});
test('telegram deep links, offline radar draft, log redaction', () => {
  assert.equal(telegramLinks({ chatId: -1001234567890, kind: 'channel', username: 'news', messageId: 9 }).message, 'https://t.me/news/9');
  assert.equal(telegramLinks({ chatId: -1001234567890, kind: 'supergroup', username: null, messageId: 9 }).message, 'https://t.me/c/1234567890/9');
  assert.equal(telegramLinks({ chatId: -4455, kind: 'group', username: null, messageId: 3 }).message, null);
  const pm = telegramLinks({ chatId: 777, kind: 'private', username: null, messageId: 3, senderId: 777 }); assert.equal(pm.chat, 'tg://user?id=777'); assert.equal(pm.sender, 'tg://user?id=777');
  const d = heuristicDraft('أريد الأشخاص الذين يكتبون أنهم يحتاجون مساعدة في واجبات الجامعة'); assert.ok(d.signals.length >= 8 && d.signals.some((s) => s.includes('واجبات الجامعه')) && d.source === 'heuristic');
  assert.equal(heuristicDraft('people who need help with school projects').language, 'en');
  const r = redact({ password: 'p', code: '123', api_hash: 'h', session: 's', nested: { token: 't', ok: 1 }, list: [{ authorization: 'a' }], phone: '+9665' }); assert.deepEqual([r.password, r.code, r.api_hash, r.session, r.nested.token, r.list[0].authorization, r.phone], Array(7).fill('[redacted]')); assert.equal(r.nested.ok, 1);
});
