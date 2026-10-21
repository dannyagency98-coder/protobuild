import { currentUser, forgetJob, json, listStoredIds, queueCapture, readStoredJob } from '../lib/edge.js';
import { answer } from '../lib/switch.js';
import { validateCss } from '../lib/css.js';
import { applyReplacements } from '../lib/edit.js';

const PAGES_USER_ID = '6f0c1a2e-7b34-4d15-8a10-000000000001';

async function actor(request, env) {
  if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
    const signedIn = await currentUser(request, env);
    if (signedIn) return signedIn;
  }
  return { id: String(env.PAGES_USER_ID || PAGES_USER_ID), email: 'pages' };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  const user = await actor(request, env);
  if (!user) return json({ error: 'This deploy has no capture account yet.' }, 503);

  if (request.method === 'POST' && path.endsWith('/jobs') && !/\/jobs\/[^/]+/.test(path)) {
    const body = await request.json().catch(() => ({}));
    if (!body.rights_confirmed) return json({ error: 'Rights confirmation required' }, 400);
    return queueCapture(env, user, body);
  }

  const jobAction = path.match(/\/jobs\/([^/]+)(?:\/([^/]+))?$/);
  if (jobAction && jobAction[2] === 'images' && request.method === 'GET') {
    return jobImages(env, user, jobAction[1], url.searchParams.get('small') === '1');
  }
  if (jobAction && jobAction[2] === 'zip' && request.method === 'GET') {
    return jobZip(env, user, jobAction[1], url.searchParams.get('type') === 'images' ? 'images' : 'full');
  }
  if (jobAction && jobAction[2] === 'stop' && request.method === 'POST') {
    return stopJob(env, user, jobAction[1]);
  }
  if (jobAction && !jobAction[2] && request.method === 'DELETE') {
    return removeJob(env, user, jobAction[1]);
  }
  if (jobAction && !jobAction[2] && request.method === 'GET') {
    const job = await loadJob(env, user.id, jobAction[1]);
    if (!job) return json({ error: 'Job not found' }, 404);
    return json(publicJob(env, job));
  }

  if (request.method === 'DELETE' && path.endsWith('/jobs')) {
    return removeAllJobs(env, user);
  }

  if (request.method === 'GET' && path.endsWith('/jobs')) {
    const ids = await listStoredIds(env, user.id);
    const jobs = [];
    for (const id of ids) {
      const job = await readStoredJob(env, id);
      if (job && job.user_id === user.id) jobs.push(publicJob(env, job));
    }
    return json({ jobs });
  }

  if (request.method === 'POST' && path.endsWith('/agent')) {
    return handleAgent(request, env, user);
  }

  return json({ error: 'Not found' }, 404);
}

function sse(payload) {
  const chunks = [];
  if (payload.model) chunks.push(`event: meta\ndata: ${JSON.stringify({ model: payload.model, note: '', quotaReset: payload.quotaReset || '' })}\n\n`);
  if (payload.reply) chunks.push(`event: token\ndata: ${JSON.stringify({ text: payload.reply })}\n\n`);
  chunks.push(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
  return new Response(chunks.join(''), {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return 'that page'; }
}

function firstUrl(text) {
  const raw = String(text || '');
  const explicit = raw.match(/https?:\/\/[^\s)]+/i);
  if (explicit) return explicit[0].replace(/[.,]$/, '');
  const bare = raw.match(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[^\s)]*)?/i);
  return bare ? `https://${bare[0].replace(/[.,]$/, '')}` : '';
}

async function handleAgent(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const message = String(body.message || '');
  const purpose = body.purpose || '';
  const jobId = body.activeJobId || '';

  if (purpose === 'ready' && jobId) {
    const job = await loadJob(env, user.id, jobId);
    if (!job) return sse({ reply: 'That capture is gone.', job: null });
    const host = hostOf(job.source_url);
    try {
      const turn = await answer(env, [
        { role: 'system', content: 'Reply with one short sentence only. Example: nike.com is in the preview.' },
        { role: 'user', content: `${host} finished copying and is in the preview.` },
      ], 60);
      const reply = (turn.text || `${host} is in the preview.`).trim().split('\n')[0];
      return sse({ reply, job: publicJob(env, job), model: turn.model, quotaReset: turn.quotaReset || '' });
    } catch (err) {
      return sse({ reply: `${host} is in the preview.`, job: publicJob(env, job), error: err.message });
    }
  }

  const url = firstUrl(message);
  if (url && purpose !== 'edit') {
    const mode = /\bimages?\s*only\b|\bonly images\b/i.test(message) ? 'images' : 'clone';
    const queued = await queueCapture(env, user, { url, mode, rights_confirmed: true, options: {} });
    const payload = await queued.json();
    if (!queued.ok) return sse({ reply: payload.error || 'That link was not copied.', job: null });
    return sse({ reply: `Copying ${hostOf(payload.source_url)}.`, job: publicJob(env, payload), pendingLine: true });
  }

  if (!jobId) {
    try {
      const turn = await answer(env, [
        { role: 'system', content: 'You are Protobuild. Answer in a short paragraph.' },
        { role: 'user', content: message },
      ], 400);
      return sse({ reply: (turn.text || '').trim(), job: null, model: turn.model, quotaReset: turn.quotaReset || '' });
    } catch (err) {
      return sse({ reply: err.message || 'The chat did not answer.', job: null });
    }
  }

  if (!env.R2) return sse({ reply: 'R2 is not bound on this deploy, so the edit cannot be saved.', job: null });
  const job = await loadJob(env, user.id, jobId);
  if (!job) return sse({ reply: 'That capture is gone.', job: null });
  if (job.status !== 'done') return sse({ reply: 'The page is still copying. I can change it when the preview is ready.', job: publicJob(env, job) });
  const pageObj = await env.R2.get(`sites/${jobId}/index.html`);
  if (!pageObj) return sse({ reply: 'The page is not in storage yet.', job: publicJob(env, job) });
  const page = await pageObj.text();
  let turn;
  try {
    turn = await answer(env, [
      { role: 'system', content: 'You edit a captured page. Return only JSON {"css":"","replace":[{"from":"","to":""}]}. css may set color, type, size, alignment, spacing, borders, width, flex, or display. replace.from must be copied exactly from the page text. Leave a field empty when you are not using it.' },
      { role: 'user', content: `Page text:\n${page.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1600)}\n\nRequest: ${message}` },
    ], 400);
  } catch (err) {
    return sse({ reply: err.message || 'The edit did not run.', job: publicJob(env, job) });
  }
  const parsed = parseJson(turn.text);
  const replaced = applyReplacements(page, parsed.replace);
  const checked = parsed.css ? validateCss(parsed.css) : { ok: false };
  if (!replaced.html && !checked.ok) {
    return sse({
      reply: 'That change could not be applied. Wording, color, type, size, alignment, borders, and spacing can be changed.',
      job: publicJob(env, job),
      model: turn.model,
      editFailed: true,
    });
  }
  if (replaced.html) {
    await env.R2.put(`sites/${jobId}/index.html`, replaced.html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  }
  if (checked.ok) {
    const prevObj = await env.R2.get(`sites/${jobId}/custom.css`);
    const prev = prevObj ? (await prevObj.text()).trim() : '';
    await env.R2.put(`sites/${jobId}/custom.css`, prev ? `${prev}\n\n${checked.css}` : checked.css, {
      httpMetadata: { contentType: 'text/css' },
    });
  }
  const reply = replaced.notes[0] || `${hostOf(job.source_url)} is updated.`;
  return sse({ reply, job: publicJob(env, job), edited: true, model: turn.model, quotaReset: turn.quotaReset || '' });
}

function parseJson(text) {
  const raw = String(text || '').replace(/```json|```/gi, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { css: '', line: '' };
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return { css: '', line: '' }; }
}

function serviceHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    ...extra,
  };
}

async function loadJob(env, userId, jobId) {
  const stored = await readStoredJob(env, jobId);
  if (stored) return stored.user_id === userId ? stored : null;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return null;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/jobs?id=eq.${jobId}&user_id=eq.${userId}&select=*`, {
    headers: serviceHeaders(env),
  });
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] : null;
}

async function saveJob(env, job) {
  if (!env.R2 || !job?.id) return;
  await env.R2.put(`sites/${job.id}/job.json`, JSON.stringify(job), {
    httpMetadata: { contentType: 'application/json' },
  });
}

function publicJob(env, job) {
  if (!job?.id) return job;
  const preview = env.PREVIEW_DOMAIN
    ? `https://p-${job.id}.${env.PREVIEW_DOMAIN}/`
    : `/preview/${job.id}/`;
  return { ...job, previewUrl: preview };
}

function viewableListed(img) {
  const type = String(img.contentType || '').toLowerCase().split(';')[0].trim();
  const local = String(img.local || '');
  if (type === 'image/jxl' || type === 'image/jpeg-xl' || /\.jxl$/i.test(local)) return false;
  if (type.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|svg|ico|avif|bmp)$/i.test(local);
}

async function jobImages(env, user, jobId, showSmall) {
  const job = await loadJob(env, user.id, jobId);
  if (!job) return json({ error: 'Job not found' }, 404);
  if (!env.R2) return json({ images: [], imageCount: 0, skipped: 0, showSmall });
  const obj = await env.R2.get(`sites/${jobId}/manifest.json`);
  if (!obj) return json({ images: [], imageCount: 0, skipped: 0, showSmall });
  const man = await obj.json().catch(() => ({}));
  const seen = new Set();
  const images = [];
  let skipped = 0;
  for (const img of man.images || []) {
    if (!showSmall && img.small) continue;
    const local = String(img.local || '').replace(/\\/g, '/');
    if (!local || local.includes('..') || seen.has(local)) continue;
    if (!viewableListed(img)) { skipped += 1; continue; }
    seen.add(local);
    images.push({ ...img, local, src: `/preview/${jobId}/${local}` });
  }
  return json({ images, imageCount: images.length, skipped, totalMB: man.totalMB, showSmall });
}

async function jobZip(env, user, jobId, type) {
  const job = await loadJob(env, user.id, jobId);
  if (!job) return json({ error: 'Job not found' }, 404);
  if (!env.R2) return json({ error: 'ZIP not ready yet' }, 404);
  const obj = await env.R2.get(`sites/${jobId}/${type === 'images' ? 'images.zip' : 'full.zip'}`);
  if (!obj) return json({ error: 'ZIP not ready yet' }, 404);
  return new Response(obj.body, {
    headers: { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store' },
  });
}

async function stopJob(env, user, jobId) {
  const job = await loadJob(env, user.id, jobId);
  if (!job) return json({ error: 'Job not found' }, 404);
  const stopped = { ...job, status: 'failed', error: 'Stopped.', finished_at: new Date().toISOString() };
  await saveJob(env, stopped);
  return json(publicJob(env, stopped));
}

async function deleteStoredSite(env, jobId) {
  if (!env.R2) return;
  let cursor = undefined;
  do {
    const listed = await env.R2.list({ prefix: `sites/${jobId}/`, cursor });
    await Promise.all((listed.objects || []).map((item) => env.R2.delete(item.key)));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function removeJob(env, user, jobId) {
  const job = await loadJob(env, user.id, jobId);
  if (!job) return json({ error: 'Job not found' }, 404);
  await forgetJob(env, user.id, jobId);
  await deleteStoredSite(env, jobId);
  return json({ ok: true, id: jobId });
}

async function removeAllJobs(env, user) {
  const ids = await listStoredIds(env, user.id);
  if (env.R2) {
    await env.R2.put(`indexes/${user.id}.json`, '[]', {
      httpMetadata: { contentType: 'application/json' },
    });
  }
  for (const id of ids) await deleteStoredSite(env, id);
  return json({ ok: true, removed: ids.length });
}
