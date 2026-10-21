const { completeChat } = require('./llm');
const { validateCss, cssFromInstruction } = require('./css-safe');
const { explicitTargets } = require('./agent');
const { applyPrototype } = require('./prototype');
const { applyModelPlan } = require('./model-edit');
const env = require('./env');

function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return url || 'that page'; }
}

function parseModelJson(text) {
  const raw = String(text || '').replace(/```json|```/gi, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { css: '', line: '', replace: [], move: null };
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return {
      css: String(parsed.css || ''),
      line: String(parsed.line || ''),
      replace: Array.isArray(parsed.replace) ? parsed.replace : [],
      move: parsed.move && typeof parsed.move === 'object' ? parsed.move : null,
    };
  } catch {
    return { css: '', line: '', replace: [], move: null };
  }
}

async function say(messages, maxTokens, onEvent, stream) {
  return completeChat(messages, {
    maxTokens,
    onMeta: (meta) => onEvent?.({ type: 'meta', model: meta.model, note: meta.note, quotaReset: meta.quotaReset }),
    onToken: stream ? (text) => onEvent?.({ type: 'token', text }) : undefined,
  });
}

function isQuestion(text) {
  return /\?\s*$/.test(text) || /^(what|why|how|who|when|where|which)\b/i.test(text);
}

function visibleText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1600);
}

function styleLine(text, host) {
  const lower = text.toLowerCase();
  if (/popup|cookie|consent/.test(lower)) return 'The popup is hidden.';
  if (/georgia|font|typeface/.test(lower)) return 'The type is updated.';
  if (/move|push|shift|nudge/.test(lower)) return 'That section has been moved.';
  if (/color|background|blue|red|black|white/.test(lower)) return 'The color is updated.';
  if (/bigger|smaller|font-size|px/.test(lower)) return 'The size is updated.';
  return `${host} is updated.`;
}

async function runTurn({ message, purpose, activeJob, onEvent, deps }) {
  const text = String(message || '').trim();
  if (purpose === 'ready') {
    if (!activeJob) return { reply: 'That capture is gone.', job: null };
    const host = hostOf(activeJob.source_url);
    if (!env.geminiApiKey) {
      const reply = `${host} is in the preview.`;
      onEvent?.({ type: 'token', text: reply });
      return { reply, job: activeJob };
    }
    const turn = await say([
      { role: 'system', content: 'Reply with one short sentence only. Example: nike.com is in the preview.' },
      { role: 'user', content: `${host} finished copying and is in the preview.` },
    ], 60, onEvent);
    const reply = (turn.text || `${host} is in the preview.`).trim().split('\n')[0];
    onEvent?.({ type: 'token', text: reply });
    return { reply, job: activeJob, model: turn.model, quotaReset: turn.quotaReset || '', note: turn.note || '' };
  }

  const urls = explicitTargets(text);
  if (urls.length && purpose !== 'edit') {
    const mode = /\bimages?\s*only\b|\bonly images\b/i.test(text) ? 'images' : 'clone';
    try {
      const job = await deps.scan(urls[0], mode, text);
      const host = hostOf(job.source_url);
      return { reply: `Copying ${host}.`, job, pendingLine: true };
    } catch (err) {
      return { reply: err.message || 'That link was not copied.', job: null };
    }
  }

  if (!activeJob) {
    const turn = await say([
      { role: 'system', content: 'You are Protobuild. Answer in a short paragraph. Do not start a capture.' },
      { role: 'user', content: text },
    ], 220, onEvent, true);
    const reply = (turn.text || turn.error || 'No answer came back. Send that again.').trim();
    if (!turn.text) onEvent?.({ type: 'token', text: reply });
    return { reply, job: null, model: turn.model, quotaReset: turn.quotaReset || '', note: turn.note || '' };
  }

  if (activeJob.status !== 'done') {
    const start = Date.parse(activeJob.created_at || '');
    const secs = Number.isFinite(start) ? Math.max(0, Math.floor((Date.now() - start) / 1000)) : 0;
    const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    return { reply: `This page is still copying (${clock}). It can be edited when the preview is ready.`, job: activeJob };
  }

  if (/\b(host|publish)\b/i.test(text)) {
    if (!deps.host) {
      const reply = 'Hosting is not available from this screen.';
      onEvent?.({ type: 'token', text: reply });
      return { reply, job: activeJob };
    }
    try {
      const hosted = await deps.host(activeJob);
      onEvent?.({ type: 'token', text: hosted.reply });
      return { reply: hosted.reply, job: hosted.job || activeJob };
    } catch (err) {
      const reply = err.message || 'Cloudflare did not accept the page.';
      onEvent?.({ type: 'token', text: reply });
      return { reply, job: activeJob };
    }
  }

  const page = deps.readHtml ? deps.readHtml(activeJob) : '';
  const prototype = applyPrototype(page, text, { logoSrc: deps.logoSrc ? deps.logoSrc(activeJob) : '' });
  if (prototype) {
    if (prototype.error) {
      onEvent?.({ type: 'token', text: prototype.error });
      return { reply: prototype.error, job: activeJob, editFailed: true };
    }
    if (prototype.html && deps.writeHtml) await deps.writeHtml(activeJob, prototype.html);
    onEvent?.({ type: 'token', text: prototype.line });
    return { reply: prototype.line, job: activeJob, edited: true };
  }

  const outline = deps.outline ? deps.outline(activeJob) : { sections: [] };
  const localCss = cssFromInstruction(text, outline);
  if (localCss) {
    const checked = validateCss(localCss);
    if (checked.ok) {
      await deps.writeCss(activeJob, checked.css);
      const reply = styleLine(text, hostOf(activeJob.source_url));
      onEvent?.({ type: 'token', text: reply });
      return { reply, job: activeJob, edited: true };
    }
  }

  if (isQuestion(text)) {
    const turn = await say([
      { role: 'system', content: 'Answer in two short sentences from the page text. If it is not on the page, say so.' },
      { role: 'user', content: `Page text:\n${visibleText(page)}\n\n${text}` },
    ], 160, onEvent, true);
    const reply = (turn.text || turn.error || 'That is not in the page text.').trim();
    if (!turn.text) onEvent?.({ type: 'token', text: reply });
    return { reply, job: activeJob, model: turn.model, quotaReset: turn.quotaReset || '', note: turn.note || '' };
  }

  const host = hostOf(activeJob.source_url);
  const turn = await say([
    {
      role: 'system',
      content: 'You edit a captured page. Return only JSON {"css":"","replace":[{"from":"","to":""}],"move":{"node":"","where":"above","anchor":""}}. css may set color, type, size, alignment, spacing, borders, width, flex, or display. replace.from must be copied exactly from the page text. Leave a field as an empty string or empty list when you are not using it. Do not invent page parts.',
    },
    { role: 'user', content: `Page text:\n${visibleText(page)}\n\nRequest: ${text}` },
  ], 420, onEvent);
  const parsed = parseModelJson(turn.text);
  const plan = applyModelPlan(page, parsed);
  if (!plan.html && !plan.css) {
    const reply = 'That change could not be applied. The page can take a new logo, new wording, a move, or styling for color, type, size, alignment, borders, and spacing. Say host this when you want it on Cloudflare.';
    onEvent?.({ type: 'token', text: reply });
    return { reply, job: activeJob, model: turn.model, quotaReset: turn.quotaReset || '', editFailed: true };
  }
  if (plan.html && deps.writeHtml) await deps.writeHtml(activeJob, plan.html);
  if (plan.css) await deps.writeCss(activeJob, plan.css);
  const reply = plan.notes[0] || styleLine(text, host);
  onEvent?.({ type: 'token', text: reply });
  return { reply, job: activeJob, edited: true, model: turn.model, quotaReset: turn.quotaReset || '', note: turn.note || '' };
}

module.exports = { runTurn, parseModelJson };
