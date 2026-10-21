// Preview / Share Worker
// Serves sites/{jobId} from R2 for p-{jobId} hosts
// Resolves s-{token} via KV for share links
// Injects custom.css and share banner via HTMLRewriter

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname;

    // Pass through non p-/s- hosts (e.g. app.)
    if (!host.startsWith('p-') && !host.startsWith('s-')) {
      return fetch(request);
    }

    let jobId = null;
    let isShare = false;

    if (host.startsWith('p-')) {
      jobId = host.slice(2).split('.')[0];
    } else if (host.startsWith('s-')) {
      const token = host.slice(2).split('.')[0];
      const kvValue = await env.SHARES.get(token);
      if (!kvValue) {
        return new Response('Link not available', { status: 404 });
      }
      jobId = kvValue;
      isShare = true;
    }

    if (!jobId) return new Response('Invalid host', { status: 400 });

    // Serve from R2
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const object = await env.R2.get(`sites/${jobId}${path}`);
    if (!object) return new Response('Not found', { status: 404 });

    const headers = new Headers();
    headers.set('X-Robots-Tag', 'noindex, nofollow');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "default-src 'self' data:; script-src 'none'; frame-ancestors https://app.yourdomain.com");

    // Content-Type
    const ext = path.split('.').pop();
    const types = { html: 'text/html', css: 'text/css', js: 'application/javascript', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', woff2: 'font/woff2' };
    headers.set('Content-Type', types[ext] || 'application/octet-stream');

    let response = new Response(object.body, { headers });

    if (ext === 'html' || path.endsWith('.html')) {
      const rewriter = new HTMLRewriter()
        .on('head', {
          element(el) {
            // inject custom.css if exists (check R2 later)
            el.append('<link rel="stylesheet" href="/custom.css">', { html: true });
          }
        });
      if (isShare) {
        rewriter.on('body', {
          element(el) {
            el.prepend('<div style="position:fixed;top:0;left:0;right:0;background:#000;color:#fff;padding:4px 8px;font-size:12px;z-index:9999;text-align:center">Reference prototype, not the original website</div>', { html: true });
          }
        });
      }
      response = rewriter.transform(response);
    }

    return response;
  },

  async scheduled(event, env, ctx) {
    // Daily cron: ping Supabase, cleanup old previews, expired shares
    try {
      await fetch(`${env.SUPABASE_URL}/rest/v1/`, { headers: { apikey: env.SUPABASE_SERVICE_KEY } });
    } catch {}
    // TODO: list and delete old R2 objects > previewTTLDays
    // TODO: clean KV expired tokens
  }
};
