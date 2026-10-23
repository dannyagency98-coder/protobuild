import { assertPublicHttpUrl } from './public-url.js';
import { captureInBrowser } from './browse.js';

export async function currentUser(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const header = request.headers.get('authorization') || '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user?.id) return null;
  return { id: user.id, email: user.email || '' };
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

async function putJob(env, job) {
  await env.R2.put(`sites/${job.id}/job.json`, JSON.stringify(job), {
    httpMetadata: { contentType: 'application/json' },
  });
}

async function rememberJob(env, userId, jobId) {
  const key = `indexes/${userId}.json`;
  const existing = await env.R2.get(key);
  const ids = existing ? await existing.json().catch(() => []) : [];
  const next = [jobId, ...(Array.isArray(ids) ? ids : []).filter((id) => id !== jobId)].slice(0, 40);
  await env.R2.put(key, JSON.stringify(next), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function listStoredIds(env, userId) {
  if (!env.R2) return [];
  const existing = await env.R2.get(`indexes/${userId}.json`);
  const ids = existing ? await existing.json().catch(() => []) : [];
  return Array.isArray(ids) ? ids : [];
}

export async function forgetJob(env, userId, jobId) {
  if (!env.R2) return;
  const ids = await listStoredIds(env, userId);
  await env.R2.put(`indexes/${userId}.json`, JSON.stringify(ids.filter((id) => id !== jobId)), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function readStoredJob(env, jobId) {
  if (!env.R2) return null;
  const obj = await env.R2.get(`sites/${jobId}/job.json`);
  if (!obj) return null;
  return obj.json().catch(() => null);
}

async function dispatchGithub(env, job) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return false;
  const workflow = env.GITHUB_WORKFLOW_FILE || 'capture.yml';
  const dispatched = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'protobuild',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ref: env.GITHUB_REF || 'main',
      inputs: {
        job_id: job.id,
        mode: job.mode,
        url: job.source_url,
        options: JSON.stringify(job.options || {}),
      },
    }),
  });
  return dispatched.status === 204;
}

export async function queueCapture(env, user, body, waitUntil) {
  if (!env.R2) {
    return json({ error: 'R2 is not connected, so this deploy cannot store a capture.' }, 503);
  }
  const canBrowser = !!(env.BROWSER && typeof waitUntil === 'function');
  const canGitHub = !!(env.GITHUB_TOKEN && env.GITHUB_REPO);
  if (!canBrowser && !canGitHub) {
    return json({ error: 'No browser is connected for captures.' }, 503);
  }
  const mode = body.mode === 'images' ? 'images' : 'clone';
  let url = '';
  try { url = await assertPublicHttpUrl(body.url); }
  catch (err) { return json({ error: err.message || 'That link is not allowed.' }, 400); }
  const created = {
    id: crypto.randomUUID(),
    user_id: user.id,
    source_url: url,
    mode,
    options: body.options || {},
    status: 'running',
    phase: 'opening',
    phaseDetail: 'Previewing the screen',
    error: null,
    stats: {},
    share_token: null,
    share_expires_at: null,
    rights_confirmed: true,
    created_at: new Date().toISOString(),
    finished_at: null,
  };
  await putJob(env, created);
  await rememberJob(env, user.id, created.id);
  if (canBrowser) {
    waitUntil(captureInBrowser(env, created).catch(async () => {
      const queued = await dispatchGithub(env, created);
      if (queued) {
        await putJob(env, { ...created, status: 'queued', phase: 'opening', phaseDetail: 'Previewing the screen' });
        return;
      }
      await putJob(env, { ...created, status: 'failed', error: 'The page did not open.', finished_at: new Date().toISOString() });
    }));
    return json(created);
  }
  const queued = await dispatchGithub(env, created);
  if (!queued) {
    await putJob(env, { ...created, status: 'failed', error: 'The capture workflow did not start.', finished_at: new Date().toISOString() });
    return json({ error: 'The capture workflow did not start.' }, 502);
  }
  await putJob(env, { ...created, status: 'queued' });
  return json({ ...created, status: 'queued' });
}

export async function storeHtmlPage(env, user, name, html) {
  if (!env.R2) {
    const error = new Error('R2 is not connected, so this deploy cannot store a capture.');
    error.status = 503;
    throw error;
  }
  const id = crypto.randomUUID();
  const created = {
    id,
    user_id: user.id,
    source_url: String(name || 'page.html').slice(0, 180),
    mode: 'upload',
    options: {},
    status: 'done',
    phase: 'packaging',
    phaseDetail: 'Previewing the screen',
    error: null,
    stats: {},
    share_token: null,
    share_expires_at: null,
    rights_confirmed: true,
    created_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  };
  await env.R2.put(`sites/${id}/index.html`, String(html || ''), {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  });
  await putJob(env, created);
  await rememberJob(env, user.id, id);
  return created;
}

export async function queueUpload(env, user, file) {
  if (!env.R2) return json({ error: 'R2 is not connected, so this deploy cannot store a capture.' }, 503);
  const name = String(file.name || 'upload.html');
  const ext = (name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  if (!['.html', '.htm', '.zip'].includes(ext)) return json({ error: 'Only .html or .zip files' }, 400);
  const bytes = await file.arrayBuffer();
  if (!bytes.byteLength) return json({ error: 'Choose an .html or .zip file' }, 400);
  const id = crypto.randomUUID();
  const created = {
    id,
    user_id: user.id,
    source_url: name,
    mode: 'upload',
    options: {},
    status: ext === '.zip' ? 'queued' : 'done',
    error: null,
    stats: {},
    share_token: null,
    share_expires_at: null,
    rights_confirmed: true,
    created_at: new Date().toISOString(),
    finished_at: ext === '.zip' ? null : new Date().toISOString(),
  };
  const key = ext === '.zip' ? `sites/${id}/source.zip` : `sites/${id}/index.html`;
  const type = ext === '.zip' ? 'application/zip' : 'text/html; charset=utf-8';
  await env.R2.put(key, bytes, { httpMetadata: { contentType: type } });
  await putJob(env, created);
  await rememberJob(env, user.id, id);
  if (ext !== '.zip') return json(created);
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return json({ error: 'GitHub Actions is not configured, so a zip still has to be unpacked on this computer.' }, 503);
  }
  const workflow = env.GITHUB_WORKFLOW_FILE || 'capture.yml';
  const dispatched = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'protobuild',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ref: env.GITHUB_REF || 'main',
      inputs: { job_id: id, mode: 'upload', url: '', options: '{}' },
    }),
  });
  if (dispatched.status !== 204) {
    await putJob(env, { ...created, status: 'failed', error: 'The capture workflow did not start.', finished_at: new Date().toISOString() });
    return json({ error: 'The capture workflow did not start.' }, 502);
  }
  return json(created);
}

export async function cancelCaptureRun(env, jobId) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO || !jobId) return false;
  const workflow = env.GITHUB_WORKFLOW_FILE || 'capture.yml';
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'protobuild',
  };
  const listed = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/runs?per_page=15`, { headers });
  if (!listed.ok) return false;
  const data = await listed.json().catch(() => ({}));
  const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
  const hit = runs.find((run) => {
    const title = `${run.display_title || ''} ${run.name || ''}`;
    const live = run.status === 'queued' || run.status === 'in_progress' || run.status === 'waiting' || run.status === 'pending';
    return live && title.includes(jobId);
  });
  if (!hit) return false;
  const cancelled = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs/${hit.id}/cancel`, {
    method: 'POST',
    headers,
  });
  return cancelled.status === 202 || cancelled.status === 204;
}
