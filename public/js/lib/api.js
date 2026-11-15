// REST client: CSRF header, localized errors (message + error id), transparent step-up (password) confirmation.
import { getLang } from './i18n.js';
export const state = { csrf: '', user: null, onUnauth: () => {}, askPassword: async () => null };
export class ApiError extends Error {
  constructor(status, body) {
    const e = body?.error ?? {};
    super((getLang() === 'ar' ? e.message_ar : e.message_en) || e.message || `HTTP ${status}`);
    Object.assign(this, { status, code: e.code ?? 'NETWORK', errorId: e.id ?? null, details: e.details ?? null, detail: e.detail ?? null });
  }
}
export const qs = (o = {}) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== '' && v != null && !(Array.isArray(v) && !v.length)) p.set(k, Array.isArray(v) ? v.join(',') : v); const s = p.toString(); return s ? `?${s}` : ''; };
function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
    };
    if (signal?.aborted) return abort();
    timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export async function api(method, path, body, { headers = {}, raw = false, _retried = false, _getRetries = 0, signal } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(state.csrf && method !== 'GET' ? { 'x-csrf-token': state.csrf } : {}), 'accept-language': getLang(), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
  } catch (cause) {
    if (signal?.aborted || cause?.name === 'AbortError') throw cause;
    throw new ApiError(0, { error: { code: 'NETWORK', message_en: 'Cannot reach the server. Check that NABD AI is running.', message_ar: 'تعذّر الوصول إلى الخادم. تأكد أن NABD AI يعمل.' } });
  }
  if (raw) return res;
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (res.ok) { if (json?.csrf) state.csrf = json.csrf; return json; }
  const err = new ApiError(res.status, json);
  // GETs are idempotent: hide brief database failovers and gateway restarts.
  // Never retry writes, which could duplicate an operation.
  const transientGetFailure = (res.status === 503 && err.code === 'DB_UNAVAILABLE') || [502, 504].includes(res.status);
  if (method === 'GET' && transientGetFailure && _getRetries < 2) {
    await waitForRetry(350 * (_getRetries + 1), signal);
    return api(method, path, body, { headers, raw, _retried, _getRetries: _getRetries + 1, signal });
  }
  if (err.code === 'REAUTH_REQUIRED' && !_retried && !headers['x-confirm-password']) {
    const pw = await state.askPassword(); if (pw) return api(method, path, body, { headers: { ...headers, 'x-confirm-password': pw }, _retried: true, _getRetries, signal });
  }
  if (res.status === 401 && err.code === 'UNAUTHENTICATED') state.onUnauth();
  throw err;
}
export const get = (p, q, options) => api('GET', p + qs(q), undefined, options);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const patch = (p, b = {}) => api('PATCH', p, b);
export const del = (p) => api('DELETE', p);
