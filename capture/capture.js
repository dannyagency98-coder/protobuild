#!/usr/bin/env node
/**
 * Capture script — BUILD_PLAN.md section 7
 * clone | images | upload. Writes to OUT_ROOT/{jobId} and optional R2.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');
const { execFileSync } = require('child_process');
const archiver = require('archiver');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const limits = require('../limits.json');

const JOB_ID = process.env.JOB_ID || 'local-test';
const MODE = process.env.MODE || 'clone';
const URL_TO_CAPTURE = process.env.URL || '';
const OPTIONS = JSON.parse(process.env.OPTIONS || '{}');
const OUT_ROOT = process.env.OUT_ROOT || path.join(__dirname, '..', 'out');
const OUT_DIR = path.join(OUT_ROOT, JOB_ID);
const ASSETS_DIR = path.join(OUT_DIR, 'assets');
const SHOTS_DIR = path.join(OUT_DIR, 'screenshots');
const ZIP_DIR = path.join(OUT_ROOT, 'zips');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function hashShort(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

function sanitizeFilename(name) {
  return (name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === '::1') return true;
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (ip.startsWith('::ffff:')) return isPrivateIp(ip.slice(7));
  if (net.isIP(ip) !== 4) return false;
  const p = ip.split('.').map(Number);
  if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  return false;
}

async function assertSafeUrl(raw) {
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http/https allowed');
  const host = parsed.hostname.toLowerCase();
  if (['localhost', '0.0.0.0'].includes(host) || host.endsWith('.local')) throw new Error('Blocked host');
  if (net.isIP(host) && isPrivateIp(host)) throw new Error('Private IP blocked');
  const looked = await dns.lookup(host, { all: true });
  if (looked.some((r) => isPrivateIp(r.address))) throw new Error('Resolves to private IP');
  return parsed;
}

function writeResult(patch) {
  try {
    ensureDir(OUT_DIR);
    fs.writeFileSync(path.join(OUT_DIR, 'result.json'), JSON.stringify({
      ...patch,
      finished_at: patch.finished_at || new Date().toISOString(),
    }));
  } catch {}
}

function r2Client() {
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_BUCKET) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

async function mergeStoredJob(patch) {
  const client = r2Client();
  if (!client) return;
  const Key = `sites/${JOB_ID}/job.json`;
  let current = {};
  try {
    const got = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key }));
    current = JSON.parse(await got.Body.transformToString());
  } catch { /* the first write creates the record */ }
  if (current.status === 'failed' && /stopped/i.test(String(current.error || '')) && patch.status && patch.status !== 'failed') return;
  const next = { ...current, ...patch, id: current.id || JOB_ID };
  await client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key,
    Body: JSON.stringify(next),
    ContentType: 'application/json',
  }));
}

async function supabasePatch(patch) {
  writeResult(patch);
  await mergeStoredJob(patch).catch((err) => console.error('Job record update failed', err.message || err));
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  await fetch(`${url}/rest/v1/jobs?id=eq.${JOB_ID}`, {
    method: 'PATCH',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(patch),
  }).catch(() => {});
}

function plainError(message) {
  const text = String(message || 'Capture failed').replace(/\u001b\[[0-9;]*m/g, '');
  if (/timeout/i.test(text)) return 'The site did not respond in time. Scan it again, or attach a saved copy of the page.';
  return text.split('\n')[0].slice(0, 280);
}

async function fail(message, status = 'failed') {
  const error = plainError(message);
  console.error(error);
  await supabasePatch({ status, error, finished_at: new Date().toISOString() });
  process.exit(1);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.json': 'application/json',
    '.zip': 'application/zip',
  }[ext] || 'application/octet-stream';
}

async function uploadToR2(key, body, type) {
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_BUCKET) return;
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  await client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: type || 'application/octet-stream',
  }));
}

function createZip(sourceDir, zipPath, filterFn) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(zipPath));
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 1 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false, (entry) => {
      if (filterFn && !filterFn(entry.name)) return false;
      return entry;
    });
    archive.finalize();
  });
}

function relBetween(fromFile, toFile) {
  let rel = path.posix.relative(path.posix.dirname(fromFile), toFile);
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

function rewriteCssUrls(css, urlToLocal, baseUrl, fromFile) {
  const swap = (abs) => {
    if (!urlToLocal.has(abs)) return null;
    const local = urlToLocal.get(abs);
    return fromFile ? relBetween(fromFile, local) : local;
  };
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, val) => {
    if (val.startsWith('data:') || val.startsWith('#')) return m;
    try {
      const next = swap(new URL(val, baseUrl).href);
      if (next) return `url("${next}")`;
    } catch {}
    return m;
  }).replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, val) => {
    try {
      const next = swap(new URL(val, baseUrl).href);
      if (next) return `@import "${next}"`;
    } catch {}
    return m;
  });
}

const phaseLog = [];
function note(phase, detail) {
  phaseLog.push({ phase, detail, at: new Date().toISOString() });
  try {
    ensureDir(OUT_DIR);
    fs.writeFileSync(path.join(OUT_DIR, 'status.json'), JSON.stringify({
      phase,
      detail,
      log: phaseLog.slice(-16),
    }));
  } catch {}
}

function postProcessHtml(html) {
  html = html.replace(/<link[^>]+rel=["'](?:modulepreload|preload)["'][^>]*>/gi, (tag) => {
    return /as=["']script["']/i.test(tag) ? '' : tag;
  });
  html = html.replace(/\s+on\w+\s*=\s*(['"])\s*javascript:[^'"]*\1/gi, '');
  html = html.replace(/<form\b([^>]*)>/gi, (m, attrs) => {
    attrs = attrs.replace(/\saction\s*=\s*(['"]).*?\1/gi, '');
    return `<form${attrs}>`;
  });
  html = html.replace(/<input([^>]*type=["'](?:password)["'][^>]*)>/gi, '');
  html = html.replace(/<input([^>]*)>/gi, (m, attrs) => {
    if (/autocomplete=["']cc-|name=["'][^"']*(card|cvv|cvc|iban|account)/i.test(attrs)) return '';
    return m;
  });
  return html;
}

function fitMedium(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return;
  try {
    if (fs.statSync(filePath).size < 220 * 1024) return;
    execFileSync('sips', ['-Z', '1200', filePath], { stdio: 'ignore' });
  } catch { /* leave the original when this machine cannot resize it */ }
}

function pickSrcset(srcset) {
  if (!srcset) return '';
  const target = 1000;
  let best = '';
  let bestGap = Infinity;
  let fallback = '';
  for (const part of srcset.split(',')) {
    const bits = part.trim().split(/\s+/);
    const url = bits[0];
    if (!url) continue;
    const w = parseInt((bits[1] || '0').replace(/\D/g, ''), 10) || 0;
    if (!fallback) fallback = url;
    if (!w) continue;
    const gap = Math.abs(w - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = url;
    }
  }
  return best || fallback || srcset.split(',')[0].trim().split(/\s+/)[0];
}

function readUploadedHtml(src) {
  const ext = path.extname(src).toLowerCase();
  if (ext !== '.zip') return fs.readFileSync(src, 'utf8');
  const extracted = path.join(OUT_DIR, '_upload');
  ensureDir(extracted);
  execFileSync('unzip', ['-o', '-q', src, '-d', extracted], { stdio: 'pipe' });
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.html?$/i.test(entry.name)) found.push(full);
    }
  };
  walk(extracted);
  const index = found.find((f) => path.basename(f).toLowerCase() === 'index.html') || found[0];
  if (!index) throw new Error('ZIP has no HTML file. Save the page as a SingleFile .html instead.');
  return fs.readFileSync(index, 'utf8');
}

async function downloadR2(key, dest) {
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_BUCKET) return false;
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  try {
    const got = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
    const bytes = Buffer.from(await got.Body.transformToByteArray());
    fs.writeFileSync(dest, bytes);
    return true;
  } catch {
    return false;
  }
}

async function copyLinkedPages(page, sourceUrl) {
  const links = await page.evaluate(() => {
    const host = location.host;
    const hrefs = [];
    for (const a of document.querySelectorAll('a[href]')) {
      try {
        const next = new URL(a.href, location.href);
        if (next.host !== host || !/^https?:$/.test(next.protocol)) continue;
        hrefs.push(next.href.split('#')[0]);
      } catch { /* skip */ }
    }
    return hrefs;
  }).catch(() => []);
  const product = links.find((href) => /\/products?\//i.test(href) || /\/shop\//i.test(href));
  const collection = links.find((href) => /\/collections?\//i.test(href) && href !== product);
  const saved = [];
  ensureDir(path.join(OUT_DIR, 'pages'));
  let n = 0;
  for (const href of [product, collection].filter(Boolean)) {
    n += 1;
    try {
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(700);
      fs.writeFileSync(path.join(OUT_DIR, 'pages', `${n}.html`), await page.content());
      saved.push({ url: href, local: `pages/${n}.html` });
    } catch { /* a linked page can fail without failing the main copy */ }
  }
  if (saved.length) {
    try { await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch { /* stay on the last page */ }
  }
  return saved;
}

async function dismissLocation(page) {
  const closed = await page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"], .c-popin--opened')];
    const dialog = dialogs.find((el) => /select your location/i.test(el.textContent || ''));
    if (!dialog) return false;
    dialog.remove();
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
    return true;
  }).catch(() => false);
  if (closed) await page.waitForTimeout(250);
}

async function collectProductShots(page, context, sourceUrl, knownUrls) {
  await dismissLocation(page);
  const known = new Set(knownUrls || []);
  const links = await page.evaluate(() => {
    const host = location.host;
    const hrefs = [];
    for (const a of document.querySelectorAll('a[href]')) {
      try {
        const next = new URL(a.href, location.href);
        if (next.host !== host) continue;
        const path = next.pathname.toLowerCase();
        if (!/\/(products?|p|t|shop|item)\//.test(path) && !/-[a-z0-9]*\d[a-z0-9]{4,}\.html$/i.test(path)) continue;
        hrefs.push(next.href.split('?')[0].split('#')[0]);
      } catch { /* skip */ }
    }
    return [...new Set(hrefs)].slice(0, 4);
  }).catch(() => []);
  const saved = [];
  const seenHash = new Set();
  for (const href of links) {
    try {
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 8000 });
      await page.waitForTimeout(200);
      await dismissLocation(page);
      const srcs = await page.evaluate((knownList) => {
        const seen = new Set(knownList);
        const root = document.querySelector('main') || document.body;
        const out = [];
        for (const img of root.querySelectorAll('img')) {
          if (img.closest('header, nav, footer')) continue;
          const src = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || '';
          if (!src || src.startsWith('data:') || /\.svg($|\?)/i.test(src)) continue;
          let abs = src;
          try { abs = new URL(src, location.href).href; } catch { continue; }
          if (seen.has(abs)) continue;
          const wide = img.naturalWidth || img.width || 0;
          if (wide && wide < 240) continue;
          out.push(abs);
          if (out.length === 2) break;
        }
        return out;
      }, [...known]);
      for (const src of srcs) {
        const abs = new URL(src, href).href;
        const res = await context.request.get(abs, { timeout: 2500 });
        if (!res.ok()) continue;
        const buf = Buffer.from(await res.body());
        if (buf.length < 800 || buf.length > 8 * 1024 * 1024) continue;
        const digest = hashShort(buf);
        if (seenHash.has(digest)) continue;
        seenHash.add(digest);
        const ext = (path.extname(new URL(abs).pathname).split('?')[0] || '.jpg').slice(0, 5) || '.jpg';
        const name = `product-${digest}${ext.startsWith('.') ? ext : '.jpg'}`;
        const file = path.join(ASSETS_DIR, name);
        fs.writeFileSync(file, buf);
        fitMedium(file);
        const size = fs.statSync(file).size;
        known.add(abs);
        saved.push({
          url: abs,
          local: `assets/${name}`,
          size,
          contentType: (res.headers()['content-type'] || 'image/jpeg').split(';')[0],
          kind: 'product',
        });
      }
    } catch { /* one product page can fail */ }
  }
  try { await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 8000 }); } catch { /* the main copy is already saved */ }
  if (!saved.length) throw new Error('No product pictures were found on this page.');
  return saved;
}

async function processUpload() {
  let src = OPTIONS.uploadPath;
  if (!src || !fs.existsSync(src)) {
    ensureDir(OUT_DIR);
    const zipDest = path.join(OUT_DIR, 'source.zip');
    const htmlDest = path.join(OUT_DIR, 'source.html');
    if (await downloadR2(`sites/${JOB_ID}/source.zip`, zipDest)) src = zipDest;
    else if (await downloadR2(`sites/${JOB_ID}/source.html`, htmlDest)) src = htmlDest;
  }
  if (!src || !fs.existsSync(src)) throw new Error('Upload file missing');
  ensureDir(OUT_DIR);
  ensureDir(ASSETS_DIR);
  let html = readUploadedHtml(src);
  const images = [];
  let total = 0;
  html = html.replace(/src=["']data:(image\/[a-zA-Z0-9.+-]+);base64,([^"']+)["']/g, (m, mime, b64) => {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > limits.maxFileMB * 1024 * 1024) return m;
    total += buf.length;
    const extn = (mime.split('/')[1] || 'bin').split('+')[0];
    const name = `inline-${hashShort(buf)}.${extn}`;
    fs.writeFileSync(path.join(ASSETS_DIR, name), buf);
    images.push({ url: name, size: buf.length, contentType: mime, local: `assets/${name}` });
    return `src="assets/${name}"`;
  });
  html = postProcessHtml(html);
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html);
  return { html, images, totalSize: total, warnings: ['Upload mode: no live network capture.'] };
}

async function main() {
  const started = Date.now();
  const watchdog = setTimeout(() => {
    fail(`Timed out after ${limits.timeoutSec}s`).catch(() => process.exit(1));
  }, limits.timeoutSec * 1000);
  watchdog.unref?.();

  await supabasePatch({ status: 'running' });
  ensureDir(OUT_DIR);
  ensureDir(ASSETS_DIR);
  ensureDir(SHOTS_DIR);
  ensureDir(ZIP_DIR);

  let images = [];
  let totalSize = 0;
  let extraPages = [];
  const warnings = [];
  let sourceUrl = URL_TO_CAPTURE || OPTIONS.source_url || '';
  note('opening', sourceUrl || 'saved file');

  if (MODE === 'upload') {
    const result = await processUpload();
    images = result.images;
    totalSize = result.totalSize;
    warnings.push(...result.warnings);
    const manifest = {
      url: sourceUrl || '(upload)',
      mode: MODE,
      timestamp: new Date().toISOString(),
      imageCount: images.length,
      totalMB: +(totalSize / 1024 / 1024).toFixed(2),
      warnings,
      images,
    };
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'outline.json'), JSON.stringify({
      sections: [
        { selector: 'header', snippet: 'Header', styles: {} },
        { selector: 'main', snippet: 'Main', styles: {} },
        { selector: 'footer', snippet: 'Footer', styles: {} },
      ],
    }, null, 2));
    await finalize(manifest);
    clearTimeout(watchdog);
    return;
  }

  if (!sourceUrl) await fail('Missing URL');
  let parsed;
  try { parsed = await assertSafeUrl(sourceUrl); }
  catch (e) { await fail(e.message); }

  const resourceMap = new Map();
  const seenHash = new Map();
  const launchArgs = ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--disable-ipv6'];
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: launchArgs });
  } catch {
    browser = await chromium.launch({ headless: true, args: launchArgs });
  }
  const viewport = OPTIONS.viewport === 'mobile'
    ? { width: 390, height: 844 }
    : { width: 1440, height: 900 };
  const context = await browser.newContext({
    viewport,
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(12000);
  const heavyScript = /(?:google-analytics|googletagmanager|googleadservices|googlesyndication|doubleclick|facebook\.net|connect\.facebook|hotjar|segment\.(?:io|com)|sentry\.io|newrelic|nr-data\.net|optimizely|criteo|taboola|clarity\.ms|analytics\.tiktok|pinimg\.com|scorecardresearch|quantserve|demdex|omtrdc|adobedtm|ensighten|fullstory|mouseflow|intercom|zendesk|tawk\.to|recaptcha|bat\.bing|adnxs|chartbeat|contentsquare|quantummetric|dynatrace)/i;
  await page.route('**/*', (route) => {
    const req = route.request();
    const type = req.resourceType();
    const url = req.url();
    if (type === 'media' || type === 'websocket' || type === 'manifest') return route.abort();
    if (/\.(mp4|webm|m3u8)(\?|$)/i.test(url)) return route.abort();
    if ((type === 'script' || type === 'eventsource' || type === 'xhr' || type === 'fetch' || type === 'ping') && heavyScript.test(url)) return route.abort();
    return route.continue();
  });

  page.on('response', async (response) => {
    try {
      const url = response.url();
      const ct = (response.headers()['content-type'] || '').toLowerCase();
      const pathName = (() => { try { return new URL(url).pathname; } catch { return url; } })();
      const isImage = ct.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|avif|ico)(\?|$)/i.test(pathName);
      const isScript = ct.includes('javascript') || ct.includes('ecmascript') || /\.(js|mjs)(\?|$)/i.test(pathName);
      if (isScript) return;
      const isAsset = isImage || ct.includes('css') || ct.includes('font') || ct.includes('woff') || /\.(css|woff2?|ttf)(\?|$)/i.test(pathName);
      if (!isAsset) return;
      if (MODE === 'images' && !isImage) return;
      if (isImage && images.length >= 20) return;
      const declared = Number(response.headers()['content-length'] || 0);
      if (declared > 1500000) return;
      const buf = await response.body().catch(() => null);
      if (!buf || !buf.length) return;

      if (buf.length > limits.maxFileMB * 1024 * 1024) return;
      if (totalSize + buf.length > limits.maxTotalMB * 1024 * 1024) return;
      totalSize += buf.length;
      resourceMap.set(url, { body: buf, contentType: ct, size: buf.length });
      if (isImage) images.push({ url, size: buf.length, contentType: (ct.split(';')[0] || 'image') });
    } catch {}
  });

  try {
    const directCtl = new AbortController();
    const directHtml = fetch(sourceUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: directCtl.signal,
    }).then(async (res) => (res.ok ? { html: await res.text(), url: res.url || sourceUrl } : null)).catch(() => null);
    let nav;
    let navError;
    try {
      nav = await page.goto(sourceUrl, { waitUntil: 'commit', timeout: 7000 });
      directCtl.abort();
    } catch (err) {
      navError = err;
    }
    if (navError) {
      const direct = await directHtml;
      if (!direct?.html) throw navError;
      let html = direct.html;
      const base = direct.url || sourceUrl;
      if (!/<base\s/i.test(html)) {
        if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (tag) => `${tag}<base href="${base}">`);
        else html = `<head><base href="${base}"></head>${html}`;
      }
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 });
      warnings.push('The browser stalled, so the page was loaded from a direct download.');
      nav = null;
    }
    await page.waitForSelector('body', { timeout: 4000 }).catch(() => {});
    note('reading', 'Reading this page only');
    await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
    await page.waitForFunction(() => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      const painted = [...document.images].some((img) => img.naturalWidth > 80);
      return painted || text.length > 240;
    }, { timeout: 1500 }).catch(() => {});

    const dismissed = await page.evaluate(() => {
      const selectors = [
        '#onetrust-accept-btn-handler',
        '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
        '#CybotCookiebotDialogBodyButtonAccept',
        '.cc-allow', '.cc-btn.cc-allow', '.cc-dismiss',
        '#cookieyes-consent .cky-btn-accept',
        '.cky-btn-accept',
        '#didomi-notice-agree-button',
      ];
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      };
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!visible(el)) continue;
        el.click();
        return true;
      }
      const names = /^(accept all|allow all|agree|i agree|got it|ok|accept)$/i;
      for (const el of document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')) {
        const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        if (!names.test(label) || !visible(el)) continue;
        el.click();
        return true;
      }
      return false;
    }).catch(() => false);
    if (dismissed) await page.waitForTimeout(200);
    await dismissLocation(page);

    async function wallKind() {
      const title = (await page.title()).toLowerCase();
      const sample = (await page.evaluate(() => (document.body?.innerText || '').slice(0, 900))).toLowerCase();
      const denied = title.includes('access denied')
        || sample.includes("you don't have permission to access")
        || sample.includes('errors.edgesuite.net')
        || sample.includes('reference #');
      if (denied) return 'denied';
      const soft = ['just a moment', 'verify you are human', 'attention required', 'enable javascript and cookies', 'cf-challenge'];
      if (soft.some((marker) => title.includes(marker) || sample.includes(marker))) return 'check';
      return '';
    }

    let wall = await wallKind();
    if (wall === 'check') {
      await page.waitForTimeout(400);
      wall = await wallKind();
    }

    const status = nav?.status?.() || 0;
    const textLen = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, '').length);
    if (wall === 'denied' || ((status === 403 || status === 429 || wall === 'check') && textLen < 80)) {
      await browser.close();
      await fail('This site refused the scanner with Access Denied. Open it in your own browser, save the page, and drop that file in the chat.', 'blocked');
    }

    const actions = Array.isArray(OPTIONS.actions) ? OPTIONS.actions : [];
    for (const action of actions) {
      try {
        if (action.type === 'click' && action.target) {
          await page.getByText(action.target, { exact: false }).first().click({ timeout: 2000 });
        } else if (action.type === 'wait') {
          await page.waitForTimeout(Math.min(Number(action.ms) || 500, 8000));
        } else if (action.type === 'scroll') {
          if (action.to === 'footer') await page.locator('footer').first().scrollIntoViewIfNeeded().catch(() => {});
          else await page.evaluate(() => {
            const el = document.scrollingElement || document.documentElement;
            if (el) window.scrollTo(0, el.scrollHeight);
          });
        } else if (action.type === 'setViewport' && action.width) {
          await page.setViewportSize({ width: Number(action.width), height: Number(action.height) || 900 });
        }
      } catch {}
    }

    if (OPTIONS.crawl && MODE === 'clone') {
      extraPages = await copyLinkedPages(page, sourceUrl);
      if (extraPages.length) warnings.push(`Also copied ${extraPages.length} page${extraPages.length === 1 ? '' : 's'} from the live links.`);
    }

    note('scrolling', 'Loading images on this page');
    let lastH = 0;
    const scrollBudget = OPTIONS.productShots ? 1 : 2;
    for (let i = 0; i < scrollBudget; i++) {
      const h = await page.evaluate(() => document.body?.scrollHeight || document.documentElement?.scrollHeight || 0).catch(() => 0);
      if (!h || h === lastH) break;
      lastH = h;
      await page.evaluate(() => {
        const el = document.scrollingElement || document.documentElement;
        if (el) el.scrollBy(0, window.innerHeight * 0.85);
      }).catch(() => {});
      await page.waitForTimeout(60);
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.evaluate(async () => {
      const imgs = [...document.images].filter((img) => !img.complete).slice(0, 20);
      await Promise.all(imgs.map((img) => new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 800);
      })));
    }).catch(() => {});

    await page.evaluate(() => {
      document.querySelectorAll('[data-src], [data-srcset], [data-bg], [data-lazy]').forEach((el) => {
        if (el.dataset.src) el.setAttribute('src', el.dataset.src);
        if (el.dataset.srcset) el.setAttribute('srcset', el.dataset.srcset);
        if (el.dataset.lazy) el.setAttribute('src', el.dataset.lazy);
        if (el.dataset.bg) el.style.backgroundImage = `url("${el.dataset.bg}")`;
        el.setAttribute('loading', 'eager');
      });
    });

    const shotPath = path.join(SHOTS_DIR, 'desktop.png');
    await page.screenshot({ path: shotPath, fullPage: false, timeout: 4000 }).catch(() => {});
    if (viewport.width <= 430) {
      try { fs.copyFileSync(shotPath, path.join(SHOTS_DIR, 'mobile.png')); } catch { /* the desktop shot is the one the preview uses */ }
    }
    if (fs.existsSync(shotPath)) {
      await page.evaluate(() => {
        document.querySelectorAll('video').forEach((video) => {
          const box = video.getBoundingClientRect();
          if (box.width < 120 || box.height < 80) return;
          const still = document.createElement('img');
          still.src = 'screenshots/desktop.png';
          still.alt = '';
          still.setAttribute('data-proto-still', '1');
          still.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;background:#111';
          video.replaceWith(still);
        });
      }).catch(() => {});
    }
    const copySecs = Math.max(0, Math.round((Date.now() - started) / 1000));
    note('saving', `Copying styles, fonts, and images · ${copySecs}s`);

    const pageAssets = await page.evaluate(() => {
      const photos = [];
      const icons = [];
      const add = (value, icon) => {
        if (!value || value.startsWith('data:') || value.startsWith('blob:') || value.startsWith('#')) return;
        try {
          const abs = new URL(value, location.href).href;
          (icon || /\.svg($|\?)/i.test(abs) ? icons : photos).push(abs);
        } catch {}
      };
      const medium = (srcset) => {
        let best = '';
        let gap = Infinity;
        for (const part of srcset.split(',')) {
          const bits = part.trim().split(/\s+/);
          const url = bits[0];
          const width = parseInt((bits[1] || '0').replace(/\D/g, ''), 10) || 0;
          if (!url) continue;
          const next = width ? Math.abs(width - 1000) : 400;
          if (next < gap) { gap = next; best = url; }
        }
        return best;
      };
      document.querySelectorAll('img, source, video, link[rel~="icon"]').forEach((el) => {
        const icon = el.matches('link[rel~="icon"]') || /\.svg($|\?)/i.test(el.getAttribute('src') || '');
        add(medium(el.getAttribute('srcset') || '') || el.getAttribute('src'), icon);
        add(el.getAttribute('poster'), false);
        add(el.getAttribute('href'), true);
      });
      document.querySelectorAll('[style]').forEach((el) => {
        const style = el.getAttribute('style') || '';
        const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
        let match;
        while ((match = re.exec(style))) add(match[2], /\.svg($|\?)/i.test(match[2]));
      });
      return { photos: [...new Set(photos)].slice(0, 16), icons: [...new Set(icons)].slice(0, 16) };
    }).catch(() => ({ photos: [], icons: [] }));

    const assetCap = Date.now() - started > 12000 ? 4 : 8;
    note('saving', `Copying ${assetCap} images and icons`);
    const pendingAssets = [...(pageAssets.icons || []), ...(pageAssets.photos || [])]
      .filter((assetUrl) => assetUrl && !resourceMap.has(assetUrl))
      .slice(0, assetCap);
    let assetCursor = 0;
    async function pullAsset() {
      while (assetCursor < pendingAssets.length && resourceMap.size <= 450) {
        const assetUrl = pendingAssets[assetCursor++];
        if (resourceMap.has(assetUrl)) continue;
        try {
          const extra = await context.request.get(assetUrl, { timeout: 1200 });
          if (!extra.ok()) continue;
          const buf = Buffer.from(await extra.body());
          const ct = (extra.headers()['content-type'] || 'application/octet-stream').toLowerCase();
          if (!buf.length || buf.length > limits.maxFileMB * 1024 * 1024) continue;
          if (totalSize + buf.length > limits.maxTotalMB * 1024 * 1024) return;
          totalSize += buf.length;
          resourceMap.set(assetUrl, { body: buf, contentType: ct, size: buf.length });
          if (ct.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|avif|ico)(\?|$)/i.test(assetUrl)) {
            const icon = (pageAssets.icons || []).includes(assetUrl) || /\.(svg|ico)(\?|$)/i.test(assetUrl);
            images.push({ url: assetUrl, size: buf.length, contentType: ct.split(';')[0] || 'image', kind: icon ? 'icon' : 'photo' });
          }
        } catch {}
      }
    }
    await Promise.all(Array.from({ length: 4 }, pullAsset));
    note('saving', `${images.length} image${images.length === 1 ? '' : 's'} copied`);

    let renderedCss = '';
    try {
      renderedCss = await page.evaluate(() => {
        const chunks = [];
        for (const sheet of [...document.styleSheets]) {
          try {
            const rules = [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
            if (rules) chunks.push(rules);
          } catch { /* cross-origin sheet; the file itself is saved separately */ }
        }
        return chunks.join('\n\n');
      });
    } catch {}

    const urlToLocal = new Map();
    for (const [orig, data] of resourceMap) {
      const digest = hashShort(data.body);
      if (seenHash.has(digest)) {
        urlToLocal.set(orig, seenHash.get(digest));
        try {
          const parsedUrl = new URL(orig);
          if (parsedUrl.search && !urlToLocal.has(parsedUrl.origin + parsedUrl.pathname)) {
            urlToLocal.set(parsedUrl.origin + parsedUrl.pathname, seenHash.get(digest));
          }
        } catch {}
        continue;
      }
      let ext = '.bin';
      try { ext = path.extname(new URL(orig).pathname).toLowerCase() || ''; } catch {}
      if (!ext || ext.length > 6 || ext === '.bin') {
        const head = data.body.slice(0, 16);
        if (head[0] === 0x89 && head[1] === 0x50) ext = '.png';
        else if (head[0] === 0xff && head[1] === 0xd8) ext = '.jpg';
        else if (head.slice(0, 4).toString() === 'GIF8') ext = '.gif';
        else if (head.slice(0, 4).toString() === 'RIFF' && data.body.slice(8, 12).toString() === 'WEBP') ext = '.webp';
        else if (data.contentType.includes('svg') || data.body.slice(0, 160).toString('utf8').includes('<svg')) ext = '.svg';
        else if (data.contentType.includes('avif')) ext = '.avif';
        else if (data.contentType.includes('webp')) ext = '.webp';
        else if (data.contentType.includes('png')) ext = '.png';
        else if (data.contentType.includes('jpeg')) ext = '.jpg';
      }
      if (!ext || ext.length > 6) {
        if (data.contentType.includes('css')) ext = '.css';
        else if (data.contentType.includes('png')) ext = '.png';
        else if (data.contentType.includes('jpeg') || data.contentType.includes('jpg')) ext = '.jpg';
        else if (data.contentType.includes('svg')) ext = '.svg';
        else if (data.contentType.includes('woff2')) ext = '.woff2';
        else if (data.contentType.includes('woff')) ext = '.woff';
        else if (data.contentType.includes('webp')) ext = '.webp';
        else ext = '.bin';
      }
      let base = 'file';
      try { base = path.basename(new URL(orig).pathname) || 'file'; } catch {}
      const filename = `${sanitizeFilename(base.replace(/\.[^.]+$/, '') || 'file')}-${digest}${ext}`;
      const savedPath = path.join(ASSETS_DIR, filename);
      fs.writeFileSync(savedPath, data.body);
      if (String(data.contentType || '').startsWith('image/')) fitMedium(savedPath);
      const local = `assets/${filename}`;
      seenHash.set(digest, local);
      urlToLocal.set(orig, local);
      try {
        const parsedUrl = new URL(orig);
        if (parsedUrl.search) {
          const bare = parsedUrl.origin + parsedUrl.pathname;
          if (!urlToLocal.has(bare)) urlToLocal.set(bare, local);
        }
      } catch {}
    }

    for (const [orig, data] of resourceMap) {
      if (!data.contentType.includes('css')) continue;
      const local = urlToLocal.get(orig);
      if (!local) continue;
      const rewritten = rewriteCssUrls(data.body.toString('utf8'), urlToLocal, orig, local);
      fs.writeFileSync(path.join(OUT_DIR, local), rewritten);
    }

    if (MODE !== 'clone') {
      const cards = images
        .filter((img) => urlToLocal.get(img.url))
        .map((img) => {
          const local = urlToLocal.get(img.url);
          return `<figure><img src="${local}" alt=""><figcaption>${local}</figcaption></figure>`;
        })
        .join('\n');
      fs.writeFileSync(path.join(OUT_DIR, 'index.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Images</title><style>body{font-family:sans-serif;background:#111;color:#eee}figure{display:inline-block;margin:8px;max-width:240px}img{max-width:240px;height:auto;background:#000}figcaption{font-size:11px;word-break:break-all}</style></head><body><h1>Extracted images</h1>${cards || '<p>No images captured.</p>'}</body></html>`);
    }

    if (MODE === 'clone') {
      await dismissLocation(page);
      const visible = await page.evaluate(() => {
        const medium = (srcset) => {
          let best = '';
          let gap = Infinity;
          for (const part of String(srcset || '').split(',')) {
            const bits = part.trim().split(/\s+/);
            const url = bits[0];
            const width = parseInt((bits[1] || '0').replace(/\D/g, ''), 10) || 0;
            if (!url) continue;
            const next = width ? Math.abs(width - 1000) : 400;
            if (next < gap) { gap = next; best = url; }
          }
          return best;
        };
        const chosen = [];
        document.querySelectorAll('img').forEach((img) => {
          const source = img.parentElement && img.parentElement.querySelector ? img.parentElement.querySelector('source[srcset]') : null;
          const picked = medium(img.getAttribute('srcset') || '') || medium(source && source.getAttribute('srcset') || '') || img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy') || img.getAttribute('data-original') || '';
          if (picked && !picked.startsWith('blob:') && !picked.startsWith('data:')) {
            const sized = picked.replace(/\/(\d+)x(\d+)[a-z]*\.(jpe?g|png|webp)/i, (full, w, h, ext) => (Number(w) > 1000 ? `/800x800bb.${ext}` : full));
            img.setAttribute('src', sized);
            try { chosen.push(new URL(sized, location.href).href); } catch { /* skip */ }
          }
          img.removeAttribute('srcset');
          img.setAttribute('loading', 'eager');
        });
        document.querySelectorAll('source').forEach((el) => el.removeAttribute('srcset'));
        return [...new Set(chosen)].slice(0, 12);
      }).catch(() => []);
      let slot = 0;
      await Promise.all(Array.from({ length: 3 }, async () => {
        while (slot < visible.length) {
          const assetUrl = visible[slot++];
          if (urlToLocal.has(assetUrl) || urlToLocal.has(assetUrl.split('?')[0])) continue;
          try {
            const extra = await context.request.get(assetUrl, { timeout: 1200 });
            if (!extra.ok()) continue;
            const buf = Buffer.from(await extra.body());
            if (buf.length < 40 || buf.length > 4 * 1024 * 1024) continue;
            const digest = hashShort(buf);
            if (seenHash.has(digest)) {
              urlToLocal.set(assetUrl, seenHash.get(digest));
              continue;
            }
            let ext = '';
            try { ext = path.extname(new URL(assetUrl).pathname).toLowerCase(); } catch { ext = ''; }
            if (!ext || ext.length > 5) ext = '.jpg';
            const filename = `pic-${digest}${ext}`;
            const savedPath = path.join(ASSETS_DIR, filename);
            fs.writeFileSync(savedPath, buf);
            if (!/\.svg$/i.test(ext)) fitMedium(savedPath);
            const local = `assets/${filename}`;
            urlToLocal.set(assetUrl, local);
            urlToLocal.set(assetUrl.split('?')[0], local);
            seenHash.set(digest, local);
            images.push({
              url: assetUrl,
              size: fs.statSync(savedPath).size,
              contentType: /\.svg$/i.test(ext) ? 'image/svg+xml' : 'image/jpeg',
              kind: /\.svg$|\.ico$/i.test(ext) ? 'icon' : 'photo',
            });
          } catch { /* one picture can fail */ }
        }
      }));
      let html = await page.content();
      html = postProcessHtml(html);
      html = html.replace(/(src|href)=["']([^"']+)["']/gi, (m, attr, val) => {
        if (val.startsWith('data:') || val.startsWith('#')) return m;
        const decoded = val.replace(/&amp;/gi, '&');
        try {
          const abs = new URL(decoded, sourceUrl).href;
          const bare = abs.split('?')[0];
          const local = urlToLocal.get(abs) || urlToLocal.get(bare);
          return local ? `${attr}="${local}"` : m;
        } catch { return m; }
      });
      html = html.replace(/srcset=["']([^"']+)["']/gi, (m, val) => {
        const next = val.split(',').map((part) => {
          const bits = part.trim().split(/\s+/);
          if (!bits[0]) return '';
          if (!/^https?:/i.test(bits[0]) && !bits[0].startsWith('//')) return bits.join(' ');
          try {
            const abs = new URL(bits[0], sourceUrl).href;
            const bare = abs.split('?')[0];
            const local = urlToLocal.get(abs) || urlToLocal.get(bare);
            if (!local) return '';
            bits[0] = local;
          } catch { return ''; }
          return bits.join(' ');
        }).filter(Boolean).join(', ');
        return next ? `srcset="${next}"` : '';
      });
      html = html.replace(/<script\b[^>]*\ssrc=["']https?:\/\/[^"']+["'][^>]*>\s*<\/script>/gi, (tag) => /google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|onetrust|cookiebot|clarity\.ms|segment\.com/i.test(tag) ? '' : tag);
      if (renderedCss && renderedCss.length < 1500000) {
        const localCss = rewriteCssUrls(renderedCss, urlToLocal, sourceUrl, 'assets/rendered.css');
        fs.writeFileSync(path.join(ASSETS_DIR, 'rendered.css'), localCss);
        html = html.replace(/<\/head>/i, '<link rel="stylesheet" href="assets/rendered.css"></head>');
      }
      html = html.replace(/url\((['"]?)([^'")]+)\1\)/gi, (m, q, val) => {
        try {
          const abs = new URL(val, sourceUrl).href;
          if (urlToLocal.has(abs)) return `url(${urlToLocal.get(abs)})`;
        } catch {}
        return m;
      });
      fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html);
    }

    const outline = await page.evaluate(() => {
      const pick = (el) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        let selector = el.tagName.toLowerCase();
        if (el.id) selector = `#${el.id}`;
        else if (el.className && typeof el.className === 'string') {
          const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
          if (cls) selector = `${el.tagName.toLowerCase()}.${cls}`;
        }
        return {
          selector,
          snippet: (el.innerText || '').trim().slice(0, 80),
          styles: {
            backgroundColor: cs.backgroundColor,
            color: cs.color,
            font: cs.fontFamily,
          },
        };
      };
      const sections = [];
      for (const sel of ['header', 'nav', 'main', 'footer']) {
        const el = document.querySelector(sel);
        if (el) sections.push(pick(el));
      }
      document.querySelectorAll('section, [role="main"], .hero, #hero').forEach((el, i) => {
        if (i < 8) sections.push(pick(el));
      });
      return { sections: sections.filter(Boolean) };
    });
    fs.writeFileSync(path.join(OUT_DIR, 'outline.json'), JSON.stringify(outline, null, 2));

    if (OPTIONS.productShots) {
      note('saving', 'Saving the first two pictures from each product');
      try {
        const shots = await collectProductShots(page, context, sourceUrl, images.map((img) => img.url));
        images.push(...shots);
      } catch (err) {
        warnings.push(err.message || 'Product pictures were not all saved.');
      }
    }

    const keepSmall = OPTIONS.showSmallImages === true;
    const listed = images
      .map((img) => {
        const local = img.local || urlToLocal.get(img.url) || null;
        let size = img.size;
        if (local) {
          try { size = fs.statSync(path.join(OUT_DIR, local)).size; } catch { /* keep the downloaded size */ }
        }
        const kind = img.kind || (/\.svg$|\.ico$/i.test(local || img.url || '') || String(img.contentType || '').includes('svg') ? 'icon' : 'photo');
        return { ...img, local, size, kind, small: kind !== 'product' && kind !== 'icon' && size < 400 };
      })
      .filter((img) => img.local && (keepSmall || !img.small));

    const manifest = {
      url: sourceUrl,
      mode: MODE,
      timestamp: new Date().toISOString(),
      imageCount: listed.length,
      totalMB: +(totalSize / 1024 / 1024).toFixed(2),
      warnings,
      pages: extraPages,
      elapsedMs: Date.now() - started,
      images: listed.slice(0, 400),
    };
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    note('packaging', 'The page is saved. Packing the download.');

    await browser.close();
    await finalize(manifest);
    clearTimeout(watchdog);
  } catch (err) {
    try { await browser.close(); } catch {}
    await fail(err.message || 'Capture failed');
  }
}

async function uploadSite() {
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_BUCKET) {
    if (process.env.GITHUB_ACTIONS) throw new Error('R2 is not configured on the capture runner.');
    return;
  }
  const walk = async (dir, prefix) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (fs.statSync(abs).isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      const buf = fs.readFileSync(abs);
      if (buf.length > (limits.maxFileMB || 25) * 1024 * 1024) continue;
      await uploadToR2(`sites/${JOB_ID}/${rel}`, buf, contentType(abs));
    }
  };
  await walk(OUT_DIR, '');
}

async function wasStopped() {
  const client = r2Client();
  if (!client) return false;
  try {
    const got = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: `sites/${JOB_ID}/job.json` }));
    const current = JSON.parse(await got.Body.transformToString());
    return current.status === 'failed' && /stopped/i.test(String(current.error || ''));
  } catch (err) {
    const missing = err?.name === 'NoSuchKey' || err?.Code === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404;
    return missing;
  }
}

async function finalize(manifest) {
  if (await wasStopped()) {
    console.log(`Stopped job ${JOB_ID} before packaging.`);
    process.exit(0);
  }
  const stats = { images: manifest.imageCount, totalMB: manifest.totalMB, warnings: manifest.warnings };
  await supabasePatch({
    status: 'done',
    error: null,
    stats,
    finished_at: new Date().toISOString(),
  });
  const fullZip = path.join(ZIP_DIR, `${JOB_ID}.zip`);
  const imgZip = path.join(ZIP_DIR, `${JOB_ID}-images.zip`);
  try {
    await createZip(OUT_DIR, fullZip);
    await createZip(OUT_DIR, imgZip, (name) => /\.(png|jpe?g|gif|webp|svg|ico|avif|bmp)$/i.test(name));
    if (fs.existsSync(fullZip)) await uploadToR2(`sites/${JOB_ID}/full.zip`, fs.readFileSync(fullZip), 'application/zip');
    if (fs.existsSync(imgZip)) await uploadToR2(`sites/${JOB_ID}/images.zip`, fs.readFileSync(imgZip), 'application/zip');
    await uploadSite();
  } catch (err) {
    if (process.env.GITHUB_ACTIONS) {
      await fail(err.message || 'The page was captured but could not be stored.');
      return;
    }
    console.error('Storage upload failed', err.message || err);
  }
  console.log(`Done job ${JOB_ID}: ${manifest.imageCount} images, ${manifest.totalMB} MB`);
  process.exit(0);
}

main().catch((err) => fail(err.message || String(err)));
