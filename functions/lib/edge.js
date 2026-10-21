import { assertPublicHttpUrl } from './public-url.js';

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
    headers: { 'Content-Type': 'application/json' },
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

export async function queueCapture(env, user, body) {
  if (!env.R2) {
    return json({ error: 'R2 is not connected, so this deploy cannot store a capture.' }, 503);
  }
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return json({ error: 'GitHub Actions is not configured, so this deploy cannot start a capture.' }, 503);
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
    status: 'queued',
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
        job_id: created.id,
        mode,
        url,
        options: JSON.stringify(created.options || {}),
      },
    }),
  });
  if (dispatched.status !== 204) {
    await putJob(env, { ...created, status: 'failed', error: 'The capture workflow did not start.', finished_at: new Date().toISOString() });
    return json({ error: 'The capture workflow did not start.' }, 502);
  }
  return json({ id: created.id, status: 'queued', source_url: url, mode, user_id: user.id, created_at: created.created_at });
}
