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

function pickSrcset(srcset) {
  if (!srcset) return '';
  let best = '', bestW = 0;
  for (const part of srcset.split(',')) {
    const bits = part.trim().split(/\s+/);
    const url = bits[0];
    const w = parseInt((bits[1] || '0').replace(/\D/g, ''), 10) || 0;
    if (w >= bestW) { bestW = w; best = url; }
  }
  return best || srcset.split(',')[0].trim().split(/\s+/)[0];
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

async function processUpload() {
  const src = OPTIONS.uploadPath;
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

  page.on('response', async (response) => {
    try {
      const url = response.url();
      const ct = (response.headers()['content-type'] || '').toLowerCase();
      const pathName = (() => { try { return new URL(url).pathname; } catch { return url; } })();
      const isImage = ct.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|avif|ico)(\?|$)/i.test(pathName);
      const isScript = ct.includes('javascript') || ct.includes('ecmascript') || /\.(js|mjs)(\?|$)/i.test(pathName);
      const isAsset = isImage || isScript || ct.includes('css') || ct.includes('font') || ct.includes('woff') || /\.(css|woff2?|ttf)(\?|$)/i.test(pathName);
      if (!isAsset) return;
      if (MODE === 'images' && !isImage) return;
      let buf = await response.body().catch(() => null);
      if (!buf || !buf.length) return;

      if (url.includes('/_next/image')) {
        try {
          const orig = new URL(url).searchParams.get('url');
          if (orig) {
            const decoded = decodeURIComponent(orig);
            const abs = new URL(decoded, sourceUrl).href;
            const extra = await context.request.get(abs);
            const extraBuf = Buffer.from(await extra.body());
            if (extraBuf.length) buf = extraBuf;
          }
        } catch {}
      }

      if (buf.length > limits.maxFileMB * 1024 * 1024) return;
      if (totalSize + buf.length > limits.maxTotalMB * 1024 * 1024) return;
      totalSize += buf.length;
      resourceMap.set(url, { body: buf, contentType: ct, size: buf.length });
      if (isImage) images.push({ url, size: buf.length, contentType: (ct.split(';')[0] || 'image') });
    } catch {}
  });

  try {
    let nav;
    let navError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        nav = await page.goto(sourceUrl, { waitUntil: 'commit', timeout: 20000 });
        navError = null;
        break;
      } catch (err) {
        navError = err;
        await page.goto('about:blank', { timeout: 5000 }).catch(() => {});
      }
    }
    if (navError) {
      const res = await fetch(sourceUrl, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw navError;
      let html = await res.text();
      const base = res.url || sourceUrl;
      if (!/<base\s/i.test(html)) {
        if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (tag) => `${tag}<base href="${base}">`);
        else html = `<head><base href="${base}"></head>${html}`;
      }
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 });
      warnings.push('The browser stalled, so the page was loaded from a direct download.');
      nav = null;
    }
    await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    note('reading', 'Waiting for styles, fonts, and pictures');
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(900);

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
      for (let attempt = 0; attempt < 3 && wall === 'check'; attempt++) {
        await page.waitForTimeout(5000);
        wall = await wallKind();
      }
    }

    const status = nav?.status?.() || 0;
    const textLen = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, '').length);
    if (wall === 'denied' || ((status === 403 || status === 429 || wall === 'check') && textLen < 80)) {
      await browser.close();
      await fail('This site refused the scanner with Access Denied. Open it in your own browser, save the page, and drop that file in the chat.', 'blocked');
    }

    for (const sel of ['#onetrust-accept-btn-handler', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '.cc-allow', '.cc-btn.cc-allow', '[aria-label*="accept" i]']) {
      try {
        await page.locator(sel).first().click({ timeout: 500 });
        break;
      } catch {}
    }
    for (const text of ['Accept all', 'Accept', 'Agree', 'Allow all', 'Got it', 'I agree', 'OK']) {
      try {
        await page.getByRole('button', { name: new RegExp(`^${text}$`, 'i') }).first().click({ timeout: 700 });
        break;
      } catch {}
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

    note('scrolling', 'Loading images that appear further down the page');
    let lastH = 0;
    const scrollBudget = Math.min(limits.maxScrollSteps || 20, 18);
    for (let i = 0; i < scrollBudget; i++) {
      const h = await page.evaluate(() => document.body?.scrollHeight || document.documentElement?.scrollHeight || 0).catch(() => 0);
      if (!h || h === lastH) break;
      lastH = h;
      await page.evaluate(() => {
        const el = document.scrollingElement || document.documentElement;
        if (el) el.scrollBy(0, window.innerHeight * 0.85);
      }).catch(() => {});
      await page.waitForTimeout(160);
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.evaluate(async () => {
      const imgs = [...document.images].filter((img) => !img.complete).slice(0, 30);
      await Promise.all(imgs.map((img) => new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 2500);
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

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: path.join(SHOTS_DIR, 'desktop.png'), fullPage: true, timeout: 8000 }).catch(async () => {
      await page.screenshot({ path: path.join(SHOTS_DIR, 'desktop.png'), fullPage: false, timeout: 5000 }).catch(() => {});
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(SHOTS_DIR, 'mobile.png'), fullPage: false, timeout: 8000 }).catch(() => {});
    await page.setViewportSize(viewport);
    note('saving', 'Copying styles, fonts, and images onto this computer');

    const pageAssets = await page.evaluate(() => {
      const found = [];
      const add = (value) => {
        if (!value || value.startsWith('data:') || value.startsWith('blob:') || value.startsWith('#')) return;
        try { found.push(new URL(value, location.href).href); } catch {}
      };
      document.querySelectorAll('img, source, video, link[rel~="stylesheet"], link[rel~="icon"]').forEach((el) => {
        add(el.getAttribute('src'));
        add(el.getAttribute('poster'));
        add(el.getAttribute('href'));
        const set = el.getAttribute('srcset') || '';
        set.split(',').forEach((part) => add(part.trim().split(/\s+/)[0]));
      });
      document.querySelectorAll('[style]').forEach((el) => {
        const style = el.getAttribute('style') || '';
        const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
        let match;
        while ((match = re.exec(style))) add(match[2]);
      });
      return found.slice(0, 180);
    }).catch(() => []);

    const pendingAssets = pageAssets.filter((assetUrl) => !resourceMap.has(assetUrl)).slice(0, 180);
    let assetCursor = 0;
    async function pullAsset() {
      while (assetCursor < pendingAssets.length && resourceMap.size <= 450) {
        const assetUrl = pendingAssets[assetCursor++];
        if (resourceMap.has(assetUrl)) continue;
        try {
          const extra = await context.request.get(assetUrl, { timeout: 10000 });
          if (!extra.ok()) continue;
          const buf = Buffer.from(await extra.body());
          const ct = (extra.headers()['content-type'] || 'application/octet-stream').toLowerCase();
          if (!buf.length || buf.length > limits.maxFileMB * 1024 * 1024) continue;
          if (totalSize + buf.length > limits.maxTotalMB * 1024 * 1024) return;
          totalSize += buf.length;
          resourceMap.set(assetUrl, { body: buf, contentType: ct, size: buf.length });
          if (ct.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|avif|ico)$/i.test(assetUrl)) {
            images.push({ url: assetUrl, size: buf.length, contentType: ct.split(';')[0] || 'image' });
          }
        } catch {}
      }
    }
    await Promise.all(Array.from({ length: 6 }, pullAsset));

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
      fs.writeFileSync(path.join(ASSETS_DIR, filename), data.body);
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
      await page.evaluate(() => {
        document.querySelectorAll('img').forEach((img) => {
          const current = img.currentSrc || img.getAttribute('src') || '';
          if (current && !current.startsWith('blob:') && !current.startsWith('data:')) img.setAttribute('src', current);
          img.removeAttribute('srcset');
          img.setAttribute('loading', 'eager');
        });
        document.querySelectorAll('source').forEach((el) => el.removeAttribute('srcset'));
      }).catch(() => {});
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
      html = html.replace(/<script\b[^>]*\ssrc=["']https?:\/\/[^"']+["'][^>]*>\s*<\/script>/gi, '');
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

    const keepSmall = OPTIONS.showSmallImages === true;
    const listed = images
      .filter((img) => keepSmall || img.size >= 1500)
      .map((img) => ({
        ...img,
        local: urlToLocal.get(img.url) || null,
        small: img.size < 1500,
      }));

    const manifest = {
      url: sourceUrl,
      mode: MODE,
      timestamp: new Date().toISOString(),
      imageCount: listed.length,
      totalMB: +(totalSize / 1024 / 1024).toFixed(2),
      warnings,
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

async function finalize(manifest) {
  const stats = { images: manifest.imageCount, totalMB: manifest.totalMB, warnings: manifest.warnings };
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
  await supabasePatch({
    status: 'done',
    error: null,
    stats,
    finished_at: new Date().toISOString(),
  });
  console.log(`Done job ${JOB_ID}: ${manifest.imageCount} images, ${manifest.totalMB} MB`);
  process.exit(0);
}

main().catch((err) => fail(err.message || String(err)));
