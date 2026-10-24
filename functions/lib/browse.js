import puppeteer from '@cloudflare/puppeteer';
import { fontFile, imageFile, rewriteMirrored } from './assets.js';
import { dropCookie, dropPopups } from './page-edit.js';

const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

function crc32(data) {
  let c = ~0;
  for (let i = 0; i < data.length; i += 1) {
    c ^= data[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function bytes(nums) {
  return new Uint8Array(nums);
}

function u16(n) {
  return [n & 255, (n >> 8) & 255];
}

function u32(n) {
  return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
}

function zipStore(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const file of files) {
    const name = enc.encode(file.name);
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const crc = crc32(data);
    const local = bytes([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0),
    ]);
    parts.push(local, name, data);
    central.push(bytes([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
    ]), name);
    offset += local.length + name.length + data.length;
  }
  let centralSize = 0;
  for (const part of central) centralSize += part.length;
  const end = bytes([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);
  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...parts, ...central, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const TRACKER = /google-analytics|googletagmanager|gtag\/js|googleadservices|doubleclick|facebook\.net|connect\.facebook|hotjar|segment\.(com|io)|mixpanel|fullstory|clarity\.ms|sentry\.io|newrelic|datadog|cookiebot|onetrust|trustarc|cookielaw|demdex|adservice|scorecardresearch|quantserve|optimizely|bat\.bing|licdn\.com|ads-twitter/i;

function attr(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function preparePage(html, sourceUrl) {
  let next = String(html || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (tag) => {
    const src = (tag.match(/\ssrc=["']([^"']+)["']/i) || [])[1] || '';
    if ((src && TRACKER.test(src)) || (!src && TRACKER.test(tag))) return '';
    if (!src && tag.length > 40000) return '';
    return tag;
  });
  next = next.replace(/\son\w+\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '');
  next = dropPopups(dropCookie(next));
  let baseHref = '';
  try {
    const url = new URL(sourceUrl);
    if (/^https?:$/i.test(url.protocol)) baseHref = url.href;
  } catch { /* keep the page without a base */ }
  if (!baseHref) return next;
  const base = `<base href="${attr(baseHref)}">`;
  next = next.replace(/<base\b[^>]*>/gi, '');
  if (/<head[^>]*>/i.test(next)) return next.replace(/<head[^>]*>/i, (open) => `${open}${base}`);
  return `<head>${base}</head>${next}`;
}

function screenshotPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#fff}img{width:100%;height:auto;display:block}</style></head><body><img src="screenshots/phone.png" alt=""></body></html>`;
}

async function settleImages(page) {
  return page.evaluate(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],[class*="popup"],[id*="popup"],[class*="newsletter"],[class*="cookie"]').forEach((el) => {
      if (!el || el.closest('header, nav')) return;
      const name = `${el.className || ''} ${el.id || ''}`;
      if (/\b(nav|menu|dropdown|submenu)\b/i.test(name)) return;
      el.remove();
    });
    if (document.body) document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
    const accept = [...document.querySelectorAll('button, a, [role="button"]')].find((el) => {
      const label = (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      return label.length > 1 && label.length < 48 && /accept all|accept|agree|allow all|accetta|aceptar|akzeptieren|tout accepter|i agree/i.test(label);
    });
    if (accept) {
      accept.click();
      await wait(150);
    }
    for (let i = 0; i < 2; i += 1) {
      window.scrollBy(0, window.innerHeight * 0.9);
      await wait(120);
    }
    window.scrollTo(0, 0);
    await Promise.race([
      document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve(),
      wait(400),
    ]);
    const pick = (srcset) => {
      let best = '';
      let gap = Infinity;
      for (const part of String(srcset || '').split(',')) {
        const bits = part.trim().split(/\s+/);
        const url = bits[0];
        const width = parseInt(String(bits[1] || '').replace(/\D/g, ''), 10) || 0;
        if (!url) continue;
        const next = width ? Math.abs(width - 800) : 500;
        if (next < gap) { gap = next; best = url; }
      }
      return best;
    };
    const abs = (value) => {
      if (!value || /^(data:|blob:|javascript:)/i.test(value)) return '';
      try { return new URL(value, location.href).href; } catch { return ''; }
    };
    const found = [];
    const push = (value) => {
      const full = abs(value);
      if (full && /^https?:/i.test(full)) found.push(full);
    };
    document.querySelectorAll('video').forEach((video) => {
      const sources = [...video.querySelectorAll('source')];
      let chosen = abs(video.currentSrc)
        || abs(video.getAttribute('src'))
        || abs(video.getAttribute('data-src'))
        || abs(video.getAttribute('data-video-src'));
      for (const source of sources) {
        const src = abs(source.getAttribute('src') || source.getAttribute('data-src'));
        if (src) source.setAttribute('src', src);
        if (!chosen && src) chosen = src;
      }
      if (chosen) {
        video.setAttribute('src', chosen);
        video.setAttribute('muted', '');
        video.setAttribute('autoplay', '');
        video.setAttribute('loop', '');
        video.setAttribute('playsinline', '');
      }
      const poster = abs(video.getAttribute('poster') || video.getAttribute('data-poster'));
      if (poster) {
        video.setAttribute('poster', poster);
        push(poster);
      }
    });
    document.querySelectorAll('img').forEach((img) => {
      const source = img.parentElement && img.parentElement.querySelector ? img.parentElement.querySelector('source[srcset]') : null;
      const chosen = abs(pick(img.getAttribute('srcset') || ''))
        || abs(source && pick(source.getAttribute('srcset') || ''))
        || abs(img.currentSrc)
        || abs(img.getAttribute('data-src'))
        || abs(img.getAttribute('data-lazy-src'))
        || abs(img.getAttribute('data-original'))
        || abs(img.getAttribute('data-lazy'))
        || abs(img.getAttribute('src'));
      if (chosen) {
        img.setAttribute('src', chosen);
        push(chosen);
      }
      img.removeAttribute('srcset');
      img.setAttribute('loading', 'eager');
    });
    document.querySelectorAll('picture source').forEach((el) => el.removeAttribute('srcset'));
    document.querySelectorAll('[style*="url"]').forEach((el) => {
      const style = el.getAttribute('style') || '';
      const next = style.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (all, quote, val) => {
        const full = abs(val);
        if (!full) return all;
        push(full);
        return `url("${full}")`;
      });
      if (next !== style) el.setAttribute('style', next);
    });
    return [...new Set(found)].slice(0, 24);
  }).catch(() => []);
}

async function grabFonts(page) {
  return page.evaluate(async () => {
    const faces = [];
    const seen = new Set();
    for (const sheet of [...document.styleSheets]) {
      let rules = [];
      try { rules = [...sheet.cssRules]; } catch { continue; }
      for (const rule of rules) {
        if (!rule.style || !String(rule.cssText || '').includes('@font-face')) continue;
        const family = String(rule.style.getPropertyValue('font-family') || '').replace(/["']/g, '').trim();
        const src = String(rule.style.getPropertyValue('src') || '');
        const rel = (src.match(/url\((['"]?)([^'")]+?\.woff2)/i) || [])[2];
        if (!family || !rel || seen.has(rel)) continue;
        let abs = '';
        try { abs = new URL(rel, sheet.href || location.href).href; } catch { continue; }
        seen.add(rel);
        faces.push({ family, url: abs });
        if (faces.length >= 6) break;
      }
      if (faces.length >= 6) break;
    }
    const out = [];
    for (const face of faces) {
      try {
        const res = await fetch(face.url);
        if (!res.ok) continue;
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length < 40 || buf.length > 400000) continue;
        let binary = '';
        for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        out.push({ family: face.family, b64: btoa(binary) });
      } catch { /* the face stays on the original host */ }
    }
    return out;
  }).catch(() => []);
}

async function collectFace(page) {
  return page.evaluate(() => {
    const abs = (value) => {
      if (!value || /^(data:|blob:|javascript:)/i.test(value)) return '';
      try { return new URL(value, location.href).href; } catch { return ''; }
    };
    const sheets = [];
    const fonts = [];
    const icons = [];
    const pushFont = (value) => {
      const full = abs(value);
      if (full && /\.(woff2?|ttf|otf)(\?|$)/i.test(full)) fonts.push(full);
    };
    document.querySelectorAll('link[rel~="stylesheet"]').forEach((el) => {
      const href = abs(el.href || el.getAttribute('href'));
      if (href) sheets.push(href);
    });
    document.querySelectorAll('link[rel~="icon"], link[rel~="apple-touch-icon"]').forEach((el) => {
      const href = abs(el.href || el.getAttribute('href'));
      if (href) icons.push(href);
    });
    for (const sheet of [...document.styleSheets]) {
      let rules = [];
      try { rules = [...sheet.cssRules]; } catch { continue; }
      for (const rule of rules) {
        const text = rule.cssText || '';
        const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
        let match;
        while ((match = re.exec(text))) {
          if (/font-face/i.test(rule.cssText || '') || /\.(woff2?|ttf|otf)(\?|$)/i.test(match[2])) pushFont(match[2]);
          else if (/\.svg(\?|$)/i.test(match[2])) {
            const full = abs(match[2]);
            if (full) icons.push(full);
          }
        }
      }
    }
    return {
      sheets: [...new Set(sheets)].slice(0, 4),
      fonts: [...new Set(fonts)].slice(0, 6),
      icons: [...new Set(icons)].slice(0, 6),
    };
  }).catch(() => ({ sheets: [], fonts: [], icons: [] }));
}

async function mirrorAssets(env, job, html, urls, extras) {
  const jobId = job.id;
  const referer = job.source_url;
  const unique = [];
  const seen = new Set();
  for (const url of [...(urls || []), ...(extras?.icons || [])]) {
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    unique.push(url);
    if (unique.length >= 12) break;
  }
  const fontUrls = [];
  for (const url of extras?.fonts || []) {
    if (/^https?:\/\//i.test(url) && !seen.has(url)) fontUrls.push(url);
  }
  const sheetUrls = (extras?.sheets || []).filter((url) => /^https?:\/\//i.test(url)).slice(0, 4);
  let totalCount = Math.max(1, unique.length + fontUrls.length + sheetUrls.length);
  let done = 0;
  let aborted = false;
  const report = async () => {
    if (aborted) return;
    done += 1;
    const ok = await saveJob(env, {
      ...job,
      status: 'running',
      phase: 'packaging',
      phaseDetail: `Scanning · ${Math.min(done, totalCount)}/${totalCount}`,
    }).catch(() => false);
    if (!ok) aborted = true;
  };
  const pairs = [];
  const images = [];
  const files = [];
  let total = 0;
  let cursor = 0;
  async function pull() {
    while (cursor < unique.length && !aborted) {
      const index = cursor;
      const url = unique[cursor];
      cursor += 1;
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(2500),
          headers: {
            'User-Agent': PHONE_UA,
            Referer: referer || url,
            Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
          },
        });
        if (!res.ok) continue;
        const buf = new Uint8Array(await res.arrayBuffer());
        const kind = imageFile(buf, res.headers.get('content-type') || '');
        if (!kind || buf.length < 40 || buf.length > 900000) continue;
        if (total + buf.length > 6000000) return;
        total += buf.length;
        const name = `assets/img-${index}${kind.ext}`;
        await env.R2.put(`sites/${jobId}/${name}`, buf, { httpMetadata: { contentType: kind.type } });
        pairs.push({ from: url, to: name });
        files.push({ name, data: buf });
        images.push({
          url,
          local: name,
          size: buf.length,
          contentType: kind.type,
          kind: buf.length < 8000 || kind.ext === '.svg' ? 'icon' : 'photo',
          small: buf.length < 8000,
        });
      } catch { /* one image can fail */ }
      finally { await report(); }
    }
  }
  await Promise.all([pull(), pull(), pull(), pull()]);
  let css = '';
  const fontAliases = new Map();
  const cssAssets = [];
  for (const sheetUrl of sheetUrls) {
    try {
      const res = await fetch(sheetUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(2500),
        headers: { 'User-Agent': PHONE_UA, Referer: referer || sheetUrl },
      });
      if (res.ok) {
        const text = (await res.text()).slice(0, 400000);
        css += `\n${text}`;
        const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
        let match;
        while ((match = re.exec(text))) {
          const isFont = /\.(woff2?|ttf|otf)(\?|$)/i.test(match[2]);
          const isIcon = /\.(svg|png|jpe?g|webp|gif|avif)(\?|$)/i.test(match[2]);
          if (!isFont && !isIcon) continue;
          if (isFont && fontUrls.length >= 6) continue;
          if (isIcon && cssAssets.length >= 4) continue;
          try {
            const full = new URL(match[2], sheetUrl).href;
            if (isFont) {
              if (!fontUrls.includes(full)) fontUrls.push(full);
              const aliases = fontAliases.get(full) || [];
              aliases.push(match[2], full);
              fontAliases.set(full, aliases);
            } else if (!cssAssets.some((item) => item.url === full)) {
              cssAssets.push({ url: full, alias: match[2] });
            }
          } catch { /* skip a bad asset url */ }
        }
      }
    } catch { /* one stylesheet can fail */ }
    finally { await report(); }
  }
  totalCount = unique.length + fontUrls.length + sheetUrls.length;
  let fontCursor = 0;
  const fontPairs = [];
  async function pullFont() {
    while (fontCursor < fontUrls.length && !aborted) {
      const index = fontCursor;
      const url = fontUrls[fontCursor];
      fontCursor += 1;
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(2500),
          headers: { 'User-Agent': PHONE_UA, Referer: referer || url },
        });
        if (!res.ok) continue;
        const buf = new Uint8Array(await res.arrayBuffer());
        const kind = fontFile(res.headers.get('content-type') || '', url);
        if (!kind || buf.length < 40 || buf.length > 900000 || total + buf.length > 6000000) continue;
        total += buf.length;
        const filename = `font-${index}${kind.ext}`;
        await env.R2.put(`sites/${jobId}/assets/${filename}`, buf, { httpMetadata: { contentType: kind.type } });
        fontPairs.push({ from: url, to: filename, aliases: fontAliases.get(url) || [url] });
        files.push({ name: `assets/${filename}`, data: buf });
      } catch { /* one font can fail */ }
      finally { await report(); }
    }
  }
  await Promise.all([pullFont(), pullFont()]);
  let cssCursor = 0;
  const cssPairs = [];
  async function pullCssAsset() {
    while (cssCursor < cssAssets.length && !aborted) {
      const index = cssCursor;
      const item = cssAssets[cssCursor];
      cssCursor += 1;
      try {
        const res = await fetch(item.url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(2500),
          headers: { 'User-Agent': PHONE_UA, Referer: referer || item.url, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
        });
        if (!res.ok) continue;
        const buf = new Uint8Array(await res.arrayBuffer());
        const kind = imageFile(buf, res.headers.get('content-type') || '');
        if (!kind || buf.length < 40 || buf.length > 900000 || total + buf.length > 6000000) continue;
        total += buf.length;
        const filename = `css-${index}${kind.ext}`;
        await env.R2.put(`sites/${jobId}/assets/${filename}`, buf, { httpMetadata: { contentType: kind.type } });
        pairs.push({ from: item.url, to: `assets/${filename}` });
        pairs.push({ from: item.alias, to: `assets/${filename}` });
        cssPairs.push({ from: item.url, to: filename, aliases: [item.alias, item.url] });
        files.push({ name: `assets/${filename}`, data: buf });
      } catch { /* one icon can fail */ }
    }
  }
  await Promise.all([pullCssAsset(), pullCssAsset()]);
  let next = rewriteMirrored(html, pairs);
  if (css && (fontPairs.length || cssPairs.length)) {
    let localCss = css;
    for (const pair of [...fontPairs, ...cssPairs]) {
      const aliases = pair.aliases || [pair.from];
      for (const alias of aliases) {
        if (!alias) continue;
        localCss = localCss.split(alias).join(pair.to);
        localCss = localCss.split(String(alias).replace(/&/g, '&amp;')).join(pair.to);
      }
    }
    const saved = new TextEncoder().encode(localCss.slice(0, 500000));
    await env.R2.put(`sites/${jobId}/assets/captured.css`, saved, { httpMetadata: { contentType: 'text/css; charset=utf-8' } });
    files.push({ name: 'assets/captured.css', data: saved });
    const link = '<link rel="stylesheet" href="assets/captured.css">';
    next = /<head[^>]*>/i.test(next) ? next.replace(/<head[^>]*>/i, (open) => `${open}${link}`) : `<head>${link}</head>${next}`;
  }
  return { html: next, images, files, aborted };
}

async function saveJob(env, job) {
  const existing = await env.R2.get(`sites/${job.id}/job.json`);
  const saved = existing ? await existing.json().catch(() => null) : null;
  if (saved && /stopped/i.test(String(saved.error || ''))) return false;
  if (saved && saved.status === 'done' && job.status === 'running') return false;
  if (saved && (saved.status === 'failed' || saved.status === 'blocked') && job.status !== 'failed' && job.status !== 'blocked') return false;
  await env.R2.put(`sites/${job.id}/job.json`, JSON.stringify(job), {
    httpMetadata: { contentType: 'application/json' },
  });
  return true;
}

export async function captureInBrowser(env, job) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(PHONE_UA);
    await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const opened = await page.goto(job.source_url, { waitUntil: 'domcontentloaded', timeout: 25000 }).then(() => true).catch(() => false);
    if (!opened) await page.goto(job.source_url, { waitUntil: 'commit', timeout: 15000 }).catch(() => {});
    await page.evaluate(() => new Promise((resolve) => {
      const done = () => resolve();
      if (document.readyState === 'complete') setTimeout(done, 300);
      else window.addEventListener('load', () => setTimeout(done, 300), { once: true });
      setTimeout(done, 2000);
    })).catch(() => {});
    const urls = await settleImages(page).catch(() => []);
    const extras = await collectFace(page).catch(() => ({ sheets: [], fonts: [], icons: [] }));
    const shot = new Uint8Array(await page.screenshot({ type: 'png' }).catch(() => new Uint8Array()));
    const raw = await page.content().catch(() => '');
    const brandFonts = await grabFonts(page).catch(() => []);
    await browser.close();
    const text = raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const rich = /<(img|video|source|link)\b/i.test(raw);
    let html = (text.length > 40 || rich) ? preparePage(raw, job.source_url) : screenshotPage();
    const savedFonts = [];
    for (const face of brandFonts) {
      try {
        const binary = atob(face.b64);
        const data = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) data[i] = binary.charCodeAt(i);
        const family = String(face.family || '').replace(/["']/g, '').trim();
        const file = `${family.replace(/[^a-z0-9_-]+/gi, '') || `font-${savedFonts.length}`}.woff2`;
        if (!family || data.length < 40) continue;
        await env.R2.put(`sites/${job.id}/assets/${file}`, data, { httpMetadata: { contentType: 'font/woff2' } });
        savedFonts.push({ family, file, data });
      } catch { /* one face can fail */ }
    }
    if (savedFonts.length && !html.includes('data-proto-font')) {
      const faces = savedFonts.map((face) => `@font-face{font-family:"${face.family}";src:url("assets/${face.file}") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}`).join('');
      html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `<style data-proto-font>${faces}</style></head>`) : `<style data-proto-font>${faces}</style>${html}`;
    }
    let images = [];
    let files = [];
    const stoppedNow = async () => {
      const prior = await env.R2.get(`sites/${job.id}/job.json`);
      const priorJob = prior ? await prior.json().catch(() => null) : null;
      return !!(priorJob && /stopped/i.test(String(priorJob.error || '')));
    };
    if (await stoppedNow()) return;
    await env.R2.put(`sites/${job.id}/screenshots/phone.png`, shot, {
      httpMetadata: { contentType: 'image/png' },
    });
    await env.R2.put(`sites/${job.id}/index.html`, html, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    });
    const ready = await saveJob(env, {
      ...job,
      status: 'running',
      phase: 'packaging',
      phaseDetail: 'Scanning',
    });
    if (!ready) return;
    files = [{ name: 'screenshots/phone.png', data: shot }];
    for (const face of savedFonts) files.push({ name: `assets/${face.file}`, data: face.data });
    if (text.length > 40 || rich) {
      try {
        const mirrored = await Promise.race([
          mirrorAssets(env, job, html, urls, extras),
          new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
        ]);
        if (mirrored && !mirrored.aborted && mirrored.html) {
          html = mirrored.html;
          images = mirrored.images || [];
          files = files.concat(mirrored.files || []);
          await env.R2.put(`sites/${job.id}/index.html`, html, {
            httpMetadata: { contentType: 'text/html; charset=utf-8' },
          });
        }
      } catch { /* a large site still keeps the page saved above */ }
    }
    if (images.length) {
      await env.R2.put(`sites/${job.id}/manifest.json`, JSON.stringify({ images, totalMB: Math.round(images.reduce((sum, img) => sum + img.size, 0) / 1048576 * 100) / 100 }), {
        httpMetadata: { contentType: 'application/json' },
      }).catch(() => {});
    }
    if (await stoppedNow()) return;
    await saveJob(env, {
      ...job,
      status: 'done',
      phase: 'packaging',
      phaseDetail: 'Scanning',
      error: null,
      finished_at: new Date().toISOString(),
      stats: { images: images.length || (shot.length ? 1 : 0) },
    });
    try {
      const zip = zipStore([
        { name: 'index.html', data: new TextEncoder().encode(html) },
        ...files.filter((file) => file && file.name !== 'index.html'),
      ]);
      await env.R2.put(`sites/${job.id}/full.zip`, zip, {
        httpMetadata: { contentType: 'application/zip' },
      });
    } catch { /* the preview is already saved if the zip is too large */ }
    return;
  } finally {
    await browser.close().catch(() => {});
  }
}
