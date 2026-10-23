import { pinLocalAssets } from './assets.js';

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

const FIT = '<script data-proto-fix="1">(function(){document.body.style.overflow="auto";document.body.style.height="auto";function fit(){var root=document.documentElement;root.style.zoom="";var wide=Math.max(root.scrollWidth||0,document.body?document.body.scrollWidth:0);var view=window.innerWidth||0;if(view>0&&wide>view+12)root.style.zoom=String(view/wide)}fit();window.addEventListener("load",fit);document.querySelectorAll("video").forEach(function(video){var box=video.getBoundingClientRect();if(box.width<120||box.height<80)return;var still=document.createElement("img");still.src="screenshots/desktop.png";still.alt="";still.style.cssText="width:100%;height:100%;object-fit:cover;object-position:center;display:block";still.addEventListener("error",function(){still.remove()},{once:true});video.replaceWith(still)})})();</script>';

const CSP = "default-src 'self' data: blob:; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:; script-src 'self' 'unsafe-inline' https:; connect-src 'self' https: data:; media-src 'self' data: blob: https:; frame-src 'self' https:; frame-ancestors 'self'; sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

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

function previewText(value) {
  return String(value || '').replace(/\s+/g, ' ').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').trim().slice(0, 300);
}

function absolutePreviewUrl(value, base) {
  try { return new URL(value, base).href; } catch { return ''; }
}

function rewritePreviewImage(html, base) {
  return html.replace(/<meta\b[^>]*(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*>/gi, (tag) => {
    return tag.replace(/content=(["'])(.*?)\1/i, (full, quote, url) => {
      if (!/^https?:\/\//i.test(url)) {
        const abs = absolutePreviewUrl(url, base);
        if (abs) return `content=${quote}${previewText(abs)}${quote}`;
      }
      return full;
    });
  });
}

export function withSharePreview(html, { pageUrl, imageUrl }) {
  const title = previewText((/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [])[1] || 'Shared page');
  const described = (/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html) || [])[1]
    || (/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(html) || [])[1]
    || '';
  const description = previewText(described || title);
  let next = rewritePreviewImage(html, pageUrl);
  const bits = [];
  if (!/property=["']og:title["']/i.test(next)) bits.push(`<meta property="og:title" content="${title}">`);
  if (!/property=["']og:description["']/i.test(next)) bits.push(`<meta property="og:description" content="${description}">`);
  if (!/property=["']og:url["']/i.test(next)) bits.push(`<meta property="og:url" content="${previewText(pageUrl)}">`);
  if (!/property=["']og:image["']/i.test(next) && imageUrl) bits.push(`<meta property="og:image" content="${previewText(imageUrl)}">`);
  if (/name=["']twitter:card["']/i.test(next)) {
    next = next.replace(/<meta\b[^>]*name=["']twitter:card["'][^>]*>/i, '<meta name="twitter:card" content="summary_large_image">');
  } else {
    bits.push('<meta name="twitter:card" content="summary_large_image">');
  }
  if (!bits.length) return next;
  const block = bits.join('');
  return /<head[^>]*>/i.test(next) ? next.replace(/<head[^>]*>/i, (open) => `${open}${block}`) : `<head>${block}</head>${next}`;
}

export async function serveStored(env, jobId, file, { share = false, pageUrl = '' } = {}) {
  if (!env.R2) return new Response('Storage is not connected.', { status: 503 });
  if (!file || file.includes('..')) return new Response('Not found', { status: 404 });
  const object = await env.R2.get(`sites/${jobId}/${file}`);
  if (!object) return new Response('Not found', { status: 404 });
  const headers = fileHeaders(file);
  if (share) {
    delete headers['X-Robots-Tag'];
    headers['Cache-Control'] = 'public, max-age=3600';
  }
  if (!file.endsWith('.html') && file !== 'index.html') {
    return new Response(object.body, { headers });
  }
  let html = await object.text();
  if (!html.includes('data-proto-stay')) {
    html = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (open) => `${open}${PICK}`)
      : `<head>${PICK}</head>${html}`;
  }
  const assetRoot = folderUrl(pageUrl);
  const custom = await env.R2.head(`sites/${jobId}/custom.css`);
  if (custom && !/custom\.css/i.test(html)) {
    const href = assetRoot ? new URL('custom.css', assetRoot).href : `/preview/${jobId}/custom.css`;
    html = html.replace(/<\/head>/i, `<link rel="stylesheet" href="${href}"></head>`);
  }
  if (share && !html.includes('Reference prototype')) {
    html = html.replace(/<body([^>]*)>/i, '<body$1><div style="position:fixed;top:0;left:0;right:0;background:#111;color:#f3efe4;padding:8px 12px;font:13px/1.4 ui-sans-serif,system-ui;z-index:99999;text-align:center">Reference prototype, not the original website</div>');
  }
  if (share && pageUrl) {
    let imageUrl = '';
    const shot = await env.R2.head(`sites/${jobId}/screenshots/desktop.png`);
    if (shot) {
      const origin = new URL(pageUrl).origin;
      const token = new URL(pageUrl).pathname.split('/').filter(Boolean)[1] || '';
      if (token) imageUrl = `${origin}/share/${token}/screenshots/desktop.png`;
    }
    html = withSharePreview(html, { pageUrl, imageUrl });
  }
  if (!html.includes('data-proto-fix')) {
    const end = html.toLowerCase().lastIndexOf('</body>');
    html = end >= 0 ? html.slice(0, end) + FIT + html.slice(end) : html + FIT;
  }
  if (assetRoot) html = pinLocalAssets(html, assetRoot);
  return new Response(html, { headers });
}

function folderUrl(pageUrl) {
  if (!pageUrl) return '';
  try {
    const url = new URL(pageUrl);
    if (!url.pathname.endsWith('/')) url.pathname = url.pathname.replace(/[^/]*$/, '');
    url.search = '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}
