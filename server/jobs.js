const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const env = require('./env');

const dataDir = path.join(env.root, 'data');
const jobsFile = path.join(dataDir, 'jobs.json');
const sharesFile = path.join(dataDir, 'shares.json');
const usageFile = path.join(dataDir, 'usage.json');

function ensureData() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(jobsFile)) fs.writeFileSync(jobsFile, '[]');
  if (!fs.existsSync(sharesFile)) fs.writeFileSync(sharesFile, '{}');
  if (!fs.existsSync(usageFile)) fs.writeFileSync(usageFile, '{}');
}

function readJson(file, fallback) {
  ensureData();
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  ensureData();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

async function sb(pathname, { method = 'GET', body, headers } = {}) {
  if (!env.supabaseUrl || !env.supabaseServiceKey) return null;
  const res = await fetch(`${env.supabaseUrl}${pathname}`, {
    method,
    headers: {
      apikey: env.supabaseServiceKey,
      Authorization: `Bearer ${env.supabaseServiceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

async function verifyUser(token) {
  if (!token) return null;
  if (!env.supabaseUrl || !env.supabaseAnonKey) return null;
  const res = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: env.supabaseAnonKey, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

function localJobs() { return readJson(jobsFile, []); }
function saveLocalJobs(rows) { writeJson(jobsFile, rows); }

function isLocalUser(userId) {
  return !userId || userId === 'local-user';
}

async function createJob(row) {
  const job = {
    id: row.id || crypto.randomUUID(),
    user_id: row.user_id,
    source_url: row.source_url || null,
    mode: row.mode,
    options: row.options || {},
    status: 'queued',
    error: null,
    stats: {},
    share_token: null,
    share_expires_at: null,
    rights_confirmed: !!row.rights_confirmed,
    created_at: new Date().toISOString(),
    finished_at: null,
  };
  const remote = isLocalUser(job.user_id) ? null : await sb('/rest/v1/jobs', { method: 'POST', body: job });
  if (remote && remote.ok) {
    const created = Array.isArray(remote.json) ? remote.json[0] : remote.json;
    if (created?.id) return created;
  }
  const rows = localJobs();
  rows.unshift(job);
  saveLocalJobs(rows);
  return job;
}

async function adoptResult(job) {
  if (!job || (job.status !== 'queued' && job.status !== 'running')) return job;
  const file = path.join(env.root, 'out', job.id, 'result.json');
  let result;
  try { result = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return job; }
  if (!result?.status || result.status === 'running' || result.status === 'queued') return job;
  const updated = await updateJob(job.id, {
    status: result.status,
    error: result.error || null,
    stats: result.stats || job.stats || {},
    finished_at: result.finished_at || new Date().toISOString(),
  });
  return updated || { ...job, ...result };
}

async function getJob(id, userId) {
  if (isLocalUser(userId)) {
    const job = localJobs().find((j) => j.id === id);
    if (!job || (userId && job.user_id !== userId)) return null;
    return adoptResult(job);
  }
  const remote = await sb(`/rest/v1/jobs?id=eq.${id}&select=*`, { method: 'GET' });
  if (remote && remote.ok && Array.isArray(remote.json) && remote.json[0]) {
    const job = remote.json[0];
    if (userId && job.user_id !== userId) return null;
    return job;
  }
  const job = localJobs().find((j) => j.id === id);
  if (!job) return null;
  if (userId && job.user_id !== userId) return null;
  return job;
}

async function listJobs(userId) {
  if (isLocalUser(userId)) {
    const rows = localJobs().filter((j) => j.user_id === userId).slice(0, 40);
    const out = [];
    for (const row of rows) out.push(await adoptResult(row));
    return out;
  }
  const remote = await sb(`/rest/v1/jobs?user_id=eq.${userId}&select=*&order=created_at.desc&limit=40`, { method: 'GET' });
  if (remote && remote.ok && Array.isArray(remote.json)) return remote.json;
  return localJobs().filter((j) => j.user_id === userId).slice(0, 40);
}

async function deleteJob(id, userId) {
  const job = await getJob(id, userId);
  if (!job) return null;
  if (!isLocalUser(userId)) {
    await sb(`/rest/v1/jobs?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  saveLocalJobs(localJobs().filter((row) => row.id !== id));
  const map = shares();
  let dirty = false;
  for (const [token, row] of Object.entries(map)) {
    if (row?.jobId === id || token === job.share_token) {
      delete map[token];
      dirty = true;
    }
  }
  if (dirty) saveShares(map);
  return job;
}

async function deleteAllJobs(userId) {
  const rows = isLocalUser(userId)
    ? localJobs().filter((row) => row.user_id === userId)
    : await listJobs(userId);
  const removed = [];
  for (const row of rows) {
    const gone = await deleteJob(row.id, userId);
    if (gone) removed.push(gone);
  }
  return removed;
}

async function updateJob(id, patch) {
  const remote = await sb(`/rest/v1/jobs?id=eq.${id}`, { method: 'PATCH', body: patch });
  const rows = localJobs();
  const idx = rows.findIndex((j) => j.id === id);
  if (idx !== -1) {
    rows[idx] = { ...rows[idx], ...patch };
    saveLocalJobs(rows);
    return rows[idx];
  }
  if (remote && remote.ok) {
    const updated = Array.isArray(remote.json) ? remote.json[0] : remote.json;
    return updated || patch;
  }
  return null;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function bumpUsage(userId, field) {
  const day = today();
  if (isLocalUser(userId)) {
    const usage = readJson(usageFile, {});
    const key = `${userId}:${day}`;
    usage[key] = usage[key] || { runs: 0, ai_calls: 0 };
    usage[key][field] = (usage[key][field] || 0) + 1;
    writeJson(usageFile, usage);
    return usage[key];
  }
  const remote = await sb(`/rest/v1/usage_daily?user_id=eq.${userId}&day=eq.${day}`, { method: 'GET' });
  if (remote && remote.ok && Array.isArray(remote.json) && remote.json[0]) {
    const row = remote.json[0];
    const next = { [field]: (row[field] || 0) + 1 };
    await sb(`/rest/v1/usage_daily?user_id=eq.${userId}&day=eq.${day}`, { method: 'PATCH', body: next });
    return { ...row, ...next };
  }
  if (remote && remote.ok) {
    const body = { user_id: userId, day, runs: field === 'runs' ? 1 : 0, ai_calls: field === 'ai_calls' ? 1 : 0 };
    await sb('/rest/v1/usage_daily', { method: 'POST', body });
    return body;
  }
  const usage = readJson(usageFile, {});
  const key = `${userId}:${day}`;
  usage[key] = usage[key] || { runs: 0, ai_calls: 0 };
  usage[key][field] = (usage[key][field] || 0) + 1;
  writeJson(usageFile, usage);
  return usage[key];
}

async function getUsage(userId) {
  const day = today();
  if (isLocalUser(userId)) {
    const usage = readJson(usageFile, {});
    return usage[`${userId}:${day}`] || { runs: 0, ai_calls: 0 };
  }
  const remote = await sb(`/rest/v1/usage_daily?user_id=eq.${userId}&day=eq.${day}`, { method: 'GET' });
  if (remote && remote.ok && Array.isArray(remote.json) && remote.json[0]) return remote.json[0];
  const usage = readJson(usageFile, {});
  return usage[`${userId}:${day}`] || { runs: 0, ai_calls: 0 };
}

function shares() { return readJson(sharesFile, {}); }
function saveShares(map) { writeJson(sharesFile, map); }

function publicError(error) {
  if (!error) return null;
  const text = String(error).replace(/\u001b\[[0-9;]*m/g, '');
  if (/page\.goto|timeout \d+ms|timed out/i.test(text)) {
    return 'The site did not respond in time. Scan it again, or attach a saved copy of the page.';
  }
  return text.split('\n')[0].slice(0, 280);
}

function liveStatus(job) {
  if (!job?.id) return { phase: '', detail: '', log: [] };
  try {
    const live = JSON.parse(fs.readFileSync(path.join(env.root, 'out', job.id, 'status.json'), 'utf8'));
    return {
      phase: live.phase || '',
      detail: live.detail || '',
      log: Array.isArray(live.log) ? live.log : [],
    };
  } catch {
    return { phase: '', detail: '', log: [] };
  }
}

function publicJob(job, origin) {
  if (!job) return null;
  const live = liveStatus(job);
  return {
    id: job.id,
    source_url: job.source_url,
    mode: job.mode,
    status: job.status,
    phase: live.phase,
    phaseDetail: live.detail,
    log: live.log,
    error: publicError(job.error),
    stats: job.stats || {},
    options: job.options || {},
    share_token: job.share_token,
    share_expires_at: job.share_expires_at,
    created_at: job.created_at,
    finished_at: job.finished_at,
    previewUrl: `${origin}/preview/${job.id}/`,
    shareUrl: job.share_token ? `${origin}/share/${job.share_token}/` : null,
    hostedUrl: job.options?.hostedUrl || '',
  };
}

module.exports = {
  verifyUser,
  createJob,
  getJob,
  listJobs,
  deleteJob,
  deleteAllJobs,
  updateJob,
  bumpUsage,
  getUsage,
  shares,
  saveShares,
  publicJob,
  dataDir,
};
