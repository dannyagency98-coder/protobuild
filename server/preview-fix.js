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
  document.querySelectorAll('img,source').forEach(clean);
  document.querySelectorAll('img').forEach(function(img){
    img.addEventListener('error', function(){
      img.removeAttribute('srcset');
    }, {once:true});
  });
})();</script>`;

module.exports = { localizeHtml, localizeCss, FIX_SCRIPT };
