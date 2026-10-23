import { cancelCaptureRun, currentUser, forgetJob, json, listStoredIds, queueCapture, queueUpload, readStoredJob } from '../lib/edge.js';
import { passwordAuth, updatePassword } from '../lib/auth.js';
import { answer } from '../lib/switch.js';
import { validateCss } from '../lib/css.js';
import { applyChange, saveLogo, setShare, shareLive, undoChange } from '../lib/actions.js';

const PAGES_USER_ID = '6f0c1a2e-7b34-4d15-8a10-000000000001';

async function actor(request, env) {
  if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) return currentUser(request, env);
  return { id: String(env.PAGES_USER_ID || PAGES_USER_ID), email: 'pages' };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'GET' && path.endsWith('/config')) {
    return json({
      hosted: true,
      auth: !!(env.SUPABASE_URL && env.SUPABASE_ANON_KEY),
      maxPromptsPerDay: Number(env.MAX_PROMPTS_PER_DAY) || 1500,
      previewTTLDays: 30,
    });
  }
  if (request.method === 'POST' && /\/auth\/(login|signup|refresh)$/.test(path)) {
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    if (path.endsWith('/signup')) return json({ error: 'Accounts are not open for signup.' }, 403);
    const kind = path.endsWith('/refresh') ? 'refresh' : 'login';
    if (kind !== 'refresh' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Enter a valid email address.' }, 400);
    if (kind !== 'refresh' && String(body.password || '').length < 6) return json({ error: 'Use a password of at least 6 characters.' }, 400);
    const result = await passwordAuth(env, kind, email, kind === 'refresh' ? String(body.refresh_token || '') : String(body.password || ''));
    if (result.error) return json({ error: result.error }, result.status || 400);
    return json(result.session || { confirm: true, email: result.email });
  }

  const user = await actor(request, env);
  if (!user) return json({ error: 'Sign in to continue.' }, 401);

  if (request.method === 'POST' && path.endsWith('/auth/password')) {
    const body = await request.json().catch(() => ({}));
    const next = String(body.password || '');
    const confirm = String(body.confirm || '');
    if (!user.email || user.email === 'pages') return json({ error: 'Sign in to continue.' }, 401);
    if (next.length < 6) return json({ error: 'Use a password of at least 6 characters.' }, 400);
    if (next !== confirm) return json({ error: 'Those new passwords do not match.' }, 400);
    const checked = await passwordAuth(env, 'login', user.email, String(body.current || ''));
    if (checked.error) return json({ error: 'That current password is wrong.' }, 401);
    const saved = await updatePassword(env, checked.session.access_token, next);
    if (saved.error) return json({ error: saved.error }, saved.status || 400);
    const fresh = await passwordAuth(env, 'login', user.email, next);
    if (fresh.error) return json({ error: fresh.error }, fresh.status || 400);
    return json(fresh.session);
  }

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
  if (jobAction && jobAction[2] === 'share' && request.method === 'POST') {
    return shareJob(request, env, user, jobAction[1]);
  }
  if (jobAction && jobAction[2] === 'apply' && request.method === 'POST') {
    return applyJob(request, env, user, jobAction[1]);
  }
  if (jobAction && jobAction[2] === 'undo' && request.method === 'POST') {
    return undoJob(env, user, jobAction[1]);
  }
  if (jobAction && jobAction[2] === 'logo' && request.method === 'POST') {
    return logoJob(request, env, user, jobAction[1]);
  }
  if (jobAction && jobAction[2] === 'host' && request.method === 'POST') {
    return json({ error: 'Use the share link. Publishing a capture as its own site is not connected on this deploy.' }, 501);
  }
  if (jobAction && !jobAction[2] && request.method === 'DELETE') {
    return removeJob(env, user, jobAction[1]);
  }
  if (jobAction && !jobAction[2] && request.method === 'GET') {
    const job = await loadJob(env, user.id, jobAction[1]);
    if (!job) return json({ error: 'Job not found' }, 404);
    return json(await jobForClient(env, job));
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

  if (request.method === 'POST' && path.endsWith('/upload')) {
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    const rights = String(form?.get('rights_confirmed') || '');
    if (rights !== 'true' && rights !== 'on') return json({ error: 'Rights confirmation required' }, 400);
    if (!file || typeof file.arrayBuffer !== 'function') return json({ error: 'Choose an .html or .zip file' }, 400);
    const queued = await queueUpload(env, user, file);
    const payload = await queued.json();
    if (!queued.ok) return json(payload, queued.status);
    return json(publicJob(env, payload));
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

function priorMessages(history) {
  return (Array.isArray(history) ? history : []).slice(-8).map((item) => ({
    role: item.role === 'ai' || item.role === 'assistant' ? 'assistant' : 'user',
    content: String(item.text || item.content || '').replace(/\s+/g, ' ').trim().slice(0, 500),
  })).filter((item) => item.content);
}

function userContent(message, images) {
  const text = String(message || '').trim() || 'Use the attached image as a reference.';
  const pics = (Array.isArray(images) ? images : []).slice(0, 3).filter((url) => /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(String(url)) && String(url).length < 2000000);
  if (!pics.length) return text;
  return [{ type: 'text', text }, ...pics.map((url) => ({ type: 'image_url', image_url: { url } }))];
}

function captureOptions(message) {
  const lower = String(message || '').toLowerCase();
  const options = { crawl: /\bcrawl\b|\balso copy\b|\bproduct page\b|\bcollection page\b/.test(lower) };
  if (/\bmobile\b|\bphone\b/.test(lower)) options.viewport = 'mobile';
  if (/\bfooter\b|\bscroll\b/.test(lower)) options.actions = [{ type: 'scroll', to: /footer/.test(lower) ? 'footer' : 'bottom' }];
  return options;
}

function withOutline(content, outline) {
  const lead = `Page outline:\n${outline}\n\nRequest: `;
  if (typeof content === 'string') return `${lead}${content}`;
  return content.map((part) => part.type === 'text' ? { ...part, text: `${lead}${part.text}` } : part);
}

function visiblePage(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
}

async function handleAgent(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const message = String(body.message || '');
  const purpose = body.purpose || '';
  const jobId = body.activeJobId || '';
  const history = priorMessages(body.history);
  const content = userContent(message, body.images);

  if (purpose !== 'ready') {
    const usage = await bumpUsage(env, user.id);
    if (!usage.ok) {
      return sse({ reply: `The daily chat cap of ${usage.cap} is used up. It resets tomorrow.`, job: null });
    }
  }

  if (purpose === 'ready' && jobId) {
    const job = await loadJob(env, user.id, jobId);
    if (!job) return sse({ reply: 'That capture is gone.', job: null });
    const host = hostOf(job.source_url);
    try {
      const turn = await answer(env, [
        { role: 'system', content: 'Reply with one short sentence only. Example: nike.com is in the preview.' },
        { role: 'user', content: `${host} finished copying and is in the preview.` },
      ], 80);
      const reply = (turn.text || `${host} is in the preview.`).trim().split('\n')[0];
      return sse({ reply, job: publicJob(env, job), model: turn.model, quotaReset: turn.quotaReset || '' });
    } catch (err) {
      return sse({ reply: `${host} is in the preview.`, job: publicJob(env, job), error: err.message });
    }
  }

  const url = firstUrl(message);
  if (url && purpose !== 'edit') {
    const mode = /\bimages?\s*only\b|\bonly images\b/i.test(message) ? 'images' : 'clone';
    const queued = await queueCapture(env, user, { url, mode, rights_confirmed: true, options: captureOptions(message) });
    const payload = await queued.json();
    if (!queued.ok) return sse({ reply: payload.error || 'That link was not copied.', job: null });
    return sse({ reply: `Copying ${hostOf(payload.source_url)}.`, job: publicJob(env, payload), pendingLine: true });
  }

  if (jobId && /\b(share|live link)\b/i.test(message)) {
    const job = await loadJob(env, user.id, jobId);
    if (!job) return sse({ reply: 'That capture is gone.', job: null });
    if (job.status !== 'done') return sse({ reply: 'The page is still copying. The link can be made when the preview is ready.', job: publicJob(env, job) });
    const days = /\b30\b/.test(message) ? 30 : /\bnever\b/i.test(message) ? 0 : 7;
    const next = await setShare(env, job, { enabled: !/\b(off|revoke|stop)\b/i.test(message), days });
    await saveJob(env, next);
    const link = shareLive(next) ? `/share/${next.share_token}/` : '';
    return sse({ reply: link ? `Live link: ${link}` : 'The live link is off.', job: publicJob(env, next), shareUrl: link });
  }

  if (jobId && /\b(download|zip)\b/i.test(message)) {
    const job = await loadJob(env, user.id, jobId);
    if (!job) return sse({ reply: 'That capture is gone.', job: null });
    const action = /\bimages?\b/i.test(message) ? 'images' : 'full';
    return sse({ reply: action === 'images' ? 'Starting the image download.' : 'Starting the download.', job: publicJob(env, job), action });
  }

  if (jobId && /\b(host|publish)\b/i.test(message)) {
    const job = await loadJob(env, user.id, jobId);
    if (!job) return sse({ reply: 'That capture is gone.', job: null });
    return sse({ reply: 'A separate site is not connected. Use Share for a link. That link can open on a phone.', job: await jobForClient(env, job) });
  }

  if (jobId && /\b(undo|reset)\b/i.test(message)) {
    const job = await loadJob(env, user.id, jobId);
    if (!job) return sse({ reply: 'That capture is gone.', job: null });
    try { await undoChange(env, job); }
    catch (err) { return sse({ reply: err.message || 'Nothing to undo.', job: await jobForClient(env, job) }); }
    return sse({ reply: 'Undid the last edit.', job: await jobForClient(env, job), edited: true });
  }

  if (!jobId) {
    try {
      const turn = await answer(env, [
        { role: 'system', content: 'You are Protobuild. Answer in a short paragraph. The person may attach a reference image.' },
        ...history,
        { role: 'user', content },
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
  const outline = visiblePage(page);
  const question = /\?\s*$/.test(message) || /^(what|why|how|who|when|where|which)\b/i.test(message);
  if (question) {
    try {
      const turn = await answer(env, [
        { role: 'system', content: 'Answer in two short sentences from the page outline. If it is not there, say so.' },
        ...history,
        { role: 'user', content: `Page outline:\n${outline}\n\n${message}` },
      ], 180);
      return sse({ reply: (turn.text || 'That is not in the page text.').trim(), job: publicJob(env, job), model: turn.model, quotaReset: turn.quotaReset || '' });
    } catch (err) {
      return sse({ reply: err.message || 'The chat did not answer.', job: publicJob(env, job) });
    }
  }

  let turn;
  try {
    turn = await answer(env, [
      { role: 'system', content: 'You edit a captured page. Return only JSON {"css":"","replace":[{"from":"","to":""}]}. css may set color, type, size, alignment, spacing, borders, width, flex, grid, order, float, or display. replace.from must be copied exactly from the page text. replace.to may include a short HTML section. Leave a field empty when you are not using it. Do not apply the change yourself.' },
      ...history,
      { role: 'user', content: withOutline(content, outline) },
    ], 420);
  } catch (err) {
    return sse({ reply: err.message || 'The edit did not run.', job: publicJob(env, job) });
  }
  const parsed = parseJson(turn.text);
  const proposals = [];
  const checked = parsed.css ? validateCss(parsed.css) : { ok: false };
  if (checked.ok) {
    proposals.push({ kind: 'css', jobId, before: '(current custom CSS)', after: checked.css, css: checked.css });
  }
  const swap = Array.isArray(parsed.replace) ? parsed.replace[0] : null;
  if (swap?.from && page.includes(swap.from)) {
    proposals.push({ kind: 'html', jobId, before: String(swap.from).slice(0, 500), after: String(swap.to || '').slice(0, 500), find: swap.from, replace: swap.to || '' });
  }
  if (!proposals.length) {
    return sse({
      reply: 'That change is waiting on a clearer request. Wording, color, type, size, layout, and a new section can be proposed.',
      job: publicJob(env, job),
      model: turn.model,
      editFailed: true,
    });
  }
  return sse({
    reply: 'That change is waiting below. Apply it when it looks right.',
    job: publicJob(env, job),
    proposals,
    model: turn.model,
    quotaReset: turn.quotaReset || '',
  });
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
  const shareUrl = shareLive(job) ? `/share/${job.share_token}/` : null;
  return { ...job, previewUrl: preview, shareUrl, hostedUrl: job.options?.hostedUrl || null };
}

async function jobForClient(env, job) {
  const pub = publicJob(env, job);
  if (!pub?.id) return pub;
  pub.canUndo = false;
  if (!env.R2) return pub;
  try {
    const obj = await env.R2.get(`sites/${job.id}/edits.json`);
    const rows = obj ? await obj.json().catch(() => []) : [];
    pub.canUndo = Array.isArray(rows) && rows.length > 0;
  } catch {
    pub.canUndo = false;
  }
  return pub;
}

async function shareJob(request, env, user, jobId) {
  const job = await loadJob(env, user.id, jobId);
  if (!job) return json({ error: 'Job not found' }, 404);
  if (job.status !== 'done') return json({ error: 'The page is not ready to share.' }, 400);
  const body = await request.json().catch(() => ({}));
  const next = await setShare(env, job, { enabled: body.enabled !== false, days: body.expiresInDays });
  await saveJob(env, next);
  return json(await jobForClient(env, next));
}

async function applyJob(request, env, user, jobId) {
  const job = await loadJob(env, user.id, jobId);
  if (!job) return json({ error: 'Job not found' }, 404);
  const body = await request.json().catch(() => ({}));
  try { await applyChange(env, job, body); }
  catch (err) { return json({ error: err.message || 'That change was not applied.' }, err.status || 400); }
  return json(await jobForClient(env, job));
}

async function undoJob(env, user, jobId) {
  const job = await loadJob(env, user.id, jobId);
  if (!job) return json({ error: 'Job not found' }, 404);
  try { await undoChange(env, job); }
  catch (err) { return json({ error: err.message || 'Nothing to undo.' }, err.status || 400); }
  return json(await jobForClient(env, job));
}

async function logoJob(request, env, user, jobId) {
  const job = await loadJob(env, user.id, jobId);
  if (!job) return json({ error: 'Job not found' }, 404);
  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  const name = String(file?.name || '');
  const ext = (name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  if (!file || !['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)) {
    return json({ error: 'Use a png, jpg, webp, gif, or svg logo.' }, 400);
  }
  try {
    const reply = await saveLogo(env, job, `brand-logo${ext}`, await file.arrayBuffer());
    return json({ ...(await jobForClient(env, job)), reply });
  } catch (err) {
    return json({ error: err.message || 'That logo did not upload.' }, err.status || 400);
  }
}

async function bumpUsage(env, userId) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `usage/${userId}/${day}.json`;
  const existing = env.R2 ? await env.R2.get(key) : null;
  const count = existing ? Number((await existing.json().catch(() => ({}))).count) || 0 : 0;
  const cap = Number(env.MAX_PROMPTS_PER_DAY) || 1500;
  if (count >= cap) return { ok: false, count, cap };
  if (env.R2) {
    await env.R2.put(key, JSON.stringify({ count: count + 1, day }), {
      httpMetadata: { contentType: 'application/json' },
    });
  }
  return { ok: true, count: count + 1, cap };
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
  await cancelCaptureRun(env, jobId).catch(() => {});
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
