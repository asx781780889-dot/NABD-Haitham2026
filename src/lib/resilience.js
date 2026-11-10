// Backoff, retry, timeout, circuit breaker, semaphore and token bucket primitives.
export const sleep = (ms, signal) => new Promise((res) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

/** Exponential backoff with equal jitter. attempt starts at 0. */
export function backoff(attempt, base = 1000, cap = 60000) {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

export async function retry(fn, { retries = 2, base = 500, cap = 10000, shouldRetry = () => true, onRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(attempt); } catch (e) {
      if (attempt >= retries || !shouldRetry(e)) throw e;
      const d = Math.min(e?.retryAfterMs ?? backoff(attempt, base, cap), Math.max(cap, e?.retryAfterMs ?? 0));
      onRetry?.(e, attempt, d);
      await sleep(d);
    }
  }
}

export function withTimeout(promise, ms, label = 'operation') {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`${label} timed out after ${ms}ms`), { code: 'ETIMEDOUT' })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

export class CircuitBreaker {
  constructor({ name = 'breaker', threshold = 5, cooldownMs = 60000 } = {}) {
    Object.assign(this, { name, threshold, cooldownMs, failures: 0, openedAt: 0, lastError: null, probing: false });
  }
  get state() {
    if (this.failures < this.threshold) return 'closed';
    return Date.now() - this.openedAt >= this.cooldownMs ? 'half-open' : 'open';
  }
  canPass() {
    const s = this.state;
    if (s === 'closed') return true;
    if (s === 'half-open' && !this.probing) { this.probing = true; return true; }
    return false;
  }
  success() { this.failures = 0; this.probing = false; this.lastError = null; }
  fail(err) {
    this.failures++; this.probing = false; this.lastError = err?.message ?? String(err);
    if (this.failures >= this.threshold) this.openedAt = Date.now();
  }
  reset() { this.failures = 0; this.probing = false; }
  snapshot() { return { name: this.name, state: this.state, failures: this.failures, lastError: this.lastError, retryInMs: this.state === 'open' ? Math.max(0, this.cooldownMs - (Date.now() - this.openedAt)) : 0 }; }
}

export class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  async acquire() { if (this.n > 0) { this.n--; return; } await new Promise((r) => this.q.push(r)); }
  release() { const next = this.q.shift(); if (next) next(); else this.n++; }
  async run(fn) { await this.acquire(); try { return await fn(); } finally { this.release(); } }
}

export class TokenBucket {
  constructor({ ratePerSec = 5, burst = 5 } = {}) { Object.assign(this, { rate: ratePerSec, burst, tokens: burst, last: Date.now() }); }
  _refill() { const now = Date.now(); this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate); this.last = now; }
  tryTake() { this._refill(); if (this.tokens >= 1) { this.tokens -= 1; return true; } return false; }
  async take() { while (!this.tryTake()) await sleep(Math.ceil(1000 / this.rate)); }
}
