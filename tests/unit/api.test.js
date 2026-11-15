import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../public/js/lib/api.js';

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('idempotent GET retries transient gateway errors and recovers', async (t) => {
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => (++calls < 3 ? new Response('Bad Gateway', { status: 502 }) : jsonResponse(200, { ok: true }));
  assert.deepEqual(await api('GET', '/system/overview'), { ok: true });
  assert.equal(calls, 3);
});

test('GET does not retry a write or non-transient API status', async (t) => {
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return jsonResponse(503, { error: { code: 'WORKER_OFFLINE' } }); };
  await assert.rejects(api('GET', '/system/overview'), (e) => e.status === 503 && e.code === 'WORKER_OFFLINE');
  assert.equal(calls, 1);
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('Bad Gateway', { status: 502 }); };
  await assert.rejects(api('POST', '/auth/login', { username: 'u' }), (e) => e.status === 502);
  assert.equal(calls, 1);
});

test('aborting a GET cancels its retry delay', async (t) => {
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController(); let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('Bad Gateway', { status: 502 }); };
  const pending = api('GET', '/system/overview', undefined, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 30)); controller.abort();
  await assert.rejects(pending, (e) => e.name === 'AbortError');
  assert.equal(calls, 1);
});
