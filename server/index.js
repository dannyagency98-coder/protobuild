const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const env = require('./env');
const jobs = require('./jobs');
const { assertPublicHttpUrl } = require('./url-safety');
const { parseCapturePrompt } = require('./prompt-parse');
const { validateCss, cssFromInstruction } = require('./css-safe');
const { runTurn } = require('./turn');

const { localizeHtml, localizeCss, FIX_SCRIPT } = require('./preview-fix');

const appDir = path.join(env.root, 'app');
const outRoot = path.join(env.root, 'out');
const zipDir = path.join(outRoot, 'zips');
const uploadDir = path.join(env.root, 'data', 'uploads');
const running = new Map();
const dropped = new Set();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.zip': 'application/zip',
};

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });
}

function originOf(req) {
  const host = req.headers.host || `127.0.0.1:${env.port}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${host}`;
}

function shareDays() {
  return Number(env.limits.previewTTLDays) || 30;
}

function pageText(job) {
  const htmlPath = path.join(siteDir(job.id), 'index.html');
  if (!fs.existsSync(htmlPath)) return '';
  return fs.readFileSync(htmlPath, 'utf8')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pageShot(job) {
  const file = path.join(siteDir(job.id), 'screenshots', 'desktop.png');
  if (!fs.existsSync(file)) return '';
  if (fs.statSync(file).size > 500000) return '';
  return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
}

function editsFile(jobId) {
  return path.join(siteDir(jobId), 'edits.json');
}

function readEdits(jobId) {
  try { return JSON.parse(fs.readFileSync(editsFile(jobId), 'utf8')); }
  catch { return []; }
}

function writeEdits(jobId, rows) {
  fs.writeFileSync(editsFile(jobId), JSON.stringify(rows, null, 2));
}

function pageContext(job) {
  const text = pageText(job).slice(0, 10000);
  const htmlPath = path.join(siteDir(job.id), 'index.html');
  let style = '';
  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    style = [...html.matchAll(/<style[\s\S]*?<\/style>/gi)]
      .map((match) => match[0].replace(/<\/?style[^>]*>/gi, ''))
      .join('\n')
      .slice(0, 4000);
  }
  const cssPath = path.join(siteDir(job.id), 'custom.css');
  const custom = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8').slice(0, 2000) : '';
  return [text, style && `Page CSS:\n${style}`, custom && `Custom CSS:\n${custom}`].filter(Boolean).join('\n\n');
}

function readCaptured(job, query) {
  const text = pageText(job);
  if (!text) return { error: 'The captured page is not on disk.' };
  const q = String(query || '').trim().toLowerCase();
  const cssPath = path.join(siteDir(job.id), 'custom.css');
  const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8').slice(0, 2000) : '';
  if (!q) return { excerpt: text.slice(0, 14000), length: text.length, css };
  const lower = text.toLowerCase();
  const matches = [];
  let from = 0;
  while (matches.length < 8) {
    const at = lower.indexOf(q, from);
    if (at < 0) break;
    matches.push(text.slice(Math.max(0, at - 140), at + q.length + 220));
    from = at + q.length;
  }
  return { query: q, matches, excerpt: text.slice(0, 2000), css };
}

function proposeCss(job, css) {
  const checked = validateCss(String(css || ''));
  if (!checked.ok) return { error: checked.error || 'That CSS is not allowed.' };
  const cssPath = path.join(siteDir(job.id), 'custom.css');
  const before = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8').trim().slice(-800) : '';
  return {
    proposal: {
      kind: 'css',
      jobId: job.id,
      before: before || '(no custom CSS yet)',
      after: checked.css,
      css: checked.css,
    },
  };
}

function proposeHtml(job, find, replace) {
  const findText = String(find || '');
  const next = String(replace || '');
  if (!findText || findText.length > 2000) return { error: 'The find string has to be a short exact snippet from the page.' };
  if (next.length > 8000) return { error: 'That replacement is too long.' };
  if (/<script|javascript:|onerror\s*=|onload\s*=/i.test(next)) return { error: 'Script is not allowed in the replacement.' };
  const htmlPath = path.join(siteDir(job.id), 'index.html');
  if (!fs.existsSync(htmlPath)) return { error: 'The captured HTML is not on disk.' };
  const html = fs.readFileSync(htmlPath, 'utf8');
  if (!html.includes(findText)) return { error: 'That exact text is not in the captured HTML. Read the page and copy a shorter exact string.' };
  return { proposal: { kind: 'html', jobId: job.id, before: findText, after: next, find: findText, replace: next } };
}

function applyProposal(job, body) {
  if (body.kind === 'css') {
    const checked = validateCss(String(body.css || ''));
    if (!checked.ok) {
      const error = new Error(checked.error || 'That CSS is not allowed.');
      error.status = 400;
      throw error;
    }
    const cssPath = path.join(siteDir(job.id), 'custom.css');
    const prev = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8').trim() : '';
    fs.writeFileSync(cssPath, prev ? `${prev}\n\n${checked.css}` : checked.css);
    const rows = readEdits(job.id);
    rows.push({ type: 'css', css: checked.css });
    writeEdits(job.id, rows);
    return;
  }
  if (body.kind === 'html' && body.html && !body.find) {
    const next = String(body.html);
    if (/<script|javascript:|onerror\s*=|onload\s*=/i.test(next)) {
      const error = new Error('Script is not allowed.');
      error.status = 400;
      throw error;
    }
    const htmlPath = path.join(siteDir(job.id), 'index.html');
    const before = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
    fs.writeFileSync(htmlPath, next);
    const rows = readEdits(job.id);
    rows.push({ type: 'snapshot', before });
    writeEdits(job.id, rows.slice(-8));
    return;
  }
  if (body.kind === 'html') {
    const findText = String(body.find || '');
    const next = String(body.replace || '');
    if (/<script|javascript:|onerror\s*=|onload\s*=/i.test(next)) {
      const error = new Error('Script is not allowed.');
      error.status = 400;
      throw error;
    }
    const htmlPath = path.join(siteDir(job.id), 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    if (!findText || !html.includes(findText)) {
      const error = new Error('That text is no longer in the page.');
      error.status = 400;
      throw error;
    }
    fs.writeFileSync(htmlPath, html.replace(findText, next));
    const rows = readEdits(job.id);
    rows.push({ type: 'html', find: findText, replace: next });
    writeEdits(job.id, rows);
    return;
  }
  const error = new Error('Nothing to apply.');
  error.status = 400;
  throw error;
}

function undoOne(job) {
  const rows = readEdits(job.id);
  const last = rows.pop();
  if (!last) return { ok: false, error: 'There is no edit to undo.' };
  if (last.type === 'css') {
    const cssPath = path.join(siteDir(job.id), 'custom.css');
    if (fs.existsSync(cssPath)) {
      const css = fs.readFileSync(cssPath, 'utf8');
      const at = css.lastIndexOf(last.css);
      const next = at >= 0 ? `${css.slice(0, at)}${css.slice(at + last.css.length)}`.replace(/\n{3,}/g, '\n\n').trim() : css.trim();
      if (next) fs.writeFileSync(cssPath, `${next}\n`);
      else fs.unlinkSync(cssPath);
    }
  } else if (last.type === 'snapshot') {
    const htmlPath = path.join(siteDir(job.id), 'index.html');
    fs.writeFileSync(htmlPath, last.before || '');
  } else if (last.type === 'html') {
    const htmlPath = path.join(siteDir(job.id), 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    if (!html.includes(last.replace)) return { ok: false, error: 'The last HTML edit is no longer in the page, so it was left as it is.' };
    fs.writeFileSync(htmlPath, html.replace(last.replace, last.find));
  }
  writeEdits(job.id, rows);
  return { ok: true };
}

function resetAll(job) {
  const rows = readEdits(job.id);
  for (const last of [...rows].reverse()) {
    if (last.type === 'snapshot') {
      const htmlPath = path.join(siteDir(job.id), 'index.html');
      if (last.before) fs.writeFileSync(htmlPath, last.before);
      continue;
    }
    if (last.type !== 'html') continue;
    const htmlPath = path.join(siteDir(job.id), 'index.html');
    if (!fs.existsSync(htmlPath)) break;
    const html = fs.readFileSync(htmlPath, 'utf8');
    if (html.includes(last.replace)) fs.writeFileSync(htmlPath, html.replace(last.replace, last.find));
  }
  const cssPath = path.join(siteDir(job.id), 'custom.css');
  if (fs.existsSync(cssPath)) fs.unlinkSync(cssPath);
  const file = editsFile(job.id);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function startSse(res) {
  res.socket?.setNoDelay?.(true);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  return (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('File too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function currentUser() {
  return { id: 'local-user', email: 'local' };
}

function siteDir(jobId) {
  return path.join(outRoot, jobId);
}

function safeJobId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''));
}

function stopCapture(id) {
  dropped.add(id);
  const child = running.get(id);
  if (!child) return;
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 800);
  running.delete(id);
}

async function markStopped(id) {
  stopCapture(id);
  return jobs.updateJob(id, {
    status: 'failed',
    error: 'Stopped.',
    finished_at: new Date().toISOString(),
  });
}

function eraseJobFiles(job) {
  const id = typeof job === 'string' ? job : job?.id;
  if (!safeJobId(id)) return;
  stopCapture(id);
  fs.rmSync(siteDir(id), { recursive: true, force: true });
  for (const name of [`${id}.zip`, `${id}-images.zip`]) {
    fs.rmSync(path.join(zipDir, name), { force: true });
  }
  for (const ext of ['.html', '.htm', '.zip']) {
    fs.rmSync(path.join(uploadDir, `${id}${ext}`), { force: true });
  }
  const uploadPath = job?.options?.uploadPath;
  if (uploadPath && path.resolve(uploadPath).startsWith(path.resolve(uploadDir) + path.sep)) {
    fs.rmSync(uploadPath, { force: true });
  }
}

function injectHtml(html, { share = false, hasCustom = false, root = '' } = {}) {
  if (root) html = localizeHtml(html, root);
  html = html.replace(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/gi, '');
  html = html.replace(/<script\b(?![^>]*\bdata-proto-)[\s\S]*?<\/script>/gi, '');
  if (!html.includes('data-proto-stay')) {
    const stay = '<script data-proto-stay="1">(function(){function foreign(url){try{return new URL(url,location.href).origin!==location.origin}catch(e){return true}}var pick=false;window.addEventListener("message",function(e){if(!e.data||e.data.type!=="pb-pick")return;pick=!!e.data.on;document.documentElement.style.cursor=pick?"crosshair":""});document.addEventListener("click",function(e){if(pick){e.preventDefault();e.stopPropagation();var el=e.target;if(!el||!el.tagName)return;var cls=typeof el.className==="string"?el.className.trim().split(/\\s+/).filter(Boolean).slice(0,2).join("."):"";var sel=el.id?"#"+el.id:el.tagName.toLowerCase()+(cls?"."+cls:"");var text=(el.innerText||el.getAttribute("alt")||"").replace(/\\s+/g," ").trim().slice(0,180);parent.postMessage({type:"pb-picked",selector:sel,text:text},"*");return}var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(a&&foreign(a.getAttribute("href"))){e.preventDefault();e.stopPropagation()}},true)})();</script>';
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (open) => `${open}${stay}`) : `<head>${stay}</head>${html}`;
  }
  if (hasCustom && !html.includes('custom.css')) {
    html = html.replace(/<\/head>/i, '<link rel="stylesheet" href="custom.css"></head>');
  }
  if (share && !html.includes('Reference prototype')) {
    html = html.replace(/<body([^>]*)>/i, '<body$1><div style="position:fixed;top:0;left:0;right:0;background:#111;color:#f3efe4;padding:6px 10px;font:12px/1.4 ui-sans-serif,system-ui;z-index:99999;text-align:center">Reference prototype, not the original website</div>');
  }
  if (!html.includes('data-proto-fix')) {
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${FIX_SCRIPT}</body>`) : html + FIX_SCRIPT;
  }
  return html;
}

function serveSite(req, res, jobId, urlPath, { share = false } = {}) {
  const root = siteDir(jobId);
  let rel = decodeURIComponent(urlPath || '/');
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(root, rel));
  if (!filePath.startsWith(root)) return send(res, 403, 'Forbidden');
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const idx = path.join(filePath, 'index.html');
    if (fs.existsSync(idx)) return serveFile(res, idx, { htmlRewriter: true, share, hasCustom: fs.existsSync(path.join(root, 'custom.css')), root });
    return send(res, 404, 'Not found');
  }
  const ext = path.extname(filePath).toLowerCase();
  return serveFile(res, filePath, {
    htmlRewriter: ext === '.html',
    share,
    hasCustom: fs.existsSync(path.join(root, 'custom.css')),
    root,
  });
}

function sniffType(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(32);
    fs.readSync(fd, buf, 0, 32, 0);
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf.slice(0, 4).toString() === 'GIF8') return 'image/gif';
    if (buf[0] === 0xff && buf[1] === 0x0a) return 'image/jxl';
    if (buf.slice(4, 8).toString('ascii') === 'JXL ') return 'image/jxl';
    if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
    const brand = buf.slice(4, 16).toString('ascii');
    if (brand.includes('ftyp') && /avif|avis/.test(buf.slice(8, 28).toString('ascii'))) return 'image/avif';
    const start = buf.toString('utf8').trimStart();
    if (start.startsWith('<svg') || (start.startsWith('<?xml') && start.includes('<svg'))) return 'image/svg+xml';
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

const VIEWABLE_IMAGE = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/bmp',
]);

function viewableImage(filePath, declared, local) {
  const declaredType = String(declared || '').toLowerCase().split(';')[0].trim();
  if (declaredType === 'image/jxl' || declaredType === 'image/jpeg-xl') return null;
  const sniffed = sniffType(filePath);
  if (sniffed === 'image/jxl') return null;
  const type = sniffed || declaredType;
  if (VIEWABLE_IMAGE.has(type)) return type;
  if (/\.(png|jpe?g|gif|webp|svg|ico|avif|bmp)$/i.test(local) && type.startsWith('image/') && type !== 'image/jxl') return type;
  return null;
}

function serveFile(res, filePath, { htmlRewriter = false, share = false, hasCustom = false, root = '' } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const sniffed = sniffType(filePath);
  const headers = {
    'Content-Type': (sniffed && sniffed.startsWith('image/')) ? sniffed : (MIME[ext] || 'application/octet-stream'),
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self' 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'",
    'Cache-Control': 'no-store',
  };
  if (htmlRewriter) {
    let html = fs.readFileSync(filePath, 'utf8');
    html = injectHtml(html, { share, hasCustom, root });
    return send(res, 200, html, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
  }
  if (ext === '.css' && root) {
    const css = localizeCss(fs.readFileSync(filePath, 'utf8'), root);
    return send(res, 200, css, { ...headers, 'Content-Type': 'text/css; charset=utf-8' });
  }
  const stream = fs.createReadStream(filePath);
  res.writeHead(200, headers);
  stream.pipe(res);
}

function isZipImage(filePath, name) {
  if (/\.(png|jpe?g|gif|webp|svg|ico|avif|bmp)$/i.test(name)) return true;
  const sniffed = sniffType(filePath);
  return !!(sniffed && sniffed.startsWith('image/') && sniffed !== 'image/jxl');
}

function downloadName(job, type) {
  let host = '';
  try {
    if (job?.source_url) host = new URL(job.source_url).hostname;
  } catch { host = ''; }
  host = String(host || 'page').replace(/^www\./i, '').toLowerCase();
  host = host.replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'page';
  return type === 'images' ? `${host}-images.zip` : `${host}.zip`;
}

function buildZip(jobId, type) {
  const root = siteDir(jobId);
  if (!fs.existsSync(root)) return Promise.reject(new Error('missing'));
  const zipPath = path.join(zipDir, type === 'images' ? `${jobId}-images.zip` : `${jobId}.zip`);
  const archiver = require(path.join(env.root, 'capture/node_modules/archiver'));
  return new Promise((resolve, reject) => {
    fs.mkdirSync(zipDir, { recursive: true });
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', () => resolve(zipPath));
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    const skip = new Set(['status.json', 'result.json', '_upload']);
    const walk = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        if (type === 'images' && entry.name === 'screenshots') continue;
        const full = path.join(dir, entry.name);
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(full, name);
        else if (type !== 'images' || isZipImage(full, entry.name)) archive.file(full, { name });
      }
    };
    walk(root, '');
    archive.finalize();
  });
}

function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(appDir, rel));
  if (!filePath.startsWith(appDir)) return send(res, 403, 'Forbidden');
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return send(res, 404, 'Not found');
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(filePath).pipe(res);
}

let captureQueue = Promise.resolve();

function startCapture(job) {
  if (running.has(job.id)) return;
  captureQueue = captureQueue.then(() => launchCapture(job)).catch((err) => {
    console.error('Capture queue error', err.message);
  });
}

function launchCapture(job) {
  if (dropped.has(job.id) || running.has(job.id)) return Promise.resolve();
  return new Promise((resolve) => {
  const envVars = {
    ...process.env,
    JOB_ID: job.id,
    MODE: job.mode,
    URL: job.source_url || '',
    OPTIONS: JSON.stringify(job.options || {}),
    OUT_ROOT: outRoot,
    SUPABASE_URL: env.supabaseUrl,
    SUPABASE_SERVICE_KEY: env.supabaseServiceKey,
  };
  const child = spawn(process.execPath, [path.join(env.root, 'capture', 'capture.js')], {
    cwd: path.join(env.root, 'capture'),
    env: envVars,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.set(job.id, child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; process.stdout.write(`[${job.id}] ${d}`); });
  child.stderr.on('data', (d) => { log += d; process.stderr.write(`[${job.id}] ${d}`); });
  const killer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
  }, (env.limits.timeoutSec + 30) * 1000);
  child.on('exit', async (code) => {
    clearTimeout(killer);
    running.delete(job.id);
    resolve();
    if (dropped.has(job.id)) return;
    const resultPath = path.join(siteDir(job.id), 'result.json');
    if (fs.existsSync(resultPath)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        if (result.status && result.status !== 'running' && result.status !== 'queued') {
          await jobs.updateJob(job.id, {
            status: result.status,
            error: result.error || null,
            stats: result.stats || {},
            finished_at: result.finished_at || new Date().toISOString(),
          });
          return;
        }
      } catch (err) {
        console.error('Could not read capture result', err.message);
      }
    }
    const current = await jobs.getJob(job.id);
    if (current && (current.status === 'queued' || current.status === 'running')) {
      const msg = code === 2
        ? 'This site blocks automated tools. Save the page in your browser and use Upload mode.'
        : (log.trim().split('\n').pop() || 'Capture failed');
      await jobs.updateJob(job.id, {
        status: code === 2 ? 'blocked' : 'failed',
        error: msg.slice(0, 400),
        finished_at: new Date().toISOString(),
      });
    }
  });
  });
}

async function dispatchGithub(job) {
  if (!env.githubToken || !env.githubRepo) return false;
  const res = await fetch(`https://api.github.com/repos/${env.githubRepo}/actions/workflows/${env.githubWorkflow}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      ref: 'main',
      inputs: {
        job_id: job.id,
        mode: job.mode,
        url: job.source_url || '',
        options: JSON.stringify(job.options || {}),
      },
    }),
  });
  return res.status === 204;
}

async function createCapture(user, { url: rawUrl, mode, prompt, rights, capture }) {
  if (!rights) {
    const error = new Error('Rights confirmation required');
    error.status = 400;
    throw error;
  }
  const href = await assertPublicHttpUrl(rawUrl);
  const parsed = parseCapturePrompt(prompt, mode);
  parsed.mode = capture?.mode === 'images' || mode === 'images' ? 'images' : 'clone';
  if (capture?.viewport === 'mobile' || capture?.viewport === 'desktop') parsed.viewport = capture.viewport;
  if (capture?.scroll === 'footer' && !(parsed.actions || []).some((action) => action.type === 'scroll')) {
    parsed.actions = parsed.actions || [];
    parsed.actions.push({ type: 'scroll', to: 'footer' });
  }
  const job = await jobs.createJob({
    user_id: user.id,
    source_url: href,
    mode: parsed.mode,
    options: parsed,
    rights_confirmed: true,
  });
  const dispatched = await dispatchGithub(job);
  if (!dispatched) startCapture(job);
  return job;
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, { limits: env.limits });
  }

  const parts = url.pathname.split('/').filter(Boolean);
  const user = currentUser();

  if (req.method === 'POST' && url.pathname === '/api/jobs') {
    const body = JSON.parse((await readBody(req, 200000)).toString('utf8') || '{}');
    try {
      const job = await createCapture(user, {
        url: body.url,
        mode: body.mode === 'images' ? 'images' : 'clone',
        prompt: body.prompt,
        rights: !!body.rights_confirmed,
      });
      return sendJson(res, 200, jobs.publicJob(job, originOf(req)));
    } catch (err) {
      return sendJson(res, err.status || 400, { error: err.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/agent') {
    const body = JSON.parse((await readBody(req, 8000000)).toString('utf8') || '{}');
    const origin = originOf(req);
    const active = body.activeJobId ? await jobs.getJob(body.activeJobId, user.id) : null;
    const started = [];
    let clientGone = false;
    const onGone = () => {
      if (res.writableEnded) return;
      clientGone = true;
      for (const id of started) markStopped(id).catch(() => {});
    };
    res.on('close', onGone);
    const send = startSse(res);
    let result;
    try {
      result = await runTurn({
        message: body.message,
        purpose: body.purpose,
        history: body.history,
        images: body.images,
        activeJob: active,
        onEvent: (event) => {
          if (event.type === 'token') send('token', { text: event.text });
          else if (event.type === 'meta') send('meta', { model: event.model, note: event.note, quotaReset: event.quotaReset });
        },
        deps: {
          scan: async (target, mode, prompt) => {
            if (clientGone) {
              const error = new Error('Stopped.');
              error.status = 499;
              throw error;
            }
            const job = await createCapture(user, { url: target, mode, prompt, rights: true });
            started.push(job.id);
            if (clientGone) {
              await markStopped(job.id);
              const error = new Error('Stopped.');
              error.status = 499;
              throw error;
            }
            return jobs.publicJob(job, origin);
          },
          readHtml: (job) => {
            const htmlPath = path.join(siteDir(job.id), 'index.html');
            if (!fs.existsSync(htmlPath)) return '';
            return fs.readFileSync(htmlPath, 'utf8');
          },
          writeHtml: async (job, html) => {
            const htmlPath = path.join(siteDir(job.id), 'index.html');
            const before = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
            fs.writeFileSync(htmlPath, html);
            const rows = readEdits(job.id);
            rows.push({ type: 'snapshot', before });
            writeEdits(job.id, rows.slice(-8));
          },
          logoSrc: (job) => {
            const assets = path.join(siteDir(job.id), 'assets');
            if (!fs.existsSync(assets)) return '';
            const file = fs.readdirSync(assets).find((name) => /^brand-logo\./i.test(name));
            return file ? `assets/${file}` : '';
          },
          outline: (job) => {
            const outlinePath = path.join(siteDir(job.id), 'outline.json');
            if (!fs.existsSync(outlinePath)) return { sections: [] };
            try { return JSON.parse(fs.readFileSync(outlinePath, 'utf8')); }
            catch { return { sections: [] }; }
          },
          writeCss: async (job, css) => {
            const checked = validateCss(css);
            if (!checked.ok) {
              const error = new Error(checked.error || 'That change is not allowed.');
              error.status = 400;
              throw error;
            }
            const cssPath = path.join(siteDir(job.id), 'custom.css');
            const prev = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8').trim() : '';
            fs.writeFileSync(cssPath, prev ? `${prev}\n\n${checked.css}` : checked.css);
            const rows = readEdits(job.id);
            rows.push({ type: 'css', css: checked.css });
            writeEdits(job.id, rows);
          },
        },
      });
    } catch (err) {
      if (!res.writableEnded) {
        send('error', { error: err.message || 'The chat did not answer.' });
        res.end();
      }
      return;
    }
    if (clientGone || res.writableEnded) return;
    if (result.job?.id) result.job = jobs.publicJob(result.job, origin);
    send('done', result);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/jobs') {
    const list = await jobs.listJobs(user.id);
    return sendJson(res, 200, { jobs: list.map((j) => jobs.publicJob(j, originOf(req))) });
  }

  if (req.method === 'DELETE' && url.pathname === '/api/jobs') {
    const removed = await jobs.deleteAllJobs(user.id);
    for (const job of removed) eraseJobFiles(job);
    return sendJson(res, 200, { removed: removed.length });
  }

  if (parts[0] === 'api' && parts[1] === 'jobs' && parts[2]) {
    const id = parts[2];
    const job = await jobs.getJob(id, user.id);
    if (!job) return sendJson(res, 404, { error: 'Job not found' });

    if (req.method === 'GET' && parts.length === 3) {
      return sendJson(res, 200, jobs.publicJob(job, originOf(req)));
    }

    if (req.method === 'POST' && parts[3] === 'host') {
      return sendJson(res, 501, { error: 'Use the share link. Publishing a capture as its own site is not connected.' });
    }

    if (req.method === 'POST' && parts[3] === 'stop') {
      const updated = await markStopped(id);
      return sendJson(res, 200, jobs.publicJob(updated || { ...job, status: 'failed', error: 'Stopped.' }, originOf(req)));
    }

    if (req.method === 'DELETE' && parts.length === 3) {
      const removed = await jobs.deleteJob(id, user.id);
      if (!removed) return sendJson(res, 404, { error: 'Job not found' });
      eraseJobFiles(removed);
      return sendJson(res, 200, { ok: true, id });
    }

    if (req.method === 'GET' && parts[3] === 'images') {
      const manPath = path.join(siteDir(id), 'manifest.json');
      const showSmall = url.searchParams.get('small') === '1';
      if (!fs.existsSync(manPath)) return sendJson(res, 200, { images: [], imageCount: 0, showSmall });
      const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
      const root = path.resolve(siteDir(id));
      const seen = new Set();
      const images = [];
      let skipped = 0;
      for (const img of man.images || []) {
        if (!showSmall && img.small) continue;
        const local = String(img.local || '').replace(/\\/g, '/');
        if (!local || local.includes('..') || seen.has(local)) continue;
        const full = path.resolve(root, local);
        if (!full.startsWith(root + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
        const displayType = viewableImage(full, img.contentType, local);
        if (!displayType) { skipped += 1; continue; }
        seen.add(local);
        images.push({
          ...img,
          contentType: displayType,
          src: `/preview/${id}/${local}`,
        });
      }
      return sendJson(res, 200, { images, imageCount: images.length, skipped, totalMB: man.totalMB, showSmall });
    }

    if (req.method === 'GET' && parts[3] === 'zip') {
      const type = url.searchParams.get('type') === 'images' ? 'images' : 'full';
      let zipPath;
      try { zipPath = await buildZip(id, type); }
      catch { zipPath = path.join(zipDir, type === 'images' ? `${id}-images.zip` : `${id}.zip`); }
      if (!zipPath || !fs.existsSync(zipPath)) return sendJson(res, 404, { error: 'ZIP not ready yet' });
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${downloadName(job, type)}"`,
      });
      return fs.createReadStream(zipPath).pipe(res);
    }

    if (req.method === 'POST' && parts[3] === 'logo') {
      if (job.status !== 'done') return sendJson(res, 400, { error: 'The preview is not ready yet.' });
      const raw = await readBody(req, env.limits.maxFileMB * 1024 * 1024);
      const parsed = parseMultipart(raw, req.headers['content-type'] || '');
      const ext = path.extname(parsed.filename || '').toLowerCase();
      if (!parsed.file || !['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)) {
        return sendJson(res, 400, { error: 'Use a png, jpg, webp, gif, or svg logo.' });
      }
      const assets = path.join(siteDir(id), 'assets');
      fs.mkdirSync(assets, { recursive: true });
      for (const name of fs.existsSync(assets) ? fs.readdirSync(assets) : []) {
        if (/^brand-logo\./i.test(name)) fs.unlinkSync(path.join(assets, name));
      }
      const filename = `brand-logo${ext}`;
      fs.writeFileSync(path.join(assets, filename), parsed.file);
      const htmlPath = path.join(siteDir(id), 'index.html');
      if (!fs.existsSync(htmlPath)) return sendJson(res, 400, { error: 'The captured page is missing.' });
      const before = fs.readFileSync(htmlPath, 'utf8');
      const { applyPrototype } = require('./prototype');
      const changed = applyPrototype(before, 'replace the logo with mine', { logoSrc: `assets/${filename}` });
      if (!changed?.html) return sendJson(res, 400, { error: changed?.error || 'There is no logo in the header.' });
      fs.writeFileSync(htmlPath, changed.html);
      const rows = readEdits(id);
      rows.push({ type: 'snapshot', before });
      writeEdits(id, rows.slice(-8));
      return sendJson(res, 200, { ...jobs.publicJob(job, originOf(req)), reply: changed.line });
    }

    if (req.method === 'POST' && parts[3] === 'share') {
      const body = JSON.parse((await readBody(req, 20000)).toString('utf8') || '{}');
      if (!body.enabled) {
        const map = jobs.shares();
        if (job.share_token) delete map[job.share_token];
        jobs.saveShares(map);
        const updated = await jobs.updateJob(id, { share_token: null, share_expires_at: null });
        return sendJson(res, 200, jobs.publicJob(updated || { ...job, share_token: null }, originOf(req)));
      }
      const token = job.share_token || crypto.randomBytes(12).toString('hex');
      const days = Number(body.expiresInDays);
      const span = days === 0 ? 0 : days === 30 ? 30 : 7;
      const expires = span ? new Date(Date.now() + span * 86400000).toISOString() : null;
      const map = jobs.shares();
      map[token] = { jobId: id, expiresAt: expires };
      jobs.saveShares(map);
      const updated = await jobs.updateJob(id, { share_token: token, share_expires_at: expires });
      return sendJson(res, 200, jobs.publicJob(updated || { ...job, share_token: token, share_expires_at: expires }, originOf(req)));
    }

    if (req.method === 'POST' && parts[3] === 'apply') {
      const body = JSON.parse((await readBody(req, 200000)).toString('utf8') || '{}');
      try { applyProposal(job, body); }
      catch (err) { return sendJson(res, err.status || 400, { error: err.message }); }
      return sendJson(res, 200, jobs.publicJob(job, originOf(req)));
    }

    if (req.method === 'POST' && parts[3] === 'undo') {
      const undone = undoOne(job);
      if (!undone.ok) return sendJson(res, 400, { error: undone.error || 'Nothing to undo.' });
      return sendJson(res, 200, jobs.publicJob(job, originOf(req)));
    }

    if (req.method === 'POST' && parts[3] === 'edit') {
      const body = JSON.parse((await readBody(req, 20000)).toString('utf8') || '{}');
      const outlinePath = path.join(siteDir(id), 'outline.json');
      const outline = fs.existsSync(outlinePath) ? JSON.parse(fs.readFileSync(outlinePath, 'utf8')) : { sections: [] };
      const raw = cssFromInstruction(body.instruction, outline);
      const checked = validateCss(raw || '');
      if (!checked.ok) return sendJson(res, 400, { error: checked.error });
      fs.writeFileSync(path.join(siteDir(id), 'custom.css'), checked.css);
      return sendJson(res, 200, { ok: true, css: checked.css });
    }

    if (req.method === 'DELETE' && parts[3] === 'edit') {
      const cssPath = path.join(siteDir(id), 'custom.css');
      if (fs.existsSync(cssPath)) fs.unlinkSync(cssPath);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/upload') {
    const raw = await readBody(req, env.limits.maxFileMB * 1024 * 1024);
    const ctype = req.headers['content-type'] || '';
    let fileBuf = raw;
    let filename = 'upload.html';
    let rights = false;
    if (ctype.includes('multipart/form-data')) {
      const parsed = parseMultipart(raw, ctype);
      fileBuf = parsed.file;
      filename = parsed.filename || filename;
      rights = parsed.fields.rights_confirmed === 'true' || parsed.fields.rights_confirmed === 'on';
    } else {
      rights = url.searchParams.get('rights') === '1';
    }
    if (!rights) return sendJson(res, 400, { error: 'Rights confirmation required' });
    if (!fileBuf || !fileBuf.length) return sendJson(res, 400, { error: 'Choose an .html or .zip file' });
    const ext = path.extname(filename).toLowerCase();
    if (!['.html', '.htm', '.zip'].includes(ext)) return sendJson(res, 400, { error: 'Only .html or .zip files' });
    fs.mkdirSync(uploadDir, { recursive: true });
    const jobId = crypto.randomUUID();
    const dest = path.join(uploadDir, `${jobId}${ext}`);
    fs.writeFileSync(dest, fileBuf);
    const job = await jobs.createJob({
      id: jobId,
      user_id: user.id,
      source_url: null,
      mode: 'upload',
      options: { uploadPath: dest },
      rights_confirmed: true,
    });
    startCapture(job);
    return sendJson(res, 200, jobs.publicJob(job, originOf(req)));
  }

  return sendJson(res, 404, { error: 'Not found' });
}

function parseMultipart(buf, contentType) {
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = m && (m[1] || m[2]);
  const result = { file: null, filename: '', fields: {} };
  if (!boundary) return result;
  const parts = buf.toString('latin1').split('--' + boundary);
  for (const part of parts) {
    if (part === '--' || part === '--\r\n' || !part.includes('\r\n\r\n')) continue;
    const [head, ...rest] = part.split('\r\n\r\n');
    let body = rest.join('\r\n\r\n');
    if (body.endsWith('\r\n')) body = body.slice(0, -2);
    const name = /name="([^"]+)"/.exec(head);
    const fname = /filename="([^"]*)"/.exec(head);
    if (fname && name) {
      result.filename = path.basename(fname[1]);
      if (body.startsWith('\r\n')) body = body.slice(2);
      result.file = Buffer.from(body, 'latin1');
    } else if (name) {
      result.fields[name[1]] = body.trim();
    }
  }
  return result;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    if (url.pathname.startsWith('/preview/')) {
      const segs = url.pathname.split('/').filter(Boolean);
      const jobId = segs[1];
      const rest = '/' + segs.slice(2).join('/');
      return serveSite(req, res, jobId, rest);
    }
    if (url.pathname.startsWith('/share/')) {
      const segs = url.pathname.split('/').filter(Boolean);
      const token = segs[1];
      const rest = '/' + segs.slice(2).join('/');
      const map = jobs.shares();
      const entry = map[token];
      if (!entry) return send(res, 404, 'Link not available');
      if (entry.expiresAt && Date.now() > Date.parse(entry.expiresAt)) return send(res, 404, 'Link not available');
      return serveSite(req, res, entry.jobId, rest, { share: true });
    }
    return serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message || 'Server error' });
  }
});

fs.mkdirSync(outRoot, { recursive: true });
fs.mkdirSync(zipDir, { recursive: true });
fs.mkdirSync(path.join(env.root, 'data'), { recursive: true });

server.listen(env.port, '0.0.0.0', () => {
  console.log(`Protobuild on http://127.0.0.1:${env.port}`);
});
