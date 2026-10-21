const TYPES = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  json: 'application/json',
  zip: 'application/zip',
};

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
  if (!env.R2) return new Response('Storage is not connected.', { status: 503 });
  const found = safeKey(new URL(request.url).pathname);
  if (!found) return new Response('Not found', { status: 404 });
  const object = await env.R2.get(`sites/${found.jobId}/${found.file}`);
  if (!object) return new Response('Not found', { status: 404 });
  const ext = found.file.split('.').pop().toLowerCase();
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self' 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'",
  };
  if (ext === 'html') {
    let html = await object.text();
    if (!/custom\.css/i.test(html)) {
      html = html.replace(/<\/head>/i, '<link rel="stylesheet" href="custom.css"></head>');
    }
    return new Response(html, { headers });
  }
  return new Response(object.body, { headers });
}
