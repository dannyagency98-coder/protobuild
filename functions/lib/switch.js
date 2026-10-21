const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const KEY = 'gemini-down-until';
const OLLAMA_MODEL = 'qwen2.5-coder:1.5b';

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
  let res;
  try {
    res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages,
        stream: false,
        options: { temperature: 0.2, num_predict: maxTokens },
      }),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new Error('The backup model took too long to answer.');
    throw err;
  }
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  const json = await res.json();
  return { text: json.message?.content || '', model: OLLAMA_MODEL };
}

async function gemini(env, messages, maxTokens) {
  let res;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GEMINI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          model: env.GEMINI_MODEL || 'gemini-3.8-flash',
          messages,
          temperature: 0.2,
          max_tokens: maxTokens,
        }),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new Error('Gemini took too long to answer.');
      throw err;
    }
    if (res.status !== 503 && res.status !== 502) break;
  }
  if (res.status === 429) {
    const detail = await res.text();
    const error = new Error('quota');
    error.code = 'quota';
    error.until = classifyQuota(res.headers.get('retry-after'), detail);
    throw error;
  }
  if (!res.ok) throw new Error(`Gemini returned ${res.status}`);
  const json = await res.json();
  return { text: json.choices?.[0]?.message?.content || '', model: env.GEMINI_MODEL || 'gemini-3.8-flash' };
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
