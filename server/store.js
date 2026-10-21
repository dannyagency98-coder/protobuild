const fs = require('fs');
const path = require('path');
const env = require('./env');

const dataDir = path.join(env.root, 'data');
const jobsFile = path.join(dataDir, 'jobs.json');
const usageFile = path.join(dataDir, 'usage.json');
const sharesFile = path.join(dataDir, 'shares.json');

function ensure() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  for (const f of [jobsFile, usageFile, sharesFile]) {
    if (!fs.existsSync(f)) fs.writeFileSync(f, f === jobsFile ? '[]' : '{}');
  }
}

function readJson(file, fallback) {
  ensure();
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  ensure();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: env.supabaseServiceKey,
    Authorization: `Bearer ${env.supabaseServiceKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function sb(pathname, options = {}) {
  if (!env.supabaseUrl || !env.supabaseServiceKey) return null;
  const res = await fetch(`${env.supabaseUrl}/rest/v1/${pathname}`, {
    ...options,
    headers: { ...supabaseHeaders(options.headers), ...options.headers },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const msg = json?.message || json?.error || text || res.statusText;
    const err = new Error(msg);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function verifyUser(jwt) {
  if (!jwt) throw Object.assign(new Error('Sign in required'), { status: 401 });
  if (!env.supabaseUrl || !env.supabaseAnonKey) throw Object.assign(new Error('Auth is not configured'), { status: 500 });
  const res = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: env.supabaseAnonKey, Authorization: `Bearer ${jwt}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.id) throw Object.assign(new Error(json.msg || json.message || 'Sign in required'), { status: 401 });
  return json;
}

function localJobs() {
  return readJson(jobsFile, []);
}

function saveLocalJobs(jobs) {
  writeJson(jobsFile, jobs);
}

async function insertJob(row) {
  try {
    const data = await sb('jobs', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    if (Array.isArray(data) && data[0]) return data[0];
  } catch (err) {
    console.warn('Supabase insert failed, using local store:', err.message);
  }
  const jobs = localJobs();
  jobs.unshift(row);
  saveLocalJobs(jobs);
  return row;
}

async function getJob(id, userId) {
  try {
    let q = `jobs?id=eq.${id}&select=*`;
    if (userId) q += `&user_id=eq.${userId}`;
    const data = await sb(q);
    if (Array.isArray(data) && data[0]) return data[0];
  } catch (err) {
    console.warn('Supabase get failed:', err.message);
  }
  const job = localJobs().find((j) => j.id === id);
  if (!job) return null;
  if (userId && job.user_id !== userId) return null;
  return job;
}

async function getJobByShareToken(token) {
  try {
    const data = await sb(`jobs?share_token=eq.${encodeURIComponent(token)}&select=*`);
    if (Array.isArray(data) && data[0]) return data[0];
  } catch {}
  const shares = readJson(sharesFile, {});
  const rec = shares[token];
  if (!rec) return null;
  if (rec.expiresAt && Date.now() > rec.expiresAt) return null;
  return getJob(rec.jobId);
}

async function listJobs(userId) {
  try {
    const data = await sb(`jobs?user_id=eq.${userId}&select=*&order=created_at.desc&limit=40`);
    if (Array.isArray(data)) return data;
  } catch (err) {
    console.warn('Supabase list failed:', err.message);
  }
  return localJobs().filter((j) => j.user_id === userId).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

async function updateJob(id, patch) {
  try {
    await sb(`jobs?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  } catch (err) {
    console.warn('Supabase update failed:', err.message);
  }
  const jobs = localJobs();
  const i = jobs.findIndex((j) => j.id === id);
  if (i !== -1) {
    jobs[i] = { ...jobs[i], ...patch };
    saveLocalJobs(jobs);
    return jobs[i];
  }
  return { id, ...patch };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function bumpUsage(userId, field) {
  const day = today();
  try {
    const existing = await sb(`usage_daily?user_id=eq.${userId}&day=eq.${day}&select=*`);
    if (Array.isArray(existing) && existing[0]) {
      const next = { ...existing[0], [field]: (existing[0][field] || 0) + 1 };
      await sb(`usage_daily?user_id=eq.${userId}&day=eq.${day}`, { method: 'PATCH', body: JSON.stringify({ [field]: next[field] }) });
      return next;
    }
    const row = { user_id: userId, day, runs: field === 'runs' ? 1 : 0, ai_calls: field === 'ai_calls' ? 1 : 0 };
    await sb('usage_daily', { method: 'POST', body: JSON.stringify(row) });
    return row;
  } catch (err) {
    console.warn('usage_daily failed, using local:', err.message);
  }
  const usage = readJson(usageFile, {});
  const key = `${userId}:${day}`;
  usage[key] = usage[key] || { user_id: userId, day, runs: 0, ai_calls: 0 };
  usage[key][field] = (usage[key][field] || 0) + 1;
  writeJson(usageFile, usage);
  return usage[key];
}

async function getUsage(userId) {
  const day = today();
  try {
    const existing = await sb(`usage_daily?user_id=eq.${userId}&day=eq.${day}&select=*`);
    if (Array.isArray(existing) && existing[0]) return existing[0];
  } catch {}
  const usage = readJson(usageFile, {});
  return usage[`${userId}:${day}`] || { runs: 0, ai_calls: 0 };
}

function setShare(token, jobId, expiresAt) {
  const shares = readJson(sharesFile, {});
  shares[token] = { jobId, expiresAt: expiresAt ? new Date(expiresAt).getTime() : null };
  writeJson(sharesFile, shares);
}

function deleteShare(token) {
  const shares = readJson(sharesFile, {});
  delete shares[token];
  writeJson(sharesFile, shares);
}

module.exports = {
  verifyUser,
  insertJob,
  getJob,
  getJobByShareToken,
  listJobs,
  updateJob,
  bumpUsage,
  getUsage,
  setShare,
  deleteShare,
};
