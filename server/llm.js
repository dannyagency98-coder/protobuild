const fs = require('fs');
const path = require('path');
const env = require('./env');

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const QUOTA_FILE = path.join(env.root, 'data', 'gemini-quota.json');
const FALLBACK_MODEL = 'qwen2.5-coder:3b';

function quotaUntil() {
  try {
    const data = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
    if (data.until && Date.parse(data.until) > Date.now()) return data.until;
  } catch { /* no quota hold */ }
  return '';
}

function rememberQuota(until) {
  fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true });
  fs.writeFileSync(QUOTA_FILE, JSON.stringify({ until, model: FALLBACK_MODEL }));
}

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

function nextPacificMidnight() {
  return zonedMidnight('America/Los_Angeles');
}

function classifyQuota(retryHeader, bodyText) {
  const retry = Number(retryHeader);
  const lower = String(bodyText || '').toLowerCase();
  const daily = /perday|per-day|per day|daily|requestsperday/.test(lower);
  if (daily) return nextPacificMidnight();
  const seconds = Number.isFinite(retry) && retry > 0 ? retry : 60;
  if (seconds >= 3600) return nextPacificMidnight();
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function quotaNote(until, localModel) {
  const when = new Date(until).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  if (localModel) return `Gemini is paused until ${when} Pacific.`;
  return `Gemini is paused until ${when} Pacific.`;
}

function safeJson(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function textOnly(messages) {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const text = message.content
      .filter((part) => part && part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    return { ...message, content: text };
  });
}

function asTools(calls) {
  return (calls || []).map((call, index) => ({
    id: call.id || `call_${index}`,
    type: 'function',
    function: {
      name: call.function?.name || call.name || '',
      arguments: typeof call.function?.arguments === 'string'
        ? call.function.arguments
        : JSON.stringify(call.function?.arguments || call.arguments || {}),
    },
  })).filter((call) => call.function.name);
}

function parseChoice(json, model) {
  const message = json.choices?.[0]?.message || json.message || {};
  return {
    text: typeof message.content === 'string' ? message.content : '',
    toolCalls: asTools(message.tool_calls),
    model,
    error: null,
  };
}

async function readSse(res, model, onToken) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  const calls = [];
  const take = (raw) => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let json;
    try { json = JSON.parse(data); } catch { return; }
    const delta = json.choices?.[0]?.delta || {};
    if (delta.content) {
      text += delta.content;
      onToken(delta.content);
    }
    for (const part of delta.tool_calls || []) {
      const index = part.index || 0;
      const slot = calls[index] || { id: '', name: '', arguments: '' };
      if (part.id) slot.id = part.id;
      if (part.function?.name) slot.name += part.function.name;
      if (part.function?.arguments) slot.arguments += part.function.arguments;
      calls[index] = slot;
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n')) >= 0) {
      take(buf.slice(0, cut));
      buf = buf.slice(cut + 1);
    }
  }
  if (buf.trim()) take(buf);
  return {
    text,
    toolCalls: asTools(calls.map((call) => ({
      id: call.id,
      function: { name: call.name, arguments: call.arguments },
    }))),
    model,
    error: null,
  };
}

function geminiModels() {
  const preferred = String(env.geminiModel || 'gemini-3.8-flash').trim() || 'gemini-3.8-flash';
  return [...new Set([preferred, 'gemini-3.5-flash', 'gemini-3-flash-preview'])];
}

async function gemini(messages, { tools, maxTokens }) {
  let last = new Error('The chat model is busy. Try again in a moment.');
  let attempts = 0;
  let quotaHits = 0;
  for (const model of geminiModels()) {
    const body = {
      model,
      messages,
      temperature: 0.4,
      max_tokens: Math.max(maxTokens || 4096, 128),
      reasoning_effort: 'low',
    };
    if (tools?.length) body.tools = tools;
    let res;
    try {
      res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.geminiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      attempts += 1;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
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
      const detail = await res.text();
      last = new Error(`Gemini returned ${res.status}`);
      last.code = 'gemini';
      last.detail = detail.slice(0, 280);
      continue;
    }
    const choice = parseChoice(await res.json(), model);
    if (!choice.text && !(choice.toolCalls || []).length) {
      last = new Error('The chat model returned an empty reply.');
      continue;
    }
    return choice;
  }
  if (quotaHits > 0 && quotaHits === attempts) {
    rememberQuota(last.until);
    throw last;
  }
  throw last;
}

function forOllama(messages) {
  return textOnly(messages).map((message) => {
    if (message.tool_calls) {
      return {
        role: 'assistant',
        content: message.content || '',
        tool_calls: message.tool_calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.function.name,
            arguments: safeJson(call.function.arguments),
          },
        })),
      };
    }
    if (message.role === 'tool') {
      return { role: 'tool', content: String(message.content || ''), tool_call_id: message.tool_call_id };
    }
    return { role: message.role, content: String(message.content || '') };
  });
}

let pinnedModel = '';

async function readOllama(res, model, onToken) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let tools = [];
  const take = (raw) => {
    const line = raw.trim();
    if (!line) return;
    let json;
    try { json = JSON.parse(line); } catch { return; }
    const piece = json.message?.content || '';
    if (piece) {
      text += piece;
      onToken?.(piece);
    }
    if (json.done && json.message?.tool_calls) tools = asTools(json.message.tool_calls);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n')) >= 0) {
      take(buf.slice(0, cut));
      buf = buf.slice(cut + 1);
    }
  }
  if (buf.trim()) take(buf);
  return { text, toolCalls: tools, model, error: null };
}

async function ollamaChat(messages, bag) {
  const { tools, maxTokens, onToken, model } = bag;
  const note = bag.quotaReset ? quotaNote(bag.quotaReset, model) : (bag.note || '');
  if (bag.onMeta) bag.onMeta({ model, quotaReset: bag.quotaReset || '', note });
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: forOllama(messages),
      tools: tools?.length ? tools : undefined,
      stream: true,
      keep_alive: '30m',
      options: { temperature: 0.3, num_predict: Math.min(maxTokens || 220, 480), num_ctx: 2048 },
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail.slice(0, 240) || `Ollama returned ${res.status}`);
  }
  const turn = await readOllama(res, model, onToken);
  if (/"type"\s*:\s*"function"/.test(turn.text) && /parameters/.test(turn.text)) turn.text = '';
  turn.toolCalls = (turn.toolCalls || []).filter((call) => {
    const args = safeJson(call.function.arguments);
    if (call.function.name === 'scan') return !!args.url;
    if (call.function.name === 'edit_css') return !!args.css;
    if (call.function.name === 'edit_html') return !!args.find && args.replace !== undefined;
    return true;
  });
  turn.note = note;
  turn.quotaReset = bag.quotaReset || '';
  return turn;
}

async function localModel(messages, options) {
  const models = [pinnedModel, options.prefer, FALLBACK_MODEL, 'qwen2.5-coder:1.5b']
    .filter((model, index, list) => model && list.indexOf(model) === index);
  let last = 'Ollama is not running on this Mac.';
  for (const model of models) {
    try {
      const turn = await ollamaChat(messages, { ...options, model });
      pinnedModel = model;
      return turn;
    } catch (err) {
      last = err.message || last;
      if (pinnedModel === model) pinnedModel = '';
      if (/ECONNREFUSED|fetch failed|ECONNRESET/i.test(last)) break;
      if (!/not found|does not exist|try pulling/i.test(last)) break;
    }
  }
  return { text: '', toolCalls: [], model: options.prefer, error: last };
}

async function completeChat(messages, options = {}) {
  const allowLocal = options.allowLocal !== false;
  const onMeta = options.onMeta || (() => {});
  const held = quotaUntil();
  if (env.geminiApiKey && !held) {
    try {
      const { onToken, ...rest } = options;
      const turn = await gemini(messages, rest);
      if (turn.model) onMeta({ model: turn.model, quotaReset: '', note: '' });
      if (turn.text && onToken) onToken(turn.text);
      return turn;
    } catch (err) {
      if (err.code === 'quota') {
        if (!allowLocal) {
          return {
            text: '',
            toolCalls: [],
            model: env.geminiModel,
            quotaReset: err.until,
            error: quotaNote(err.until, null),
          };
        }
        const note = quotaNote(err.until, FALLBACK_MODEL);
        const local = await localModel(messages, { ...options, prefer: FALLBACK_MODEL, quotaReset: err.until, note });
        local.quotaReset = err.until;
        local.note = local.error ? `${quotaNote(err.until, null)} ${local.error}` : quotaNote(err.until, local.model);
        if (local.error) onMeta({ model: local.model, quotaReset: err.until, note: local.note });
        return local;
      }
      return {
        text: '',
        toolCalls: [],
        model: env.geminiModel,
        error: err.detail ? `${err.message}. ${err.detail}` : (err.message || 'Gemini did not answer.'),
      };
    }
  }
  if (held) {
    if (!allowLocal) {
      return {
        text: '',
        toolCalls: [],
        model: env.geminiModel,
        quotaReset: held,
        error: quotaNote(held, null),
      };
    }
    const note = quotaNote(held, FALLBACK_MODEL);
    const local = await localModel(messages, { ...options, prefer: FALLBACK_MODEL, quotaReset: held, note });
    local.quotaReset = held;
    local.note = local.error ? `${quotaNote(held, null)} ${local.error}` : quotaNote(held, local.model);
    if (local.error) onMeta({ model: local.model, quotaReset: held, note: local.note });
    return local;
  }
  if (allowLocal) {
    return localModel(messages, { ...options, prefer: FALLBACK_MODEL });
  }
  return {
    text: '',
    toolCalls: [],
    model: '',
    error: 'GEMINI_API_KEY is not set on the server.',
  };
}

module.exports = { completeChat, FALLBACK_MODEL };
