const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const KEY = 'gemini-down-until';
const OLLAMA_MODELS = ['qwen2.5-coder:3b', 'qwen2.5-coder:1.5b'];

function zonedMidnight(timeZone, from = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(from);
  const map = {};
  for (const part of parts) if (part.type !== 'literal') map[part.type] = Number(part.value);
  const utcGuess = Date.UTC(map.year, map.month - 1, map.day + 1, 0, 0, 0);
  const shown = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcGuess));
  const got = {};
  for (const part of shown) if (part.type !== 'literal') got[part.type] = Number(part.value);
  const asUTC = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second);
  return new Date(utcGuess - (asUTC - utcGuess)).toISOString();
}

export function nextPacificMidnight() {
  return zonedMidnight('America/Los_Angeles');
}

export function classifyQuota(retryHeader, bodyText) {
  const retry = Number(retryHeader);
  const lower = String(bodyText || '').toLowerCase();
  if (/perday|per-day|per day|daily|requestsperday/.test(lower)) return nextPacificMidnight();
  const seconds = Number.isFinite(retry) && retry > 0 ? retry : 60;
  if (seconds >= 3600) return nextPacificMidnight();
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function downUntil(env) {
  if (!env.GEMINI_KV) return '';
  const value = await env.GEMINI_KV.get(KEY);
  if (!value) return '';
  if (Date.parse(value) <= Date.now()) {
    await env.GEMINI_KV.delete(KEY);
    return '';
  }
  return value;
}

async function remember(env, until) {
  if (!env.GEMINI_KV) return;
  const ttl = Math.max(60, Math.ceil((Date.parse(until) - Date.now()) / 1000));
  await env.GEMINI_KV.put(KEY, until, { expirationTtl: ttl });
}

function tunnel(env) {
  const raw = String(env.OLLAMA_TUNNEL_URL || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('OLLAMA_TUNNEL_URL is not set.'); }
  const host = parsed.hostname.toLowerCase();
  if (host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local')) {
    throw new Error('The Worker cannot call Ollama on this machine. Point OLLAMA_TUNNEL_URL at the tunnel.');
  }
  return parsed.origin;
}

async function ollama(env, messages, maxTokens) {
  const base = tunnel(env);
  let last = new Error('The backup model did not answer.');
  for (const model of OLLAMA_MODELS) {
    let res;
    try {
      res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          options: { temperature: 0.2, num_predict: maxTokens },
        }),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        last = new Error('The backup model took too long to answer.');
        continue;
      }
      throw err;
    }
    if (res.status === 404) {
      await res.text().catch(() => {});
      last = new Error(`Ollama has no ${model}.`);
      continue;
    }
    if (!res.ok) {
      await res.text().catch(() => {});
      last = new Error(`Ollama returned ${res.status}`);
      continue;
    }
    const json = await res.json();
    const text = json.message?.content || '';
    if (!String(text).trim()) {
      last = new Error('The backup model returned an empty reply.');
      continue;
    }
    return { text, model };
  }
  throw last;
}

function geminiModels(env) {
  const preferred = String(env.GEMINI_MODEL || '').trim();
  const fast = ['gemini-3.5-flash', 'gemini-3-flash-preview'];
  const lead = preferred && !/3\.8/.test(preferred) ? [preferred] : [];
  return [...new Set([...lead, ...fast])];
}

async function gemini(env, messages, maxTokens) {
  let last = new Error('The chat model is busy. Try again in a moment.');
  let attempts = 0;
  let quotaHits = 0;
  for (const model of geminiModels(env)) {
    let res;
    try {
      res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GEMINI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          max_tokens: Math.max(Number(maxTokens) || 200, 128),
          reasoning_effort: 'none',
        }),
      });
    } catch (err) {
      attempts += 1;
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        last = new Error('The chat model is busy. Try again in a moment.');
        continue;
      }
      throw err;
    }
    attempts += 1;
    if (res.status === 503 || res.status === 502) {
      await res.text().catch(() => {});
      last = new Error('The chat model is busy. Try again in a moment.');
      continue;
    }
    if (res.status === 429) {
      const detail = await res.text();
      const error = new Error('quota');
      error.code = 'quota';
      error.until = classifyQuota(res.headers.get('retry-after'), detail);
      last = error;
      quotaHits += 1;
      continue;
    }
    if (!res.ok) {
      await res.text().catch(() => {});
      last = new Error(`Gemini returned ${res.status}`);
      continue;
    }
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content || '';
    if (!String(text).trim()) {
      last = new Error('The chat model returned an empty reply.');
      continue;
    }
    return { text, model };
  }
  if (quotaHits > 0 && quotaHits === attempts) throw last;
  throw last;
}

export async function answer(env, messages, maxTokens) {
  const held = await downUntil(env);
  if (held) {
    const local = await ollama(env, messages, maxTokens);
    local.quotaReset = held;
    return local;
  }
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set on the server.');
  try {
    return await gemini(env, messages, maxTokens);
  } catch (err) {
    if (err.code !== 'quota') throw err;
    await remember(env, err.until);
    const local = await ollama(env, messages, maxTokens);
    local.quotaReset = err.until;
    return local;
  }
}
