const fs = require('fs');
const path = require('path');

function assetFiles(root) {
  const dir = path.join(root, 'assets');
  if (!root || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((name) => ({
    key: name.toLowerCase(),
    local: `assets/${name}`,
  }));
}

const GENERIC = new Set(['image', 'img', 'file', 'photo', 'icon', 'asset', 'static']);

function decodeAttr(value) {
  return String(value || '').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
}

function remoteHref(raw) {
  const decoded = decodeAttr(raw).trim();
  if (/^https?:\/\//i.test(decoded)) return decoded;
  if (decoded.startsWith('//')) return `https:${decoded}`;
  return '';
}

function matchAsset(raw, files) {
  const href = remoteHref(raw);
  if (!files.length || !href) return '';
  let base = '';
  try { base = path.basename(new URL(href).pathname).toLowerCase(); } catch { return ''; }
  if (!base || base.length < 3) return '';
  const exact = files.find((file) => file.key === base);
  if (exact) return exact.local;
  const stem = base.replace(/\.[^.]+$/, '');
  if (stem.length < 3 || GENERIC.has(stem)) return '';
  const direct = files.find((file) => file.key.startsWith(`${stem}-`) || file.key.startsWith(`${stem}.`));
  if (direct) return direct.local;
  if (stem.length < 16) return '';
  const close = files.find((file) => {
    const saved = file.key.replace(/-[a-f0-9]{6,10}\.[^.]+$/i, '').replace(/\.[^.]+$/, '');
    if (saved.length < 16) return false;
    return stem.startsWith(saved) || saved.startsWith(stem);
  });
  return close ? close.local : '';
}

function rewriteRemoteUrls(text, files) {
  return text.replace(/url\(\s*(['"]?)((?:https?:)?\/\/[^'")]+)\1\s*\)/gi, (full, _q, val) => {
    const next = matchAsset(val, files);
    return next ? `url("${next}")` : full;
  });
}

function localizeHtml(html, root) {
  const files = assetFiles(root);
  if (!files.length) return html;
  html = html.replace(/\s(src|poster)=["']((?:https?:)?\/\/[^"']+)["']/gi, (full, attr, val) => {
    const next = matchAsset(val, files);
    return next ? ` ${attr}="${next}"` : full;
  });
  html = html.replace(/srcset=["']([^"']+)["']/gi, (_full, val) => {
    const parts = val.split(',').map((part) => {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) return '';
      if (remoteHref(bits[0])) {
        const next = matchAsset(bits[0], files);
        if (!next) return '';
        bits[0] = next;
      }
      return bits.join(' ');
    }).filter(Boolean);
    return parts.length ? `srcset="${parts.join(', ')}"` : '';
  });
  return rewriteRemoteUrls(html, files);
}

function localizeCss(css, root) {
  return rewriteRemoteUrls(css, assetFiles(root));
}

const FIX_SCRIPT = `<script data-proto-fix="1">(function(){
  function clean(el){
    var set=el.getAttribute('srcset');
    if(set){
      var keep=set.split(',').map(function(p){return p.trim()}).filter(function(p){
        var u=p.split(/\\s+/)[0];
        return u && !/^(https?:)?\\/\\//i.test(u);
      });
      if(keep.length) el.setAttribute('srcset', keep.join(', '));
      else el.removeAttribute('srcset');
    }
    var src=el.getAttribute('src')||'';
    if(/^https?:/i.test(src)){
      var fb=(el.getAttribute('srcset')||'').split(',')[0];
      fb=fb?fb.trim().split(/\\s+/)[0]:'';
      if(fb) el.setAttribute('src', fb);
    }
  }
  document.querySelectorAll('[role="dialog"], .c-popin--opened').forEach(function(el){
    if(/select your location/i.test(el.textContent||'')) el.remove();
  });
  document.body.style.overflow = 'auto';
  document.body.style.height = 'auto';
  document.documentElement.style.overflowX = 'hidden';
  function fitWidth(){
    var root = document.documentElement;
    root.style.zoom = '';
    var wide = Math.max(root.scrollWidth || 0, document.body ? document.body.scrollWidth : 0);
    var view = window.innerWidth || 0;
    if (view > 0 && wide > view + 12) root.style.zoom = String(view / wide);
  }
  fitWidth();
  window.addEventListener('load', fitWidth);
  document.querySelectorAll('video').forEach(function(video){
    var box = video.getBoundingClientRect();
    if (box.width < 120 || box.height < 80) return;
    var still = document.createElement('img');
    still.src = 'screenshots/desktop.png';
    still.alt = '';
    still.style.cssText = 'width:100%;height:100%;object-fit:cover;object-position:center;display:block;background:#111';
    still.addEventListener('error', function(){ still.remove(); }, {once:true});
    video.replaceWith(still);
  });
  document.querySelectorAll('img,source').forEach(clean);
  document.querySelectorAll('img').forEach(function(img){
    var src=img.getAttribute('src')||'';
    var data=img.getAttribute('data-src')||img.getAttribute('data-lazy')||img.getAttribute('data-original')||'';
    if(data && !/^(https?:)?\\/\\//i.test(data) && (!src || /^https?:/i.test(src))) img.setAttribute('src', data);
  });
  document.querySelectorAll('img').forEach(function(img){
    var src=img.getAttribute('src')||'';
    if(!src){ img.style.display='none'; return; }
    img.addEventListener('error', function(){
      img.removeAttribute('srcset');
      var name=(img.getAttribute('alt')||'')+' '+(img.getAttribute('class')||'')+' '+src;
      var w=parseInt(img.getAttribute('width')||'0',10);
      if(/icon|logo|sprite|\.svg|\.ico/i.test(name) || (w>0 && w<=96)) img.style.display='none';
    }, {once:true});
  });
})();</script>`;

module.exports = { localizeHtml, localizeCss, FIX_SCRIPT };
