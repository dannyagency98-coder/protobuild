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

const PICK = '<script data-proto-stay="1">(function(){function foreign(url){try{return new URL(url,location.href).origin!==location.origin}catch(e){return true}}var pick=false;window.addEventListener("message",function(e){if(!e.data||e.data.type!=="pb-pick")return;pick=!!e.data.on;document.documentElement.style.cursor=pick?"crosshair":""});document.addEventListener("click",function(e){if(pick){e.preventDefault();e.stopPropagation();var el=e.target;if(!el||!el.tagName)return;var cls=typeof el.className==="string"?el.className.trim().split(/\\s+/).filter(Boolean).slice(0,2).join("."):"";var sel=el.id?"#"+el.id:el.tagName.toLowerCase()+(cls?"."+cls:"");var text=(el.innerText||el.getAttribute("alt")||"").replace(/\\s+/g," ").trim().slice(0,180);parent.postMessage({type:"pb-picked",selector:sel,text:text},"*");return}var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(a&&foreign(a.getAttribute("href"))){e.preventDefault();e.stopPropagation()}},true)})();</script>';

const CSP = "default-src 'self' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self' 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'";

export function fileHeaders(file) {
  const ext = String(file).split('.').pop().toLowerCase();
  return {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CSP,
  };
}

export async function serveStored(env, jobId, file, { share = false } = {}) {
  if (!env.R2) return new Response('Storage is not connected.', { status: 503 });
  if (!file || file.includes('..')) return new Response('Not found', { status: 404 });
  const object = await env.R2.get(`sites/${jobId}/${file}`);
  if (!object) return new Response('Not found', { status: 404 });
  const headers = fileHeaders(file);
  if (!file.endsWith('.html') && file !== 'index.html') {
    return new Response(object.body, { headers });
  }
  let html = await object.text();
  if (!html.includes('data-proto-stay')) {
    html = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (open) => `${open}${PICK}`)
      : `<head>${PICK}</head>${html}`;
  }
  const custom = await env.R2.head(`sites/${jobId}/custom.css`);
  if (custom && !/custom\.css/i.test(html)) {
    html = html.replace(/<\/head>/i, '<link rel="stylesheet" href="custom.css"></head>');
  }
  if (share && !html.includes('Reference prototype')) {
    html = html.replace(/<body([^>]*)>/i, '<body$1><div style="position:fixed;top:0;left:0;right:0;background:#111;color:#f3efe4;padding:8px 12px;font:13px/1.4 ui-sans-serif,system-ui;z-index:99999;text-align:center">Reference prototype, not the original website</div>');
  }
  return new Response(html, { headers });
}
