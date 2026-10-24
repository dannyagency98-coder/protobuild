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
  otf: 'font/otf',
  ttf: 'font/ttf',
  json: 'application/json',
  zip: 'application/zip',
};

const PICK = '<script data-proto-stay="1">(function(){function foreign(url){try{return new URL(url,location.href).origin!==location.origin}catch(e){return true}}var pick=false;window.addEventListener("message",function(e){if(!e.data||e.data.type!=="pb-pick")return;pick=!!e.data.on;document.documentElement.style.cursor=pick?"crosshair":""});document.addEventListener("click",function(e){if(pick){e.preventDefault();e.stopPropagation();var el=e.target;if(!el||!el.tagName)return;var cls=typeof el.className==="string"?el.className.trim().split(/\\s+/).filter(Boolean).slice(0,2).join("."):"";var sel=el.id?"#"+el.id:el.tagName.toLowerCase()+(cls?"."+cls:"");var text=(el.innerText||el.getAttribute("alt")||"").replace(/\\s+/g," ").trim().slice(0,180);parent.postMessage({type:"pb-picked",selector:sel,text:text},"*");return}var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(a&&foreign(a.getAttribute("href"))){e.preventDefault();e.stopPropagation()}},true)})();</script>';

const FIT = '<script data-proto-fix="1">(function(){function release(){var root=document.documentElement;var body=document.body;[root,body].forEach(function(el){if(!el)return;el.style.setProperty("overflow","auto","important");el.style.setProperty("height","auto","important");el.style.setProperty("position","static","important")});document.querySelectorAll("body *").forEach(function(el){var s=getComputedStyle(el);var fixed=s.position==="fixed"||s.position==="absolute";if(!fixed)return;var r=el.getBoundingClientRect();var covers=r.width>window.innerWidth*0.7&&r.height>window.innerHeight*0.7;var invisible=s.visibility==="hidden"||parseFloat(s.opacity)===0||s.display==="none";if(covers&&invisible)el.style.setProperty("pointer-events","none","important");else if(el.style.pointerEvents==="none")el.style.removeProperty("pointer-events")})}function fit(){var root=document.documentElement;root.style.zoom="";var wide=Math.max(root.scrollWidth||0,document.body?document.body.scrollWidth:0);var view=window.innerWidth||0;if(view>0&&wide>view+12)root.style.zoom=String(view/wide)}release();fit();window.addEventListener("load",function(){release();fit()});setTimeout(release,500);var brand=document.querySelector("style[data-proto-font]");if(brand){var re=/font-family:\"([^\"]+)\";src:url\\(\"([^\"]+)\"\\)/g;var found;while((found=re.exec(brand.textContent))){try{var face=new FontFace(found[1],"url("+found[2]+")");face.load().then(function(loaded){document.fonts.add(loaded)})}catch(e){}}}document.querySelectorAll("video").forEach(function(video){video.muted=true;video.playsInline=true;var play=video.play();if(play&&play.catch)play.catch(function(){})})})();</script>';

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
  if (/\.(woff2?|otf|ttf)$/i.test(file)) headers['Access-Control-Allow-Origin'] = '*';
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
    const stamp = custom.uploaded ? new Date(custom.uploaded).getTime() : Date.now();
    const href = `${assetRoot ? new URL('custom.css', assetRoot).href : `/preview/${jobId}/custom.css`}?v=${stamp}`;
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
  if (String(pageUrl).includes('/preview/')) html = await injectBrandFonts(env, html, pageUrl);
  if (assetRoot) html = pinLocalAssets(html, assetRoot);
  return new Response(html, { headers });
}

const FONT_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

async function injectBrandFonts(env, html, pageUrl) {
  const jobId = (String(pageUrl).match(/\/preview\/([^/]+)/) || [])[1];
  if (!jobId || !env?.R2 || html.includes('<style data-proto-font>')) return html;
  const listed = await env.R2.list({ prefix: `sites/${jobId}/assets/` });
  const faces = [];
  for (const obj of listed.objects || []) {
    const file = String(obj.key || '').split('/').pop();
    if (!/\.woff2?$/i.test(file)) continue;
    const family = file.replace(/\.woff2?$/i, '').replace(/[^a-z0-9_-]+/gi, '');
    if (!family) continue;
    const format = /\.woff2$/i.test(file) ? 'woff2' : 'woff';
    const weight = /semibold|medium/i.test(family) ? '600' : /bold/i.test(family) ? '700' : '400';
    const href = new URL(`/preview/${jobId}/assets/${file}`, pageUrl).href;
    faces.push(`@font-face{font-family:"${family}";src:url("${href}") format("${format}");font-weight:${weight};font-style:normal;font-display:swap}`);
  }
  if (!faces.length) return html;
  const style = `<style data-proto-font>${faces.join('')}</style>`;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${style}</head>`) : `${style}${html}`;
}

export async function proxyRemote(env, jobId, raw) {
  let target;
  try { target = new URL(raw); } catch { return new Response('Not found', { status: 404 }); }
  if (target.protocol !== 'https:') return new Response('Not found', { status: 404 });
  const jobObj = env.R2 ? await env.R2.get(`sites/${jobId}/job.json`) : null;
  const job = jobObj ? await jobObj.json().catch(() => null) : null;
  let sourceHost = '';
  try { sourceHost = new URL(job?.source_url || '').host; } catch { sourceHost = ''; }
  if (!sourceHost || target.host !== sourceHost) return new Response('Not found', { status: 404 });
  if (!/\.woff2?(\?|$)/i.test(target.pathname)) return new Response('Not found', { status: 404 });
  const res = await fetch(target.href, {
    redirect: 'follow',
    headers: {
      'User-Agent': FONT_UA,
      Referer: job.source_url || target.origin,
      Accept: '*/*',
    },
  });
  if (!res.ok) return new Response('Not found', { status: 404 });
  const type = /\.woff2(\?|$)/i.test(target.pathname) ? 'font/woff2' : 'font/woff';
  return new Response(res.body, {
    headers: {
      'Content-Type': type,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
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
