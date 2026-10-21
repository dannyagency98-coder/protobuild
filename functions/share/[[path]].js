import { serveStored } from '../lib/files.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.R2) return new Response('Storage is not connected.', { status: 503 });
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  const token = parts[1] || '';
  if (parts[0] !== 'share' || !/^[a-z0-9]{8,40}$/i.test(token)) {
    return new Response('Not found', { status: 404 });
  }
  const metaObj = await env.R2.get(`shares/${token}.json`);
  if (!metaObj) return new Response('This link is off.', { status: 404 });
  const meta = await metaObj.json().catch(() => null);
  if (!meta?.jobId) return new Response('This link is off.', { status: 404 });
  if (meta.expiresAt && Date.parse(meta.expiresAt) <= Date.now()) {
    return new Response('This link has expired.', { status: 410 });
  }
  const file = parts.slice(2).map(decodeURIComponent).join('/') || 'index.html';
  if (file.split('/').some((part) => part === '.' || part === '..')) {
    return new Response('Not found', { status: 404 });
  }
  return serveStored(env, meta.jobId, file, { share: true });
}
