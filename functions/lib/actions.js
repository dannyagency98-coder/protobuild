import { validateCss } from './css.js';

function bad(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function shareLive(job) {
  if (!job?.share_token) return false;
  if (!job.share_expires_at) return true;
  return Date.parse(job.share_expires_at) > Date.now();
}

export function shareExpiry(days) {
  const n = Number(days);
  if (n === 0) return null;
  const span = n === 30 ? 30 : 7;
  return new Date(Date.now() + span * 86400000).toISOString();
}

async function readEdits(env, jobId) {
  const obj = await env.R2.get(`sites/${jobId}/edits.json`);
  if (!obj) return [];
  const rows = await obj.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

async function writeEdits(env, jobId, rows) {
  await env.R2.put(`sites/${jobId}/edits.json`, JSON.stringify(rows.slice(-12)), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function setShare(env, job, { enabled, days }) {
  if (!enabled) {
    if (job.share_token) await env.R2.delete(`shares/${job.share_token}.json`);
    return { ...job, share_token: null, share_expires_at: null };
  }
  const token = job.share_token || crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const expiresAt = shareExpiry(days);
  await env.R2.put(`shares/${token}.json`, JSON.stringify({ jobId: job.id, expiresAt }), {
    httpMetadata: { contentType: 'application/json' },
  });
  return { ...job, share_token: token, share_expires_at: expiresAt };
}

export async function applyChange(env, job, body) {
  if (body.kind === 'css') {
    const checked = validateCss(String(body.css || ''));
    if (!checked.ok) throw bad(checked.error || 'That CSS is not allowed.');
    const prevObj = await env.R2.get(`sites/${job.id}/custom.css`);
    const prev = prevObj ? (await prevObj.text()).trim() : '';
    await env.R2.put(`sites/${job.id}/custom.css`, prev ? `${prev}\n\n${checked.css}` : checked.css, {
      httpMetadata: { contentType: 'text/css' },
    });
    const rows = await readEdits(env, job.id);
    rows.push({ type: 'css', css: checked.css });
    await writeEdits(env, job.id, rows);
    return;
  }
  const pageObj = await env.R2.get(`sites/${job.id}/index.html`);
  if (!pageObj) throw bad('The captured page is missing.');
  const html = await pageObj.text();
  if (body.kind === 'html' && body.html) {
    const next = String(body.html);
    if (/<script|javascript:|onerror\s*=|onload\s*=/i.test(next)) throw bad('Script is not allowed.');
    await env.R2.put(`sites/${job.id}/index.html`, next, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    });
    const rows = await readEdits(env, job.id);
    rows.push({ type: 'snapshot', before: html });
    await writeEdits(env, job.id, rows);
    return;
  }
  if (body.kind === 'html') {
    const findText = String(body.find || '');
    const next = String(body.replace || '');
    if (!findText || !html.includes(findText)) throw bad('That text is no longer in the page.');
    if (/<script|javascript:|onerror\s*=|onload\s*=/i.test(next)) throw bad('Script is not allowed.');
    await env.R2.put(`sites/${job.id}/index.html`, html.replace(findText, next), {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    });
    const rows = await readEdits(env, job.id);
    rows.push({ type: 'html', find: findText, replace: next });
    await writeEdits(env, job.id, rows);
    return;
  }
  throw bad('Nothing to apply.');
}

export async function undoChange(env, job) {
  const rows = await readEdits(env, job.id);
  const last = rows.pop();
  if (!last) throw bad('There is no edit to undo.');
  if (last.type === 'css') {
    const obj = await env.R2.get(`sites/${job.id}/custom.css`);
    const css = obj ? await obj.text() : '';
    const at = css.lastIndexOf(last.css || '');
    const next = at >= 0 ? `${css.slice(0, at)}${css.slice(at + String(last.css).length)}`.replace(/\n{3,}/g, '\n\n').trim() : css.trim();
    if (next) {
      await env.R2.put(`sites/${job.id}/custom.css`, `${next}\n`, { httpMetadata: { contentType: 'text/css' } });
    } else {
      await env.R2.delete(`sites/${job.id}/custom.css`);
    }
  } else if (last.type === 'snapshot') {
    await env.R2.put(`sites/${job.id}/index.html`, last.before || '', {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    });
  } else if (last.type === 'html') {
    const obj = await env.R2.get(`sites/${job.id}/index.html`);
    const html = obj ? await obj.text() : '';
    if (last.replace && html.includes(last.replace)) {
      await env.R2.put(`sites/${job.id}/index.html`, html.replace(last.replace, last.find || ''), {
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
      });
    }
  }
  await writeEdits(env, job.id, rows);
}

export async function saveLogo(env, job, filename, bytes) {
  const pageObj = await env.R2.get(`sites/${job.id}/index.html`);
  if (!pageObj) throw bad('The captured page is missing.');
  const before = await pageObj.text();
  const src = `assets/${filename}`;
  await env.R2.put(`sites/${job.id}/${src}`, bytes, {
    httpMetadata: { contentType: typeFor(filename) },
  });
  let html = before;
  if (/<header[\s\S]*?<img/i.test(html)) {
    html = html.replace(/<header[\s\S]*?<\/header>/i, (header) => header.replace(/src=["'][^"']+["']/i, `src="${src}"`));
  } else {
    html = html.replace(/src=["'][^"']+["']/i, `src="${src}"`);
  }
  if (html === before) throw bad('There is no image on the page to replace.');
  await env.R2.put(`sites/${job.id}/index.html`, html, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  });
  const rows = await readEdits(env, job.id);
  rows.push({ type: 'snapshot', before });
  await writeEdits(env, job.id, rows);
  return 'Replaced the logo with your image.';
}

function typeFor(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'svg') return 'image/svg+xml';
  return 'application/octet-stream';
}
