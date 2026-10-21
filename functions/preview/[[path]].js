import { serveStored } from '../lib/files.js';

function safeKey(pathname) {
  const rest = pathname.replace(/^\/preview\/?/, '');
  const parts = rest.split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return null;
  const jobId = parts[0];
  if (!/^[A-Za-z0-9-]{8,80}$/.test(jobId)) return null;
  const file = parts.slice(1).join('/') || 'index.html';
  return { jobId, file };
}

export async function onRequest(context) {
  const { request, env } = context;
  const found = safeKey(new URL(request.url).pathname);
  if (!found) return new Response('Not found', { status: 404 });
  return serveStored(env, found.jobId, found.file, { share: false });
}
