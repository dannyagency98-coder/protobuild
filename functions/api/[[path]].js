import { cancelCaptureRun, currentUser, forgetJob, json, listStoredIds, queueCapture, queueUpload, readStoredJob, storeHtmlPage } from '../lib/edge.js';
import { passwordAuth, updatePassword } from '../lib/auth.js';
import { answer } from '../lib/switch.js';
import { validateCss } from '../lib/css.js';
import { applyChange, saveLogo, setShare, shareLive, undoChange } from '../lib/actions.js';
import { absolutizeFragment, asksCookie, dropAsked, dropPhrase, dropPopups, fileLooksHtml, relabelAsked, revealNav, sectionKind, swapSection, wantsApplyFile, wantsBorrow, wantsEdit, wantsPreviewFile, wantsShowNav } from '../lib/page-edit.js';
import { applyReplacements } from '../lib/edit.js';
import { assertPublicHttpUrl } from '../lib/public-url.js';

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
    return queueCapture(env, user, body, context.waitUntil?.bind(context));
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
    return handleAgent(request, env, user, context.waitUntil?.bind(context));
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
  const text = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3500);
  const bits = [];
  for (const name of ['header', 'nav', 'h1', 'h2', 'button', 'footer']) {
    const match = String(html || '').match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]{0,220})`, 'i'));
    if (!match) continue;
    const line = match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (line) bits.push(`${name}: ${line}`);
  }
  return `${bits.join('\n')}\n\n${text}`.trim();
}

function wantsImagesOnly(message) {
  const text = String(message || '');
  const pictures = /\b(images?|pictures?|photos?|shots?)\b/i.test(text);
  const only = /\b(only|just the|collect|gather|extract)\b/i.test(text);
  return pictures && only && !/\b(page|layout|whole site|full site)\b/i.test(text);
}

function wantsNewScan(message, url) {
  if (!url || wantsBorrow(message) || wantsEdit(message) || wantsPreviewFile(message) || wantsApplyFile(message)) return false;
  if (/\b(on|onto|into) (this |the )?(page|site|screen|preview|phone)\b/i.test(message) && !/\b(scan|capture|open|show|preview|load)\b/i.test(message)) return false;
  const stripped = String(message || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/gi, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return true;
  if (stripped.split(/\s+/).length > 36) return false;
  return /\b(scan|capture|open|preview|copy|show|see|load|grab|pull|bring|put|display|look|check|visit|phone)\b/i.test(stripped);
}

function attachedFiles(list) {
  return (Array.isArray(list) ? list : []).slice(0, 3).map((file) => ({
    name: String(file?.name || 'file').slice(0, 80),
    kind: ['html', 'zip', 'doc'].includes(file?.kind) ? file.kind : 'doc',
    text: String(file?.text || '').slice(0, 12000),
  })).filter((file) => file.name);
}

function withFiles(content, files) {
  if (!files?.length) return content;
  const block = `Attached files:\n${files.map((file) => `${file.name}\n${file.text || '(no readable text)'}`).join('\n\n')}\n\n`;
  if (typeof content === 'string') return `${block}${content}`;
  return content.map((part) => part.type === 'text' ? { ...part, text: `${block}${part.text}` } : part);
}

function asDocument(name, text) {
  const raw = String(text || '');
  if (fileLooksHtml(raw)) return raw;
  const title = String(name || 'Page').replace(/[&<>"]/g, '');
  const body = raw.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:24px;font:16px/1.5 ui-sans-serif,system-ui;color:#111;background:#fff;white-space:pre-wrap}</style></head><body>${body}</body></html>`;
}

async function showAttached(env, user, files) {
  const zip = files.find((file) => file.kind === 'zip');
  const source = files.find((file) => file.text);
  if (!source && zip) return { upload: true, reply: 'Opening that file on the phone.' };
  if (!source?.text) return { reply: 'I could not read that file. Use HTML, text, or a PDF with real text, then say what to do with it.' };
  const created = await storeHtmlPage(env, user, source.name, asDocument(source.name, source.text));
  return { reply: 'That file is on the phone.', job: created, showPreview: true };
}

async function borrowFragment(url) {
  const safe = await assertPublicHttpUrl(url);
  const res = await fetch(safe, {
    redirect: 'follow',
    signal: AbortSignal.timeout(12000),
    headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' },
  });
  if (!res.ok) throw new Error('That link did not open.');
  const html = (await res.text()).slice(0, 1500000);
  return absolutizeFragment(html, safe);
}

async function handleAgent(request, env, user, waitUntil) {
  const body = await request.json().catch(() => ({}));
  const message = String(body.message || '');
  const purpose = body.purpose || '';
  const jobId = body.activeJobId || '';
  const history = priorMessages(body.history);
  const files = attachedFiles(body.files);
  const content = withFiles(userContent(message, body.images), files);

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
  if (url && purpose !== 'edit' && wantsNewScan(message, url)) {
    const mode = wantsImagesOnly(message) ? 'images' : 'clone';
    const queued = await queueCapture(env, user, { url, mode, rights_confirmed: true, options: captureOptions(message) }, waitUntil);
    const payload = await queued.json();
    if (!queued.ok) return sse({ reply: payload.error || 'That link was not copied.', job: null });
    return sse({ reply: 'Scanning.', job: publicJob(env, payload), pendingLine: true });
  }

  if (jobId && /\b(share|live link|dev link)\b|\b(send|give|make)\b[^.]{0,40}\b(link|url)\b/i.test(message) && !wantsEdit(message)) {
    const job = await loadJob(env, user.id, jobId);
    if (!job) return sse({ reply: 'That capture is gone.', job: null });
    if (job.status !== 'done') return sse({ reply: 'The page is still copying. The link can be made when the preview is ready.', job: publicJob(env, job) });
    const days = /\b30\b/.test(message) ? 30 : /\bnever\b/i.test(message) ? 0 : 7;
    const next = await setShare(env, job, { enabled: !/\b(off|revoke|stop)\b/i.test(message), days });
    await saveJob(env, next);
    const link = shareLive(next) ? `/share/${next.share_token}/` : '';
    return sse({ reply: link ? `Live link: ${link}` : 'The live link is off.', job: publicJob(env, next), shareUrl: link });
  }

  if (jobId && /\b(group|organise|organize|sort)\b/i.test(message) && /\b(image|images|picture|pictures|photo|photos|file|files|product)\b/i.test(message)) {
    const job = await loadJob(env, user.id, jobId);
    if (!job) return sse({ reply: 'That capture is gone.', job: null });
    const downloadToo = /\b(download|export|zip|save)\b/i.test(message);
    return sse({
      reply: downloadToo ? 'The images are grouped, and the download is starting.' : 'The images are grouped into products, photos, and icons.',
      job: publicJob(env, job),
      openGallery: true,
      action: downloadToo ? 'full' : '',
    });
  }

  if (jobId && /\b(download|zip|export)\b|\bsave (the|this) (page|file|copy)\b/i.test(message) && !wantsEdit(message)) {
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

  if (files.length && wantsPreviewFile(message)) {
    try {
      const shown = await showAttached(env, user, files);
      if (shown.upload) return sse({ reply: shown.reply, upload: true, job: jobId ? publicJob(env, await loadJob(env, user.id, jobId)) : null });
      if (!shown.job) return sse({ reply: shown.reply, job: jobId ? publicJob(env, await loadJob(env, user.id, jobId)) : null });
      return sse({ reply: shown.reply, job: publicJob(env, shown.job), showPreview: true });
    } catch (err) {
      return sse({ reply: err.message || 'That file did not open.', job: null });
    }
  }

  if (!jobId) {
    try {
      const turn = await answer(env, [
        { role: 'system', content: 'You are Protobuild. Read the message and answer exactly what it asks, in two to five sentences. An attached file is context. Do not claim a file was placed on the preview unless the message asked for that.' },
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
  const pageObj = await env.R2.get(`sites/${jobId}/index.html`);
  if (!pageObj) return sse({ reply: 'The page is not in storage yet.', job: publicJob(env, job) });
  const page = await pageObj.text();
  const outline = visiblePage(page);
  const editing = wantsEdit(message) || asksCookie(message) || (files.length > 0 && wantsApplyFile(message));
  if (!editing) return talkAbout(env, job, history, content, outline);

  if (wantsBorrow(message) && !url) {
    const htmlFile = files.find((file) => (file.kind === 'html' || fileLooksHtml(file.text)) && file.text);
    if (!htmlFile) return sse({ reply: 'Name the header, navigation, hero, or footer, and attach that page or paste its link.', job: publicJob(env, job) });
    const swapped = swapSection(page, htmlFile.text, sectionKind(message));
    if (!swapped) return sse({ reply: 'I could not find that part in the file and on the scanned page. Name the header, navigation, hero, or footer.', job: publicJob(env, job) });
    try { await applyChange(env, job, { kind: 'html', html: swapped }); }
    catch (err) { return sse({ reply: err.message || 'That edit did not save.', job: publicJob(env, job) }); }
    return sse({ reply: `Swapped the ${sectionKind(message)} with the one from ${htmlFile.name}. It is on the phone.`, job: await jobForClient(env, job), edited: true });
  }

  if (url && wantsBorrow(message)) {
    try {
      const foreign = await borrowFragment(url);
      const swapped = swapSection(page, foreign, sectionKind(message));
      if (!swapped) return sse({ reply: 'I could not find that part on both pages. Name the header, navigation, hero, or footer.', job: publicJob(env, job) });
      await applyChange(env, job, { kind: 'html', html: swapped });
      return sse({ reply: `Swapped the ${sectionKind(message)} with the one from ${hostOf(url)}. It is on the phone.`, job: await jobForClient(env, job), edited: true });
    } catch (err) {
      return sse({ reply: err.message || 'That link could not be used.', job: publicJob(env, job) });
    }
  }

  if (wantsShowNav(message)) {
    try { await applyChange(env, job, { kind: 'html', html: revealNav(page) }); }
    catch (err) { return sse({ reply: err.message || 'That edit did not save.', job: publicJob(env, job) }); }
    return sse({ reply: 'The navigation is open on the phone.', job: await jobForClient(env, job), edited: true });
  }

  if (/\b(remo\w*|hide|close|dismiss|strip)\b/i.test(message) && /\b(popup|pop-up|modal|newsletter|dialog|overlay)\b/i.test(message)) {
    const stripped = dropPopups(page);
    if (stripped === page) return sse({ reply: 'I could not find a popup on this page.', job: publicJob(env, job) });
    try { await applyChange(env, job, { kind: 'html', html: stripped }); }
    catch (err) { return sse({ reply: err.message || 'That edit did not save.', job: publicJob(env, job) }); }
    return sse({ reply: 'Removed the popup. The page is on the phone.', job: await jobForClient(env, job), edited: true });
  }

  const relabeled = relabelAsked(page, message);
  if (relabeled) {
    try { await applyChange(env, job, { kind: 'html', html: relabeled }); }
    catch (err) { return sse({ reply: err.message || 'That edit did not save.', job: publicJob(env, job) }); }
    return sse({ reply: 'Updated that text. It is on the phone.', job: await jobForClient(env, job), edited: true });
  }

  const asked = dropAsked(page, message);
  const direct = asked && asked !== page ? asked : '';
  if (direct) {
    try { await applyChange(env, job, { kind: 'html', html: direct }); }
    catch (err) { return sse({ reply: err.message || 'That edit did not save.', job: publicJob(env, job) }); }
    return sse({ reply: 'Removed that from the page. It is on the phone.', job: await jobForClient(env, job), edited: true });
  }
  if (asksCookie(message)) {
    return sse({ reply: 'I could not find a cookie block on this page. Reload the preview, or scan the site again and ask once more.', job: publicJob(env, job) });
  }

  let turn;
  try {
    turn = await answer(env, [
      { role: 'system', content: 'Read the request and do only the change it asks for. Return only JSON {"css":"","replace":[{"from":"","to":""}],"hide":"","note":""}. css may set color, type, size, alignment, spacing, borders, width, flex, grid, order, or display. replace.from must be exact words from the page outline. When an attached file is the source, replace.to is the matching detail from that file. hide is a short phrase from a block to remove. note is one sentence describing the change. Leave unused fields empty. If the request is not a page change, leave every field empty.' },
      ...history,
      { role: 'user', content: withOutline(content, outline) },
    ], 500);
  } catch (err) {
    return sse({ reply: err.message || 'The edit did not run.', job: publicJob(env, job) });
  }
  const parsed = parseJson(turn.text);
  const checked = parsed.css ? validateCss(parsed.css) : { ok: false };
  const replaced = applyReplacements(page, parsed.replace);
  const phrase = dropPhrase(replaced.html || page, parsed.hide || '');
  const hidden = phrase !== (replaced.html || page) ? phrase : '';
  if (!checked.ok && !replaced.html && !hidden) {
    if (files.length && wantsApplyFile(message)) {
      return sse({ reply: 'I read the file, but those details did not match a line on the page. Name the words to change.', job: publicJob(env, job), model: turn.model, quotaReset: turn.quotaReset || '' });
    }
    if (wantsEdit(message) || asksCookie(message)) {
      return sse({ reply: 'That did not match the page, so the phone was left as it is.', job: publicJob(env, job), model: turn.model, quotaReset: turn.quotaReset || '' });
    }
    return talkAbout(env, job, history, content, outline, turn.model, turn.quotaReset);
  }
  try {
    let saved = replaced.html || page;
    if (hidden) saved = hidden;
    if (saved !== page) await applyChange(env, job, { kind: 'html', html: saved });
    if (checked.ok) await applyChange(env, job, { kind: 'css', css: checked.css });
  } catch (err) {
    return sse({ reply: err.message || 'That edit did not save.', job: publicJob(env, job) });
  }
  const reply = hidden && !replaced.html
    ? 'Removed that from the page. It is on the phone.'
    : replaced.notes?.length
      ? `${replaced.notes.join(' ')} It is on the phone.`
      : 'Updated the styling. It is on the phone.';
  return sse({
    reply,
    job: await jobForClient(env, job),
    edited: true,
    model: turn.model,
    quotaReset: turn.quotaReset || '',
  });
}

async function talkAbout(env, job, history, content, outline, model, quotaReset) {
  try {
    const turn = await answer(env, [
      { role: 'system', content: 'You are Protobuild. Read the message and answer exactly what it asks. Use the page outline and any attached file when they help. You cannot change the page from this reply, so do not claim a banner was removed or a file was placed on the preview. Write a clear reply in two to five sentences. Do not mention JSON or say you are waiting for a clearer request.' },
      ...history,
      { role: 'user', content: `Page outline:\n${outline}\n\n${typeof content === 'string' ? content : content.map((part) => part.text || '').join(' ')}` },
    ], 360);
    return sse({ reply: (turn.text || '').trim() || 'I read that. Say a little more and I will answer it.', job: publicJob(env, job), model: model || turn.model, quotaReset: quotaReset || turn.quotaReset || '' });
  } catch (err) {
    return sse({ reply: err.message || 'The chat did not answer.', job: publicJob(env, job) });
  }
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
  const man = obj ? await obj.json().catch(() => ({})) : {};
  const page = await env.R2.get(`sites/${jobId}/index.html`);
  const html = page ? await page.text() : '';
  const onPage = html ? imagesInPage(html) : [];
  if (onPage.length) {
    const images = onPage.map((src) => ({
      url: src,
      local: src.split('/').pop().split('?')[0] || 'image',
      src,
      size: 0,
      contentType: 'image/jpeg',
      kind: 'photo',
      small: false,
    }));
    return json({ images, imageCount: images.length, skipped: 0, totalMB: man.totalMB, showSmall });
  }
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

function pageRegion(html) {
  const main = html.match(/<main\b[^>]*>[\s\S]*?<\/main>/i);
  if (main && /<img\b/i.test(main[0])) return main[0];
  return html
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}

function shotKey(src) {
  let name = src.split('/').pop().split('?')[0].toLowerCase();
  try { name = decodeURIComponent(name); } catch { /* keep the raw name */ }
  return name
    .replace(/^(mobile|desktop|tablet)_/, '')
    .replace(/_(4x5|16x9|1x1|9x16|3x4|2x3|21x9)/g, '')
    .replace(/\.(jpe?g|png|webp|avif)$/, '');
}

function imagesInPage(html) {
  const region = pageRegion(html);
  const tags = [
    ...region.matchAll(/<img\b[^>]*>/gi),
    ...region.matchAll(/<source\b[^>]*>/gi),
  ];
  const found = [];
  const seen = new Set();
  const keys = new Set();
  for (const match of tags) {
    if (found.length >= 24) break;
    const tag = match[0];
    const src = (tag.match(/\s(?:src|data-src)=["']([^"']+)["']/i) || [])[1]
      || (tag.match(/\s(?:srcset|data-srcset)=["']([^"'\s,]+)/i) || [])[1];
    if (!src || !/^https?:\/\//i.test(src) || seen.has(src)) continue;
    if (/\.svg(\?|$)/i.test(src) || /logo|sprite|icon|pixel|spacer|badge|favicon|tracking|analytics|placeholder|navigation-menu|nav-tile/i.test(src)) continue;
    const key = shotKey(src);
    if (keys.has(key)) continue;
    seen.add(src);
    keys.add(key);
    found.push(src);
  }
  return found;
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
  if (job.status === 'done' || /stopped/i.test(String(job.error || ''))) return json(await jobForClient(env, job));
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
  if (job.share_token && env.R2) await env.R2.delete(`shares/${job.share_token}.json`).catch(() => {});
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
  for (const id of ids) {
    const job = await loadJob(env, user.id, id);
    if (job?.share_token && env.R2) await env.R2.delete(`shares/${job.share_token}.json`).catch(() => {});
    await deleteStoredSite(env, id);
  }
  return json({ ok: true, removed: ids.length });
}
