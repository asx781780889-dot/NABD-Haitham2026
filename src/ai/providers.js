// REST adapters (plain fetch, no SDKs): Gemini, OpenAI-compatible (OpenAI / Local / Custom) and Anthropic.
export class ProviderError extends Error {
  constructor(message, { status = null, retryable = false, retryAfterMs = null } = {}) {
    super(message); this.name = 'ProviderError'; Object.assign(this, { status, retryable, retryAfterMs });
  }
}

async function http(url, { method = 'POST', headers = {}, body, timeoutMs = 20000 }) {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
    const text = await res.text(); let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 300) }; }
    if (!res.ok) {
      const ra = Number(res.headers.get('retry-after'));
      const msg = json?.error?.message || json?.message || json?.raw || res.statusText;
      throw new ProviderError(`HTTP ${res.status}: ${String(msg).slice(0, 240)}`, { status: res.status, retryable: [408, 409, 429].includes(res.status) || res.status >= 500, retryAfterMs: Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30000) : null });
    }
    return json;
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (e.name === 'AbortError') throw new ProviderError(`timeout after ${timeoutMs}ms`, { retryable: true });
    throw new ProviderError(`network error: ${e.cause?.code || e.message}`, { retryable: true });
  } finally { clearTimeout(timer); }
}

function gemini(cfg) {
  const base = (cfg.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const headers = { 'x-goog-api-key': cfg.apiKey };
  return {
    id: 'gemini',
    async complete({ system, user, json, maxTokens }) {
      const body = {
        model: cfg.model,
        input: user,
        store: false,
        ...(system ? { system_instruction: system } : {}),
        ...(json ? { response_format: [{ type: 'text', mime_type: 'application/json' }] } : {}),
        generation_config: {
          max_output_tokens: maxTokens,
          ...(/^gemini-(?:3|4)/.test(cfg.model) ? { thinking_level: 'low' } : {}),
        },
      };
      const r = await http(`${base}/interactions`, { headers, body, timeoutMs: cfg.timeoutMs });
      const outputs = (r.steps ?? []).filter((s) => s.type === 'model_output').flatMap((s) => s.content ?? []);
      const text = outputs.filter((p) => p.type === 'text').map((p) => p.text || '').join('');
      if (!text) throw new ProviderError(`empty response (${r.status ?? 'no model output'})`, { retryable: false });
      return { text, tokensIn: r.usage?.total_input_tokens, tokensOut: r.usage?.total_output_tokens };
    },
    async listModels() {
      const r = await http(`${base}/models?pageSize=200`, { method: 'GET', headers, timeoutMs: cfg.timeoutMs });
      return (r.models ?? []).filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent')).map((m) => String(m.name).replace(/^models\//, ''));
    },
  };
}

function openaiCompat(cfg, id) {
  const base = (cfg.baseUrl || (id === 'grok' ? 'https://api.x.ai/v1' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
  const headers = { ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}), ...(cfg.headers ?? {}) };
  let host = ''; try { host = new URL(base).hostname; } catch { /* validated elsewhere */ }
  const adapt = { tokKey: host === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens', temperature: true, json: true };
  return {
    id,
    async complete({ system, user, json, maxTokens, temperature }) {
      for (let i = 0; ; i++) {
        const body = { model: cfg.model, messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }], [adapt.tokKey]: maxTokens };
        if (adapt.temperature) body.temperature = temperature;
        if (host === 'api.groq.com' && /^openai\/gpt-oss-(?:20b|120b)$/.test(cfg.model)) { body.include_reasoning = false; body.reasoning_effort = 'low'; }
        if (json && adapt.json) body.response_format = { type: 'json_object' };
        try {
          const r = await http(`${base}/chat/completions`, { headers, body, timeoutMs: cfg.timeoutMs });
          const text = r.choices?.[0]?.message?.content ?? '';
          if (!text) throw new ProviderError(`empty response (${r.choices?.[0]?.finish_reason ?? 'no choice'})`);
          return { text, tokensIn: r.usage?.prompt_tokens, tokensOut: r.usage?.completion_tokens };
        } catch (e) {
          const m = String(e.message).toLowerCase();
          if (e.status !== 400 || i >= 3) throw e;
          if (m.includes('temperature') && adapt.temperature) adapt.temperature = false;
          else if (m.includes('response_format') && adapt.json) adapt.json = false;
          else if (host === 'api.groq.com' && (m.includes('failed to validate json') || m.includes('failed_generation')) && adapt.json) adapt.json = false;
          else if (id !== 'grok' && m.includes('max_tokens') && adapt.tokKey === 'max_tokens') adapt.tokKey = 'max_completion_tokens';
          else if (id !== 'grok' && m.includes('max_completion_tokens') && adapt.tokKey === 'max_completion_tokens') adapt.tokKey = 'max_tokens';
          else throw e;
        }
      }
    },
    async listModels() {
      const r = await http(`${base}/models`, { method: 'GET', headers, timeoutMs: cfg.timeoutMs });
      return (r.data ?? r.models ?? []).map((m) => m.id ?? m.name).filter(Boolean);
    },
  };
}

function anthropic(cfg) {
  const base = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v1$/, '');
  const headers = { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', ...(cfg.headers ?? {}) };
  return {
    id: 'anthropic',
    async complete({ system, user, maxTokens, temperature }) {
      const body = { model: cfg.model, max_tokens: maxTokens, temperature, messages: [{ role: 'user', content: user }], ...(system ? { system } : {}) };
      const r = await http(`${base}/v1/messages`, { headers, body, timeoutMs: cfg.timeoutMs });
      const text = (r.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (!text) throw new ProviderError(`empty response (${r.stop_reason ?? 'no content'})`);
      return { text, tokensIn: r.usage?.input_tokens, tokensOut: r.usage?.output_tokens };
    },
    async listModels() {
      const r = await http(`${base}/v1/models?limit=100`, { method: 'GET', headers, timeoutMs: cfg.timeoutMs });
      return (r.data ?? []).map((m) => m.id);
    },
  };
}

export function createProvider(id, cfg) {
  if (id === 'gemini') return gemini(cfg);
  if (id === 'anthropic') return anthropic(cfg);
  if (id === 'openai' || id === 'local' || id === 'custom' || id === 'grok') return openaiCompat(cfg, id);
  throw new Error(`unknown AI provider: ${id}`);
}
