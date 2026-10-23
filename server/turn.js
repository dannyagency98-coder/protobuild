const { completeChat } = require('./llm');
const { validateCss, cssFromInstruction } = require('./css-safe');
const { explicitTargets } = require('./agent');
const { applyPrototype } = require('./prototype');
const { swapPart } = require('./borrow');
const { applyModelPlan } = require('./model-edit');
const env = require('./env');

function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return url || 'that page'; }
}

function borrowRequest(text) {
  const from = text.match(/\b(header|footer|nav)\b[\s\S]{0,50}\b(?:from|of)\s+(?:the\s+)?([a-z0-9][a-z0-9.-]{1,80})/i);
  if (from) return { part: from[1].toLowerCase(), name: from[2].toLowerCase().replace(/[.?]$/, '') };
  const lead = text.match(/\b(?:use|take|bring|swap)\b[\s\S]{0,40}\b([a-z0-9][a-z0-9.-]{1,80})\b[\s\S]{0,24}\b(header|footer|nav)\b/i);
  if (lead) return { part: lead[2].toLowerCase(), name: lead[1].toLowerCase().replace(/[.?]$/, '') };
  return null;
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

function priorMessages(history) {
  return (Array.isArray(history) ? history : []).slice(-6).map((item) => ({
    role: item.role === 'ai' || item.role === 'assistant' ? 'assistant' : 'user',
    content: String(item.text || item.content || '').replace(/\s+/g, ' ').trim().slice(0, 400),
  })).filter((item) => item.content);
}

function userContent(message, images) {
  const text = String(message || '').trim() || 'Use the attached image as a reference.';
  const pics = (Array.isArray(images) ? images : []).slice(0, 2).filter((url) => /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(String(url)) && String(url).length < 2000000);
  if (!pics.length) return text;
  return [{ type: 'text', text }, ...pics.map((url) => ({ type: 'image_url', image_url: { url } }))];
}

async function runTurn({ message, purpose, history, images, activeJob, onEvent, deps }) {
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
      { role: 'system', content: 'You are Protobuild. Answer in a short paragraph. Do not start a capture. The person may attach a reference image.' },
      ...priorMessages(history),
      { role: 'user', content: userContent(text, images) },
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
    if (!deps.share) {
      const reply = 'Use Share for a link. That link can open on a phone.';
      onEvent?.({ type: 'token', text: reply });
      return { reply, job: activeJob };
    }
    const shared = await deps.share(activeJob);
    const link = shared?.shareUrl || '';
    const reply = link ? `Live link: ${link}` : 'I could not turn the link on.';
    onEvent?.({ type: 'token', text: reply });
    return { reply, job: shared || activeJob, shareUrl: link };
  }

  const page = deps.readHtml ? deps.readHtml(activeJob) : '';
  const borrowed = borrowRequest(text);
  if (borrowed && deps.findCapture) {
    const donor = await deps.findCapture(borrowed.name, activeJob);
    const label = borrowed.part;
    if (!donor) {
      const reply = `There is no finished copy of ${borrowed.name} to take that ${label} from. Scan that site first.`;
      onEvent?.({ type: 'token', text: reply });
      return { reply, job: activeJob, editFailed: true };
    }
    const next = swapPart(page, donor.html, label, `/preview/${donor.id}/`);
    const reply = next
      ? `The ${label} now comes from ${donor.host}.`
      : `That copy of ${donor.host} does not have a ${label} to use.`;
    if (next && deps.writeHtml) await deps.writeHtml(activeJob, next);
    onEvent?.({ type: 'token', text: reply });
    return { reply, job: activeJob, edited: !!next, editFailed: !next };
  }
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
      const reply = 'That change is waiting below. Apply it when it looks right.';
      onEvent?.({ type: 'token', text: reply });
      return {
        reply,
        job: activeJob,
        proposals: [{ kind: 'css', jobId: activeJob.id, before: '(current custom CSS)', after: checked.css, css: checked.css }],
      };
    }
  }

  if (isQuestion(text)) {
    const turn = await say([
      { role: 'system', content: 'Answer in two short sentences from the page text. If it is not on the page, say so.' },
      ...priorMessages(history),
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
      content: 'You edit a captured page. Return only JSON {"css":"","replace":[{"from":"","to":""}],"move":{"node":"","where":"above","anchor":""}}. css may set color, type, size, alignment, spacing, borders, width, flex, grid, order, float, or display, and it may move or add a section. replace.from must be copied exactly from the page text. replace.to may include a short HTML section. Leave a field as an empty string or empty list when you are not using it. Do not invent page parts.',
    },
    ...priorMessages(history),
    { role: 'user', content: userContent(`Page text:\n${visibleText(page)}\n\nRequest: ${text}`, images) },
  ], 420, onEvent);
  const parsed = parseModelJson(turn.text);
  const plan = applyModelPlan(page, parsed);
  const proposals = [];
  if (plan.css) {
    const checked = validateCss(plan.css);
    if (checked.ok) proposals.push({ kind: 'css', jobId: activeJob.id, before: '(current custom CSS)', after: checked.css, css: checked.css });
  }
  if (plan.html && plan.html !== page) {
    proposals.push({ kind: 'html', jobId: activeJob.id, before: visibleText(page).slice(0, 280), after: (plan.notes[0] || 'Updated page'), html: plan.html });
  }
  if (!proposals.length) {
    const reply = 'That change could not be applied. The page can take a new logo, new wording, a move, or styling for color, type, size, layout, borders, and spacing. Use Share when you want a link.';
    onEvent?.({ type: 'token', text: reply });
    return { reply, job: activeJob, model: turn.model, quotaReset: turn.quotaReset || '', editFailed: true };
  }
  const reply = 'That change is waiting below. Apply it when it looks right.';
  onEvent?.({ type: 'token', text: reply });
  return { reply, job: activeJob, proposals, model: turn.model, quotaReset: turn.quotaReset || '', note: turn.note || '' };
}

module.exports = { runTurn, parseModelJson };
