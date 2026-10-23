const stream = document.getElementById('stream');
const historyEl = document.getElementById('history');
const input = document.getElementById('input');
const pop = document.getElementById('popover');
let jobs = [];
let activeJob = null;
let thread = [];
const goneIds = new Set();
let screenMode = '';
function accountId() {
  const raw = readAuth()?.id || 'local';
  return String(raw).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 48) || 'local';
}
function userPrefix() {
  return 'pb-u:' + accountId() + ':';
}
function sessionPointerKey() {
  return userPrefix() + 'latest';
}
function sessionStoreKey(id) {
  return userPrefix() + 'session:' + id;
}
function threadKey(jobId) {
  return userPrefix() + 'thread:' + jobId;
}
function chatMapKey(jobId) {
  return userPrefix() + 'chat:' + jobId;
}
function rightsKey() {
  return 'pb-rights:' + accountId();
}
let restoring = false;
let chatId = '';

function newChatId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function chatIdFor(jobId) {
  const key = chatMapKey(jobId);
  let id = '';
  try { id = localStorage.getItem(key) || ''; } catch { id = ''; }
  if (!/^[a-f0-9]{8}$/.test(id)) {
    for (const data of listLocalChats()) {
      if (data.jobId === jobId && /^[a-f0-9]{8}$/.test(data.chatId)) return data.chatId;
    }
    id = newChatId();
    try { localStorage.setItem(key, id); } catch { /* keep the id in memory */ }
  }
  return id;
}

function listLocalChats() {
  const rows = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i) || '';
      const prefix = userPrefix() + 'session:';
      if (!key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      if (!/^[a-f0-9]{8}$/.test(id)) continue;
      const data = readStoredSession(id);
      if (!data || !Array.isArray(data.messages) || !data.messages.some((item) => item && item.text)) continue;
      rows.push(data);
    }
  } catch { /* a blocked store just leaves the job list */ }
  return rows;
}

let undoMemory = false;
let undoMemoryId = '';
let showingOriginal = false;

let addressMode = 'replace';
let applyingHistory = false;

function chatIdFromLocation() {
  const path = location.pathname.match(/^\/c\/([a-f0-9]{8})\/?$/);
  if (path) return path[1];
  const query = new URLSearchParams(location.search).get('c') || '';
  return /^[a-f0-9]{8}$/.test(query) ? query : '';
}

function chatLink() {
  return `${location.origin}/c/${chatId}`;
}

function chatIsOpen() {
  return /^[a-f0-9]{8}$/.test(chatId) && (thread.some((item) => item && item.text) || !!activeJob);
}

function syncAddress() {
  const el = document.getElementById('chatId');
  const hasId = /^[a-f0-9]{8}$/.test(chatId);
  const linked = hasId && chatIsOpen();
  if (el) {
    el.hidden = !linked;
    el.textContent = linked ? 'Copy link' : '';
    el.title = linked ? chatLink() : '';
  }
  const title = document.getElementById('chatTitle');
  if (title && !activeJob) {
    const first = thread.find((item) => item && item.role === 'user' && item.text);
    title.textContent = first ? String(first.text).trim().slice(0, 42) : 'New chat';
  }
  if (applyingHistory) return;
  if (!hasId) {
    if (location.pathname !== '/' || location.search) {
      history[addressMode === 'push' ? 'pushState' : 'replaceState']({ chatId: '' }, '', '/');
    }
    addressMode = 'replace';
    return;
  }
  const next = `/c/${chatId}`;
  if (location.pathname.replace(/\/$/, '') === next && !location.search) {
    addressMode = 'replace';
    return;
  }
  history[addressMode === 'push' ? 'pushState' : 'replaceState']({ chatId }, '', next);
  addressMode = 'replace';
}

function paintChatId() {
  syncAddress();
}

function readStoredSession(id) {
  try {
    const raw = id ? localStorage.getItem(sessionStoreKey(id)) : localStorage.getItem(sessionPointerKey());
    const data = JSON.parse(raw || 'null');
    if (!data || typeof data !== 'object') return null;
    if (id && data.chatId !== id) return null;
    return data;
  } catch {
    return null;
  }
}

function saveSession() {
  if (restoring) return;
  if (!chatId) {
    if (thread.some((item) => item && item.text) || activeJob) chatId = newChatId();
    else {
      paintChatId();
      return;
    }
  }
  try {
    const messages = thread
      .filter((item) => item && item.text)
      .slice(-40)
      .map((item) => ({
        role: item.role === 'user' ? 'user' : 'ai',
        text: String(item.text).slice(0, 12000),
        model: item.model || '',
        quotaReset: item.quotaReset || '',
      }));
    const payload = { messages, jobId: activeJob?.id || null, chatId };
    localStorage.setItem(sessionPointerKey(), JSON.stringify(payload));
    localStorage.setItem(sessionStoreKey(chatId), JSON.stringify(payload));
    if (activeJob?.id) {
      localStorage.setItem(threadKey(activeJob.id), JSON.stringify(messages));
      localStorage.setItem(chatMapKey(activeJob.id), chatId);
    }
  } catch { /* a full browser store should not block the chat */ }
  paintChatId();
}

function setBtnLabel(el, label) {
  if (!el) return;
  const slot = el.querySelector('.btn-label');
  if (slot) slot.textContent = label;
}

function tuneBtn(el, on, label, tip) {
  if (!el) return;
  el.disabled = !on;
  if (label) setBtnLabel(el, label);
  const icon = el.classList.contains('icon-btn') || el.classList.contains('tool') || el.classList.contains('icon-quiet') || el.classList.contains('mini');
  if (tip && icon) {
    el.dataset.tip = tip;
    el.title = tip;
    el.setAttribute('aria-label', tip);
  } else {
    delete el.dataset.tip;
    el.removeAttribute('title');
    el.removeAttribute('aria-label');
  }
}

function deviceLabel() {
  if (previewDevice === 'desktop') return '1440';
  if (previewDevice === 'tablet') return '768';
  return '390';
}

function shareExpiryLine(job) {
  if (!job?.shareUrl) return 'Not shared';
  if (!job.share_expires_at) return 'Until the capture expires';
  const at = Date.parse(job.share_expires_at);
  if (!Number.isFinite(at)) return 'Shared';
  return 'Expires ' + new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function undoReady(job) {
  if (!job || job.status !== 'done') return false;
  if (typeof job.canUndo === 'boolean') {
    undoMemoryId = job.id;
    undoMemory = job.canUndo;
    return job.canUndo;
  }
  return job.id === undoMemoryId && undoMemory;
}

function syncStageActions(job) {
  const ready = !!(job && job.status === 'done' && job.id);
  const scanning = !!(job && (job.status === 'queued' || job.status === 'running'));
  const name = job ? siteSlug(job) : '';
  const file = job ? zipName(job) : '';
  const imagesFile = job ? zipName(job, 'images') : '';
  const wait = 'Available when the preview finishes.';
  tuneBtn(document.querySelector('#stageBar > .stage-actions [data-open]'), ready && !!job.previewUrl, 'Open', ready ? `Open ${name} in a new tab` : wait);
  tuneBtn(document.querySelector('#stageBar > .stage-actions [data-zip]'), ready, 'Download', ready ? `Download ${file}` : wait);
  tuneBtn(document.getElementById('shareQuick'), ready, 'Share', ready ? `Share ${name}` : wait);
  tuneBtn(document.getElementById('galleryBtn'), !!job?.id, 'Gallery', job?.id ? `Images from ${name}` : 'Open a capture to see its images');
  tuneBtn(document.getElementById('clipBtn'), true, '', 'Attach an image, page, or document');
  tuneBtn(document.getElementById('reloadBtn'), ready, '', 'Reload');
  const exp = document.getElementById('shareExp');
  if (exp) exp.textContent = shareExpiryLine(job);
  document.querySelectorAll('[data-share-days]').forEach((btn) => {
    btn.disabled = !ready;
  });
  tuneBtn(document.getElementById('pickBtn'), ready, 'Pick', ready ? `Pick on ${name}` : wait);
  const undoOn = undoReady(job);
  const undoWhat = job?.undoLabel || 'the last change';
  tuneBtn(document.getElementById('undoBtn'), undoOn, 'Undo', undoOn ? `Undo ${undoWhat}` : (ready ? 'Nothing to undo' : wait));
  const compare = document.getElementById('compareBtn');
  tuneBtn(compare, ready && undoOn, showingOriginal ? 'Edited' : 'Original', ready && undoOn ? (showingOriginal ? 'Show the edited page' : 'Show the original capture') : wait);
  tuneBtn(document.getElementById('zipImages'), ready, 'Download all', ready ? `Download every image as ${imagesFile}` : wait);
  const images = document.getElementById('viewImages');
  if (images) {
    images.disabled = !job?.id;
    images.dataset.tip = job?.id ? `Images from ${name}` : 'Open a capture to see its images';
  }
  const clearAll = document.getElementById('prefClear');
  if (clearAll) clearAll.disabled = !jobs.length && !listLocalChats().length;
  const remove = document.getElementById('prefRemove');
  if (remove) {
    const open = !!(job?.id || thread.some((item) => item && item.text));
    remove.disabled = !open;
    remove.textContent = 'Clear';
  }
  const stageTitle = document.getElementById('stageTitle');
  if (stageTitle) stageTitle.textContent = deviceLabel();
  const frameBox = document.querySelector('.device');
  if (frameBox) frameBox.setAttribute('aria-label', `Preview, ${deviceLabel()} wide`);
  const box = document.getElementById('input');
  if (box) {
    box.placeholder = ready
      ? `Describe what should change on ${name}.`
      : (scanning ? `Opening ${name}.` : 'Describe what you want, or paste a site.');
  }
}

function siteSlug(job) {
  const raw = String(job?.source_url || '').trim();
  let host = '';
  try {
    if (/^https?:\/\//i.test(raw)) host = new URL(raw).hostname;
    else if (raw) host = raw.split('/')[0];
  } catch { host = ''; }
  host = host.replace(/^www\./i, '').toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return host || 'page';
}

function zipName(job, kind) {
  const slug = siteSlug(job);
  return kind === 'images' ? `${slug}-images.zip` : `${slug}.zip`;
}

function clearSession() {
  try { localStorage.removeItem(sessionPointerKey()); } catch {}
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function readAuth() {
  try { return JSON.parse(localStorage.getItem('pb-auth') || 'null'); } catch { return null; }
}
function saveAuth(session) {
  localStorage.setItem('pb-auth', JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token || '',
    expires_at: session.expires_at || 0,
    email: session.user?.email || session.email || '',
    id: session.user?.id || session.id || '',
  }));
}
function authHeaders() {
  const token = readAuth()?.access_token;
  return token ? { Authorization: 'Bearer ' + token } : {};
}
async function refreshAuth() {
  const saved = readAuth();
  if (!saved?.refresh_token) return null;
  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: saved.refresh_token }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) return null;
  saveAuth(json);
  return json;
}

async function api(path, opts = {}, retry = true) {
  const headers = { ...authHeaders(), ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData) && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 && retry && !/\/api\/auth\/(login|signup|refresh)/.test(path)) {
    const next = await refreshAuth();
    if (next) return api(path, opts, false);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { error: text }; }
  if (!res.ok) throw new Error(json?.error || res.statusText);
  return json;
}

function iconBtn(name, label, path) {
  return `<button class="mini" type="button" data-act="${name}" data-tip="${label}" aria-label="${label}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">${path}</svg></button>`;
}

function linkify(text) {
  return esc(text).replace(/\n/g, '<br>').replace(/(^|[\s(])((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<)]*)?)/gi, (all, lead, raw) => {
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return `${lead}<a href="${esc(href)}" target="_blank" rel="noopener">${raw}</a>`;
  });
}

function bubble(role, html, opts = {}) {
  const row = document.createElement('div');
  row.className = 'msg ' + role;
  const who = role === 'user'
    ? '<div class="who">You</div>'
    : '<div class="who"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3a7 7 0 0 1 7 7c0 3-2 5-4 6v2H9v-2c-2-1-4-3-4-6a7 7 0 0 1 7-7z"/></svg></div>';
  row.innerHTML = `${who}<div class="bubble">${html}</div>`;
  const tools = document.createElement('div');
  tools.className = 'actions-row';
  const copy = iconBtn('copy', 'Copy', '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>');
  const edit = iconBtn('edit', 'Edit', '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>');
  const retry = iconBtn('retry', 'Resend', '<path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/>');
  tools.innerHTML = role === 'user' ? copy + edit + retry : copy + retry;
  if (opts.pending) tools.hidden = true;
  const retryBtn = tools.querySelector('[data-act="retry"]');
  if (role !== 'user') retryBtn.hidden = true;
  const copyBtn = tools.querySelector('[data-act="copy"]');
  copyBtn.onclick = () => copyText(row.querySelector('.bubble')?.innerText || '', 'Copied.', copyBtn);
  tools.querySelector('[data-act="edit"]')?.addEventListener('click', () => beginEdit(row));
  retryBtn.onclick = () => resendRow(row);
  row.appendChild(tools);
  stream.appendChild(row);
  stickThread(role === 'user');
  return row.querySelector('.bubble');
}

function nearBottom() {
  if (!stream) return true;
  return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 72;
}

let followThread = true;
let sticking = false;

function stickThread(force) {
  const chip = document.getElementById('newText');
  if (!stream) return;
  if (force || followThread) {
    sticking = true;
    stream.scrollTop = stream.scrollHeight;
    followThread = true;
    chip?.classList.add('hidden');
    setTimeout(() => { sticking = false; }, 80);
    return;
  }
  chip?.classList.remove('hidden');
}

function showRetry(bubbleEl) {
  const row = bubbleEl?.closest('.msg');
  if (!row) return;
  const tools = row.querySelector('.actions-row');
  const retry = row.querySelector('[data-act="retry"]');
  if (tools) tools.hidden = false;
  if (retry) retry.hidden = false;
}

function userRowFor(row) {
  let node = row;
  while (node && !node.classList.contains('user')) node = node.previousElementSibling;
  return node?.classList.contains('msg') ? node : null;
}

function cutAfter(row) {
  const index = [...stream.querySelectorAll('.msg')].indexOf(row);
  let node = row.nextElementSibling;
  while (node) {
    const next = node.nextElementSibling;
    node.remove();
    node = next;
  }
  if (index >= 0) thread = thread.slice(0, index + 1);
  saveSession();
}

function beginEdit(row) {
  const bubbleEl = row.querySelector('.bubble');
  const tools = row.querySelector('.actions-row');
  if (!bubbleEl || row.querySelector('.edit-box')) return;
  const form = document.createElement('form');
  form.className = 'edit-box';
  form.innerHTML = '<textarea aria-label="Edit message"></textarea><div class="edit-actions"><button type="button" data-cancel>Cancel</button><button type="submit">Send</button></div>';
  const area = form.querySelector('textarea');
  area.value = bubbleEl.innerText;
  bubbleEl.hidden = true;
  if (tools) tools.hidden = true;
  bubbleEl.after(form);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  const close = () => {
    form.remove();
    bubbleEl.hidden = false;
    if (tools) tools.hidden = false;
  };
  form.querySelector('[data-cancel]').onclick = close;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const next = area.value;
    close();
    resendTurn(row, next);
  });
}

function resendRow(row) {
  const user = userRowFor(row);
  if (!user) { toast('Nothing to send again.'); return; }
  resendTurn(user, user.querySelector('.bubble')?.innerText || '');
}

function isNarrow() {
  return window.innerWidth <= 1099;
}

function closeDrawer() {
  document.querySelector('.side')?.classList.remove('open');
  document.getElementById('drawerBackdrop')?.classList.add('hidden');
}

function setPane(name) {
  const preview = name === 'preview';
  document.body.dataset.pane = preview ? 'preview' : 'chat';
  document.querySelectorAll('#paneSwitch [data-pane]').forEach((btn) => {
    const on = btn.dataset.pane === (preview ? 'preview' : 'chat');
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  if (preview) requestAnimationFrame(fitPhone);
}

let previewShownFor = '';

function setWorking(on) {
  document.querySelector('.app')?.classList.toggle('working', !!on);
  if (!on) {
    previewShownFor = '';
    setPane('chat');
    const title = document.getElementById('mobileTitle');
    if (title) title.textContent = 'Protobuild';
  }
  markHome();
  applyColumns();
}

function markHome() {
  const home = document.getElementById('homeNav');
  const settingsOpen = document.body.classList.contains('settings-open');
  const working = document.querySelector('.app')?.classList.contains('working');
  home?.classList.toggle('on', !working && !settingsOpen);
}

const PREF_KEY = 'pb-prefs';

function readPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {};
    const theme = saved.theme === 'dark' || saved.theme === 'system' || saved.theme === 'light' ? saved.theme : 'system';
    return {
      theme,
      chatSide: saved.chatSide === 'right' ? 'right' : 'left',
      suggestions: saved.suggestions !== false,
      sound: !!saved.sound,
      rights: rightsSaved(),
      tiny: !!saved.tiny,
    };
  } catch {
    return { theme: 'system', chatSide: 'left', suggestions: true, sound: false, rights: rightsSaved(), tiny: false };
  }
}

function resolvedTheme(theme) {
  if (theme === 'dark') return 'dark';
  if (theme === 'light') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function writePrefs(partial) {
  const next = { ...readPrefs(), ...partial };
  localStorage.setItem(PREF_KEY, JSON.stringify(next));
  applyPrefs(next, { rights: Object.prototype.hasOwnProperty.call(partial, 'rights') });
  return next;
}

function applyPrefs(prefs, opts = {}) {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme(prefs.theme);
  root.dataset.chat = prefs.chatSide === 'right' ? 'right' : 'left';
  root.dataset.suggestions = prefs.suggestions ? 'on' : 'off';
  if (opts.rights) {
    const rights = document.getElementById('rights');
    if (rights) rights.checked = prefs.rights !== false;
  }
  syncSettingsControls(prefs);
  applyColumns();
}

const WIDTH_KEY = 'pb-widths';
const WIDTH_MIN = { side: 200, chat: 300, stage: 320 };
const WIDTH_DEFAULT = { side: 260, stage: 440 };
let columnDrag = false;

function readWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem(WIDTH_KEY) || '{}');
    return {
      side: Number(saved.side) || WIDTH_DEFAULT.side,
      chat: Number(saved.chat) || 0,
      stage: Number(saved.stage) || WIDTH_DEFAULT.stage,
    };
  } catch {
    return { side: WIDTH_DEFAULT.side, chat: 0, stage: WIDTH_DEFAULT.stage };
  }
}

function writeWidths(widths) {
  const next = {
    side: Math.round(widths.side),
    chat: Math.round(widths.chat || 0),
    stage: Math.round(widths.stage),
  };
  localStorage.setItem(WIDTH_KEY, JSON.stringify(next));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function fitTrio(side, chat, stage, avail) {
  const mins = [WIDTH_MIN.side, WIDTH_MIN.chat, WIDTH_MIN.stage];
  let vals = [side, chat, stage];
  const sum = vals.reduce((total, value) => total + value, 0) || 1;
  vals = vals.map((value) => (value / sum) * avail);
  for (let pass = 0; pass < 3; pass += 1) {
    let deficit = 0;
    let flex = 0;
    vals.forEach((value, index) => {
      if (value < mins[index]) deficit += mins[index] - value;
      else flex += value;
    });
    if (deficit <= 0.5 || flex <= 0) break;
    vals = vals.map((value, index) => (value < mins[index] ? mins[index] : value - deficit * (value / flex)));
  }
  let sidePx = Math.round(vals[0]);
  let stagePx = Math.round(vals[2]);
  let chatPx = Math.round(avail) - sidePx - stagePx;
  if (chatPx < WIDTH_MIN.chat) {
    const need = WIDTH_MIN.chat - chatPx;
    if (sidePx - need >= WIDTH_MIN.side) sidePx -= need;
    else if (stagePx - need >= WIDTH_MIN.stage) stagePx -= need;
    chatPx = Math.round(avail) - sidePx - stagePx;
  }
  return { side: sidePx, chat: chatPx, stage: stagePx };
}

function chatOnRight() {
  return document.documentElement.dataset.chat === 'right';
}

function gridTracks(side, chat, stage) {
  const s = Math.round(side);
  const c = Math.round(chat);
  const t = Math.round(stage);
  return chatOnRight() ? `${s}px 10px ${t}px 10px ${c}px` : `${s}px 10px ${c}px 10px ${t}px`;
}

function labelSplits() {
  const right = chatOnRight();
  const side = document.getElementById('splitSide');
  const stage = document.getElementById('splitStage');
  if (side) {
    side.setAttribute('aria-label', right ? 'Resize history and phone' : 'Resize history and chat');
    side.title = right
      ? 'Drag to resize history and the phone. Double-click to reset.'
      : 'Drag to resize history and chat. Double-click to reset.';
  }
  if (stage) {
    stage.setAttribute('aria-label', right ? 'Resize phone and chat' : 'Resize chat and phone');
    stage.title = right
      ? 'Drag to resize the phone and chat. Double-click to reset.'
      : 'Drag to resize chat and the phone. Double-click to reset.';
  }
}

function historyClosed() {
  return document.documentElement.dataset.history === 'off';
}

function applyColumns() {
  const app = document.querySelector('.app');
  if (!app) return;
  app.classList.toggle('chat-right', chatOnRight());
  labelSplits();
  if (window.innerWidth <= 1099) {
    app.style.gridTemplateColumns = '';
    return;
  }
  const working = app.classList.contains('working');
  const saved = readWidths();
  if (historyClosed() && working) {
    const gap = working ? 10 : 0;
    const avail = window.innerWidth - gap;
    if (!working) app.style.gridTemplateColumns = '0px 0px minmax(0, 1fr)';
    else {
      const chatPx = Math.max(WIDTH_MIN.chat, saved.chat || Math.round(avail * 0.46));
      const stagePx = Math.max(WIDTH_MIN.stage, avail - chatPx);
      const chat = Math.max(WIDTH_MIN.chat, avail - stagePx);
      app.style.gridTemplateColumns = chatOnRight()
        ? `0px 0px ${avail - chat}px 10px ${chat}px`
        : `0px 0px ${chat}px 10px ${avail - chat}px`;
    }
    requestAnimationFrame(fitPhone);
    return;
  }
  const avail = window.innerWidth - (working ? 20 : 10);
  if (!working) {
    const side = clamp(saved.side, WIDTH_MIN.side, Math.max(WIDTH_MIN.side, avail - 280));
    app.style.gridTemplateColumns = `${Math.round(side)}px 10px minmax(0, 1fr)`;
    return;
  }
  const chat = saved.chat || Math.max(WIDTH_MIN.chat, avail - saved.side - saved.stage);
  const fit = fitTrio(saved.side, chat, saved.stage, avail);
  app.style.gridTemplateColumns = gridTracks(fit.side, fit.chat, fit.stage);
  requestAnimationFrame(fitPhone);
}

function measureColumns() {
  const working = document.querySelector('.app')?.classList.contains('working');
  return {
    side: document.querySelector('.side')?.getBoundingClientRect().width || readWidths().side,
    chat: document.querySelector('.chat')?.getBoundingClientRect().width || 0,
    stage: working ? (document.querySelector('.stage')?.getBoundingClientRect().width || readWidths().stage) : readWidths().stage,
  };
}

function paintColumns(side, chat, stage, working) {
  const app = document.querySelector('.app');
  if (!app) return;
  app.classList.toggle('chat-right', chatOnRight());
  if (!working) {
    app.style.gridTemplateColumns = `${Math.round(side)}px 10px minmax(0, 1fr)`;
    return;
  }
  app.style.gridTemplateColumns = gridTracks(side, chat, stage);
  requestAnimationFrame(fitPhone);
}

function resetColumnWidths() {
  writeWidths({ side: WIDTH_DEFAULT.side, chat: 0, stage: WIDTH_DEFAULT.stage });
  applyColumns();
}

function bindSplits() {
  function bind(el, which) {
    if (!el) return;
    let startX = 0;
    let start = null;
    let live = null;
    let moved = false;
    let preserved = null;
    let lastMoveAt = 0;
    el.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || window.innerWidth <= 1099) return;
      ev.preventDefault();
      columnDrag = true;
      moved = false;
      startX = ev.clientX;
      start = measureColumns();
      preserved = readWidths();
      live = null;
      el.classList.add('dragging');
      document.body.classList.add('col-drag');
      el.setPointerCapture(ev.pointerId);
    });
    el.addEventListener('pointermove', (ev) => {
      if (!columnDrag || !start) return;
      const dx = ev.clientX - startX;
      if (Math.abs(dx) < 2 && !moved) return;
      moved = true;
      lastMoveAt = Date.now();
      const working = document.querySelector('.app')?.classList.contains('working');
      if (!working) {
        const maxSide = Math.max(WIDTH_MIN.side, window.innerWidth - 10 - 280);
        const side = clamp(start.side + dx, WIDTH_MIN.side, maxSide);
        live = { side, chat: preserved.chat, stage: preserved.stage };
        paintColumns(side, live.chat, live.stage, false);
      } else if (which === 'side') {
        if (chatOnRight()) {
          const pair = start.side + start.stage;
          const side = clamp(start.side + dx, WIDTH_MIN.side, pair - WIDTH_MIN.stage);
          live = { side, chat: start.chat, stage: pair - side };
        } else {
          const pair = start.side + start.chat;
          const side = clamp(start.side + dx, WIDTH_MIN.side, pair - WIDTH_MIN.chat);
          live = { side, chat: pair - side, stage: start.stage };
        }
        paintColumns(live.side, live.chat, live.stage, true);
      } else if (chatOnRight()) {
        const pair = start.stage + start.chat;
        const stage = clamp(start.stage + dx, WIDTH_MIN.stage, pair - WIDTH_MIN.chat);
        live = { side: start.side, chat: pair - stage, stage };
        paintColumns(live.side, live.chat, live.stage, true);
      } else {
        const pair = start.chat + start.stage;
        const stage = clamp(start.stage - dx, WIDTH_MIN.stage, pair - WIDTH_MIN.chat);
        live = { side: start.side, chat: pair - stage, stage };
        paintColumns(live.side, live.chat, live.stage, true);
      }
    });
    function endDrag() {
      if (!columnDrag) return;
      columnDrag = false;
      el.classList.remove('dragging');
      document.body.classList.remove('col-drag');
      if (moved && live) writeWidths(live);
      start = null;
      moved = false;
    }
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('dblclick', () => {
      if (Date.now() - lastMoveAt < 500) return;
      resetColumnWidths();
    });
    el.addEventListener('keydown', (ev) => {
      if (window.innerWidth <= 1099) return;
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      const dir = ev.key === 'ArrowRight' ? 24 : -24;
      const now = measureColumns();
      const working = document.querySelector('.app')?.classList.contains('working');
      const saved = readWidths();
      if (!working) {
        const maxSide = Math.max(WIDTH_MIN.side, window.innerWidth - 10 - 280);
        const side = clamp(now.side + dir, WIDTH_MIN.side, maxSide);
        writeWidths({ side, chat: saved.chat, stage: saved.stage });
      } else if (which === 'side') {
        if (chatOnRight()) {
          const pair = now.side + now.stage;
          const side = clamp(now.side + dir, WIDTH_MIN.side, pair - WIDTH_MIN.stage);
          writeWidths({ side, chat: now.chat, stage: pair - side });
        } else {
          const pair = now.side + now.chat;
          const side = clamp(now.side + dir, WIDTH_MIN.side, pair - WIDTH_MIN.chat);
          writeWidths({ side, chat: pair - side, stage: now.stage });
        }
      } else if (chatOnRight()) {
        const pair = now.stage + now.chat;
        const stage = clamp(now.stage + dir, WIDTH_MIN.stage, pair - WIDTH_MIN.chat);
        writeWidths({ side: now.side, chat: pair - stage, stage });
      } else {
        const pair = now.chat + now.stage;
        const stage = clamp(now.stage - dir, WIDTH_MIN.stage, pair - WIDTH_MIN.chat);
        writeWidths({ side: now.side, chat: pair - stage, stage });
      }
      applyColumns();
    });
  }
  bind(document.getElementById('splitSide'), 'side');
  bind(document.getElementById('splitStage'), 'stage');
}

let previewDevice = localStorage.getItem('pb-device') || 'desktop';

function applyDevice() {
  previewDevice = 'phone';
  localStorage.setItem('pb-device', 'phone');
  const canvas = document.getElementById('phoneView');
  if (canvas) canvas.dataset.device = previewDevice;
  document.querySelectorAll('#deviceSwitch [data-device]').forEach((btn) => {
    const on = btn.dataset.device === previewDevice;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const frame = document.getElementById('stage');
  if (frame) frame.title = activeJob ? siteSlug(activeJob) : 'Site preview';
  syncStageActions(activeJob);
  fitPhone();
}

const ZOOM_STEPS = [0.3, 0.4, 0.55, 0.7, 0.85, 1, 1.15];
let zoomMode = localStorage.getItem('pb-zoom') || 'fit';
let lastFitScale = 0.7;

function zoomScale() {
  if (zoomMode === 'fit') return 0;
  const n = Number(zoomMode);
  return n > 0.2 ? n : 0;
}

function paintZoom() {
  const btn = document.getElementById('zoomFit');
  if (!btn) return;
  if (zoomMode === 'fit') {
    btn.textContent = 'Fit';
    btn.setAttribute('aria-label', 'Fit the preview');
  } else {
    const pct = Math.round(Number(zoomMode) * 100);
    btn.textContent = pct + '%';
    btn.setAttribute('aria-label', `Zoom is ${pct} percent. Click to fit.`);
  }
}

function setZoom(mode) {
  zoomMode = mode;
  localStorage.setItem('pb-zoom', mode);
  paintZoom();
  fitPhone();
}

function stepZoom(dir) {
  const current = zoomMode === 'fit' ? lastFitScale : Number(zoomMode);
  if (dir > 0) setZoom(String(ZOOM_STEPS.find((n) => n > current + 0.02) || ZOOM_STEPS[ZOOM_STEPS.length - 1]));
  else setZoom(String([...ZOOM_STEPS].reverse().find((n) => n < current - 0.02) || ZOOM_STEPS[0]));
}

function fitPhone() {
  const canvas = document.querySelector('.stage-canvas');
  const slot = document.getElementById('phoneSlot');
  const device = document.querySelector('.device');
  if (!canvas || !slot || !device || !document.querySelector('.app')?.classList.contains('working')) return;
  if (canvas.classList.contains('hidden') || canvas.clientWidth < 40) return;
  if (isNarrow()) {
    slot.style.width = '';
    slot.style.height = '';
    device.style.transform = '';
    canvas.classList.remove('zoomed');
    return;
  }
  const chosen = zoomScale();
  if (previewDevice !== 'phone') {
    const s = chosen || 1;
    lastFitScale = 1;
    slot.style.width = '100%';
    slot.style.height = '100%';
    device.style.transformOrigin = 'top center';
    device.style.transform = s === 1 ? 'none' : `scale(${s})`;
    canvas.classList.toggle('zoomed', s > 1);
    return;
  }
  const phoneW = device.offsetWidth || 390;
  const phoneH = device.offsetHeight || 744;
  const fit = Math.min((canvas.clientWidth - 32) / phoneW, (canvas.clientHeight - 32) / phoneH, 1);
  const fitScale = fit > 0.22 ? fit : 0.22;
  lastFitScale = fitScale;
  const s = chosen || fitScale;
  canvas.classList.toggle('zoomed', !!chosen && s > fitScale + 0.02);
  slot.style.width = Math.round(phoneW * s) + 'px';
  slot.style.height = Math.round(phoneH * s) + 'px';
  device.style.transformOrigin = 'top left';
  device.style.transform = `scale(${s})`;
}

function setBusy(btn, on) {
  if (!btn) return;
  btn.classList.toggle('is-busy', !!on);
  btn.disabled = !!on;
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
}

function syncVeil() {
  const veil = document.getElementById('veil');
  if (!veil) return;
  const popOpen = pop && !pop.classList.contains('hidden');
  const confirmOpen = !document.getElementById('confirm')?.classList.contains('hidden');
  const rightsOpen = document.getElementById('rightsModal') && !document.getElementById('rightsModal').hidden;
  const lightOpen = !document.getElementById('lightbox')?.classList.contains('hidden');
  veil.hidden = !(popOpen || confirmOpen || rightsOpen || lightOpen);
}

function rightsGranted() {
  try { return sessionStorage.getItem(rightsKey()) === '1'; } catch { return false; }
}

function askRights() {
  if (rightsGranted()) return Promise.resolve(true);
  const modal = document.getElementById('rightsModal');
  if (!modal) return Promise.resolve(true);
  modal.hidden = false;
  syncVeil();
  return new Promise((resolve) => {
    const yes = document.getElementById('rightsYes');
    const no = document.getElementById('rightsNo');
    const finish = (ok) => {
      yes.onclick = null;
      no.onclick = null;
      setBusy(yes, false);
      modal.hidden = true;
      syncVeil();
      if (ok) {
        try { sessionStorage.setItem(rightsKey(), '1'); } catch {}
        resolve(true);
        return;
      }
      try { sessionStorage.removeItem(rightsKey()); } catch {}
      localStorage.removeItem('pb-auth');
      showAuth();
      resolve(false);
    };
    yes.onclick = () => {
      setBusy(yes, true);
      window.setTimeout(() => finish(true), 700);
    };
    no.onclick = () => finish(false);
  });
}

function rightsSaved() {
  return rightsGranted();
}

function rightsOk() {
  if (rightsGranted()) return true;
  askRights();
  return false;
}

function jobLive(job) {
  return !!(job && (job.status === 'queued' || job.status === 'running'));
}

function formatElapsed(from) {
  const start = Date.parse(from || '');
  const secs = Number.isFinite(start) ? Math.max(0, Math.floor((Date.now() - start) / 1000)) : 0;
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  if (hours) return `${hours}:${String(mins % 60).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  return `${mins}:${String(secs % 60).padStart(2, '0')}`;
}

function remainSeconds(job) {
  const start = Date.parse(job?.created_at || '');
  const gone = Number.isFinite(start) ? Math.floor((Date.now() - start) / 1000) : 0;
  return Math.max(0, 45 - gone);
}

function remainLabel(job) {
  const left = remainSeconds(job);
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

function paintClock() {
  const now = new Date();
  const time = document.getElementById('phoneTime');
  if (time) time.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const scanning = jobLive(activeJob);
  const clock = document.getElementById('captureClock');
  if (clock) {
    clock.hidden = !scanning;
    clock.textContent = scanning ? remainLabel(activeJob) : '';
  }
  if (scanning && remainSeconds(activeJob) <= 0) haltScan(activeJob);
}

let sendToken = 0;
let inflight = null;
let pollGen = 0;
const stoppingIds = new Set();

function setSendMode(on) {
  const btn = document.getElementById('sendBtn');
  if (!btn) return;
  btn.classList.toggle('stop', !!on);
  btn.dataset.tip = on ? 'Stop' : 'Send';
  btn.setAttribute('aria-label', on ? 'Stop' : 'Send');
}

function clearScanPresentation() {
  stream?.querySelectorAll('.live').forEach((node) => node.remove());
  stream?.querySelectorAll('.preview-card iframe').forEach((frame) => frame.removeAttribute('src'));
  document.querySelectorAll('#stage, #phoneView iframe').forEach((frame) => {
    frame.classList.add('hidden');
    frame.removeAttribute('src');
  });
  const empty = document.getElementById('stageEmpty');
  if (empty) empty.classList.remove('busy', 'veil', 'hidden');
  const steps = document.getElementById('captureSteps');
  if (steps) steps.hidden = true;
  const clock = document.getElementById('captureClock');
  if (clock) {
    clock.hidden = true;
    clock.textContent = '';
  }
  for (const box of stream?.querySelectorAll('.bubble') || []) {
    if (/previewing the screen/i.test(box.textContent || '')) box.textContent = 'Stopped.';
  }
  for (const item of thread) {
    if (item.role === 'ai' && /previewing the screen/i.test(item.text || '')) item.text = 'Stopped.';
  }
}

async function haltScan(job) {
  if (!job?.id || stoppingIds.has(job.id)) return;
  if (!jobLive(job) && activeJob?.id === job.id && !jobLive(activeJob)) return;
  stoppingIds.add(job.id);
  pollGen += 1;
  sendToken += 1;
  const ctrl = inflight;
  inflight = null;
  try { ctrl?.abort(); } catch {}
  const stopped = { ...job, status: 'failed', error: 'Stopped.', finished_at: new Date().toISOString() };
  if (!activeJob || activeJob.id === job.id) activeJob = stopped;
  clearScanPresentation();
  showStage(stopped);
  setSendMode(false);
  saveSession();
  refreshJobs();
  toast('Stopped.');
  try {
    const updated = await api('/api/jobs/' + job.id + '/stop', { method: 'POST', body: '{}' });
    if (activeJob?.id === job.id) {
      activeJob = updated.status === 'done' ? updated : stopped;
      showStage(activeJob);
      if (updated.status === 'done') saveSession();
    }
  } catch (err) {
    toast(err.message || 'Could not stop that.');
  } finally {
    stoppingIds.delete(job.id);
  }
}

async function stopRunning() {
  const job = activeJob;
  setSendMode(false);
  if (!jobLive(job)) {
    toast('Stopped.');
    return;
  }
  await haltScan(job);
}

function say(role, text) {
  thread.push({ role, text });
  setWorking(true);
  saveSession();
  return bubble(role, linkify(text));
}

function sayTyping() {
  thread.push({ role: 'ai', text: '' });
  setWorking(true);
  const box = bubble('ai', '<span class="typing" aria-label="Typing"><i></i><i></i><i></i></span>', { pending: true });
  box.classList.add('is-typing');
  return box;
}

function reveal(box, text) {
  const last = thread[thread.length - 1];
  if (last && last.role === 'ai' && !last.text) last.text = text;
  else if (last && last.role === 'ai') last.text = text;
  if (!box) return;
  box.classList.remove('is-typing');
  const tools = box.parentElement?.querySelector('.actions-row');
  if (tools) tools.hidden = false;
  const retry = tools?.querySelector('[data-act="retry"]');
  if (retry) retry.hidden = false;
  const html = linkify(text);
  box.innerHTML = html;
  box.classList.remove('arrived');
  void box.offsetWidth;
  box.classList.add('arrived');
  stickThread(false);
  saveSession();
}

function showStage(job, opts = {}) {
  const frame = document.getElementById('stage');
  const empty = document.getElementById('stageEmpty');
  const title = document.getElementById('stageTitle');
  if (!frame || !job) return;
  if (showingOriginal && undoMemoryId && undoMemoryId !== job.id) showingOriginal = false;
  setWorking(true);
  if (empty) {
    empty.classList.toggle('busy', job.status === 'queued' || job.status === 'running');
    paintStageEmpty(job);
  }
  const previewUrl = job.previewUrl || (job.id ? '/preview/' + job.id + '/' : '');
  const previewReady = job.status === 'done' || job.phase === 'packaging';
  const editing = screenMode === 'edit' && previewReady;
  frame.title = siteSlug(job);
  if (previewReady && previewUrl) {
    const next = previewAddress(job, opts.reload);
    if (opts.reload || frame.getAttribute('src') !== next) frame.src = next;
    frame.classList.remove('hidden');
    empty?.classList.toggle('hidden', !editing && !(job.status === 'queued' || job.status === 'running'));
    empty?.classList.toggle('veil', !!editing);
  } else {
    frame.classList.add('hidden');
    frame.removeAttribute('src');
    empty?.classList.remove('hidden', 'veil');
  }
  if (title) title.textContent = deviceLabel();
  loadGallery(job);
  const host = document.getElementById('stageHost');
  const chatTitle = document.getElementById('chatTitle');
  const name = (job.source_url || 'Uploaded file').replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (host) {
    let nameEl = host.querySelector('.host-name');
    let badge = document.getElementById('stageClock');
    if (!nameEl || !badge) {
      host.textContent = '';
      nameEl = document.createElement('span');
      nameEl.className = 'host-name';
      badge = document.createElement('span');
      badge.id = 'stageClock';
      badge.className = 'stage-clock';
      host.append(nameEl, badge);
    }
    nameEl.textContent = name;
    badge.hidden = true;
    badge.textContent = '';
  }
  if (chatTitle) chatTitle.textContent = name;
  const mobileTitle = document.getElementById('mobileTitle');
  if (mobileTitle) mobileTitle.textContent = name;
  if (isNarrow() && job.status === 'done' && previewShownFor !== job.id) {
    previewShownFor = job.id;
    setPane('preview');
  }
  const bar = document.getElementById('stageBar');
  if (!bar || !job.id) return;
  const openBtn = bar.querySelector(':scope > .stage-actions [data-open]');
  const zipBtn = bar.querySelector(':scope > .stage-actions [data-zip]');
  if (openBtn) openBtn.onclick = () => {
    if (job.status === 'done' && job.previewUrl) window.open(job.previewUrl, '_blank', 'noopener');
    else toast('Available when the preview finishes.', { error: true });
  };
  if (zipBtn) zipBtn.onclick = () => download('/api/jobs/' + job.id + '/zip?type=full', zipName(job));
  syncStageActions(job);
}

function previewAddress(job, reload) {
  const base = job.previewUrl || ('/preview/' + job.id + '/');
  const parts = [];
  if (showingOriginal && undoReady(job)) parts.push('original=1');
  if (reload) parts.push('t=' + Date.now());
  return parts.length ? base + (base.includes('?') ? '&' : '?') + parts.join('&') : base;
}

function screenLabel() {
  return screenMode === 'edit' ? 'Editing the screen' : 'Previewing the screen';
}

function progressLabel(job) {
  if (screenMode === 'edit') return 'Editing the screen';
  const count = String(job?.phaseDetail || '').match(/(\d+)\s*\/\s*(\d+)/);
  if (count && (job?.status === 'queued' || job?.status === 'running')) return `Previewing the screen · ${count[1]}/${count[2]}`;
  return 'Previewing the screen';
}

function paintStageEmpty(job) {
  const idle = document.getElementById('emptyIdle');
  const steps = document.getElementById('captureSteps');
  const fail = document.getElementById('emptyFail');
  const scanning = !!(job && (job.status === 'queued' || job.status === 'running'));
  const editing = screenMode === 'edit';
  const bad = !!(job && (job.status === 'failed' || job.status === 'blocked') && !/stopped/i.test(job.error || ''));
  if (idle) idle.hidden = scanning || editing || bad;
  if (steps) {
    steps.hidden = !(scanning || editing);
    const line = document.getElementById('captureLine');
    if (line && (scanning || editing)) line.textContent = scanning ? progressLabel(job) : 'Editing the screen';
  }
  if (fail) {
    fail.hidden = !bad;
    const text = document.getElementById('emptyFailText');
    if (text && bad) text.textContent = job.status === 'blocked' ? 'This site refused the scanner.' : 'This capture did not finish.';
  }
}

function previewCard(job) {
  const url = job.previewUrl || ('/preview/' + job.id + '/');
  const file = zipName(job);
  const shareLabel = job.shareUrl ? 'Shared' : 'Share';
  return `<div class="preview-card">
    <iframe src="${esc(url)}" title="Preview" sandbox="allow-scripts allow-forms allow-popups"></iframe>
    <div class="bar">
      <button class="linkish" type="button" data-open>Open ${esc(siteSlug(job))}</button>
      <button class="linkish" type="button" data-zip title="Download ${esc(file)}">${esc(file)}</button>
      <button class="linkish" type="button" data-share>${shareLabel}</button>
    </div>
  </div>`;
}

async function refreshJobs() {
  const data = await api('/api/jobs');
  jobs = (data.jobs || []).filter((job) => job && !goneIds.has(job.id));
  renderHistory();
}

function renderHistory() {
  const today = new Date().toDateString();
  const groups = { Today: [], Earlier: [] };
  for (const job of jobs) {
    const when = new Date(job.created_at);
    (when.toDateString() === today ? groups.Today : groups.Earlier).push(job);
  }
  historyEl.innerHTML = '';
  for (const [label, list] of Object.entries(groups)) {
    if (!list.length) continue;
    const g = document.createElement('div');
    g.className = 'group';
    g.textContent = label;
    historyEl.appendChild(g);
    for (const job of list) {
      const row = document.createElement('div');
      row.className = 'h-row';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'h-item' + (activeJob?.id === job.id ? ' active' : '');
      btn.dataset.id = job.id;
      const host = siteSlug(job);
      const word = job.status === 'done' ? 'Done' : (job.status === 'failed' ? 'Failed' : (job.status === 'blocked' ? 'Blocked' : (job.status === 'queued' ? 'Queued' : 'Running')));
      const dot = job.status === 'done' ? 'ok' : (job.status === 'failed' || job.status === 'blocked' ? 'bad' : 'wait');
      btn.innerHTML = `<span class="dot ${dot}"></span><span class="h-copy"><span class="h-host">${esc(host === 'page' ? 'Uploaded file' : host)}</span><span class="h-meta">${esc(word)} · ${esc(relativeTime(job.created_at))}</span></span>`;
      btn.onclick = () => {
        addressMode = 'push';
        openJob(job.id);
      };
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'h-x';
      remove.title = 'Remove';
      remove.setAttribute('aria-label', 'Remove ' + host);
      remove.textContent = '×';
      remove.onclick = (ev) => {
        ev.stopPropagation();
        removeCapture(job.id);
      };
      row.appendChild(btn);
      row.appendChild(remove);
      historyEl.appendChild(row);
    }
  }
  const seenJobs = new Set(jobs.map((job) => job.id));
  const locals = listLocalChats().filter((data) => !data.jobId || !seenJobs.has(data.jobId));
  if (locals.length) {
    const g = document.createElement('div');
    g.className = 'group';
    g.textContent = 'Chats';
    historyEl.appendChild(g);
    for (const data of locals) {
      const first = (data.messages || []).find((item) => item && item.role === 'user' && item.text);
      const label = first ? String(first.text).trim().slice(0, 48) : 'Chat';
      const row = document.createElement('div');
      row.className = 'h-row';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'h-item' + (data.chatId === chatId ? ' active' : '');
      btn.innerHTML = `<span class="dot ok"></span><span class="h-copy"><span class="h-host">${esc(label)}</span><span class="h-meta">Chat</span></span>`;
      btn.onclick = () => openChat(data.chatId);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'h-x';
      remove.setAttribute('aria-label', 'Remove chat');
      remove.textContent = '×';
      remove.addEventListener('click', (ev) => {
        ev.stopPropagation();
        dropChat(data.chatId);
      });
      row.appendChild(btn);
      row.appendChild(remove);
      historyEl.appendChild(row);
    }
  }
  if (!jobs.length && !locals.length) historyEl.innerHTML = '<p class="group">No chats yet. Paste a link to start one.</p>';
  updateHistoryLead();
  paintStarters();
  filterChats();
  syncStageActions(activeJob);
}

function relativeTime(from) {
  const at = Date.parse(from || '');
  if (!Number.isFinite(at)) return '';
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(at).toLocaleDateString();
}

async function openJob(id) {
  let job;
  try {
    job = await api('/api/jobs/' + encodeURIComponent(id));
  } catch (err) {
    toast(err.message || 'That capture is gone.');
    refreshJobs();
    return;
  }
  activeJob = job;
  chatId = chatIdFor(job.id);
  addressMode = addressMode === 'push' ? 'push' : 'replace';
  paintChatId();
  closeDrawer();
  stream.innerHTML = '';
  thread = [];
  const saved = savedThread(job.id);
  let box;
  if (saved.length) {
    restoring = true;
    for (const item of saved) {
      const made = say(item.role === 'user' ? 'user' : 'ai', item.text);
      if (item.model) setModel(made, item.model, item.quotaReset);
      if (item.role !== 'user') box = made;
    }
    restoring = false;
  } else {
    say('user', job.source_url || 'Uploaded file');
    box = say('ai', statusLine(job));
  }
  if (box && job.status === 'done') box.insertAdjacentHTML('beforeend', previewCard(job));
  if (box) wireCard(box, job);
  showStage(job);
  stickThread(true);
  refreshJobs();
  setSendMode(jobLive(job));
  if (box && (job.status === 'queued' || job.status === 'running')) poll(job.id, box);
  saveSession();
}

function cleanError(error) {
  const text = String(error || '').replace(/\u001b\[[0-9;]*m/g, '');
  if (/page\.goto|timeout \d+ms|timed out/i.test(text)) {
    return 'The site did not respond in time. Scan it again, or attach a saved copy of the page.';
  }
  return text.split('\n')[0];
}

function scanText(job) {
  const host = String(job?.source_url || '').replace(/^https?:\/\//, '').replace(/\/$/, '').split('/')[0] || 'the page';
  const detail = String(job?.phaseDetail || '').trim().replace(/\s·\s\d+s$/, '');
  if (job?.status === 'queued' && !detail) return `Starting the browser for ${host}`;
  if (!detail || /^https?:/i.test(detail)) {
    if (job?.phase === 'reading') return `Reading ${host}`;
    if (job?.phase === 'scrolling') return `Loading the rest of ${host}`;
    if (job?.phase === 'saving') return `Saving ${host}`;
    if (job?.phase === 'packaging') return 'Preparing the preview';
    return `Opening ${host}`;
  }
  return detail;
}

function renderLive(box, job) {
  if (!box) return;
  let live = box.querySelector('.live');
  if (job.status === 'done' || job.status === 'failed' || job.status === 'blocked') {
    live?.remove();
    return;
  }
  if (!live) {
    live = document.createElement('div');
    live.className = 'live';
    box.appendChild(live);
  }
  let line = live.querySelector('.scan-line span');
  if (!line) {
    live.innerHTML = '<p class="scan-line"><i class="spin" aria-hidden="true"></i><span></span></p>';
    line = live.querySelector('.scan-line span');
  }
  if (line) line.textContent = progressLabel(job);
}

function statusLine(job) {
  if (job.status === 'done') return 'The page is on the phone. Share the dev link, download it, or describe a change.';
  if (job.status === 'blocked') return cleanError(job.error) || 'This site blocked the scan. Attach a saved copy of the page.';
  if (job.status === 'failed' && /stopped/i.test(job.error || '')) return 'Stopped.';
  if (job.status === 'failed') return cleanError(job.error) || 'The scan did not finish. Try again, or attach a saved copy of the page.';
  return progressLabel(job);
}

function wireCard(box, job) {
  box.querySelector('[data-open]')?.addEventListener('click', () => window.open(job.previewUrl, '_blank', 'noopener'));
  box.querySelector('[data-zip]')?.addEventListener('click', () => download('/api/jobs/' + job.id + '/zip?type=full', zipName(job)));
  box.querySelector('[data-share]')?.addEventListener('click', (event) => openShare(job, event.currentTarget));
}

async function download(path, filename) {
  const res = await fetch(path);
  if (!res.ok) {
    toast('The files are not ready yet.', { error: true, retry: () => download(path, filename) });
    return;
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Download started.');
}

function hostPage() {
  if (!activeJob || activeJob.status !== 'done') { toast('The preview is not ready to host.'); return; }
  share(activeJob, 7);
}

function absoluteLink(url) {
  const raw = String(url || '');
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return location.origin + (raw.startsWith('/') ? raw : `/${raw}`);
}

async function share(job, days = 7) {
  try {
    const updated = await api('/api/jobs/' + job.id + '/share', {
      method: 'POST',
      body: JSON.stringify({ enabled: days !== 'off', expiresInDays: days === 'off' ? 0 : days }),
    });
    activeJob = updated;
    syncStageActions(updated);
    if (days === 'off') { toast('Share link turned off.'); closePop(); return; }
    const link = absoluteLink(updated.shareUrl);
    if (!link) { toast('I could not turn the link on.'); return; }
    showPop(`<h3>Share</h3><p class="menu-note">Anyone with this link can open the page.</p><input class="share-field" readonly value="${esc(link)}" aria-label="Share link"><button class="menu-act" type="button" data-go="copy">Copy link</button>`, document.getElementById('shareQuick'));
    pop.style.width = '320px';
    const field = pop.querySelector('.share-field');
    field?.addEventListener('focus', () => field.select());
    wirePop({
      copy: async (btn) => { await copyText(link, 'Copied.', btn); },
    });
  } catch (err) {
    toast(err.message);
  }
}

function openShare(job) {
  if (!job || job.status !== 'done') { toast('The preview is not ready yet.'); return; }
  const menu = document.getElementById('stageMenu');
  if (!menu) return;
  menu.classList.remove('hidden');
  document.getElementById('shareExp')?.closest('.share-block')?.scrollIntoView?.({ block: 'nearest' });
}

const chimedJobs = new Set();

function maybeChime(job) {
  if (!job?.id) return;
  if (job.status !== 'done' && job.status !== 'failed' && job.status !== 'blocked') return;
  if (chimedJobs.has(job.id)) return;
  chimedJobs.add(job.id);
  const name = siteSlug(job);
  document.title = job.status === 'done' ? `${name} is ready — Protobuild` : `${name} did not finish — Protobuild`;
  if (!readPrefs().sound || !document.hidden) return;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  try {
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.04, ctx.currentTime);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.stop(ctx.currentTime + 0.2);
    setTimeout(() => ctx.close().catch(() => {}), 400);
  } catch {
    /* a missing tone should not stop the capture */
  }
}

function savedThread(jobId) {
  try {
    const rows = JSON.parse(localStorage.getItem(threadKey(jobId)) || 'null');
    return Array.isArray(rows) ? rows.filter((item) => item && item.text) : [];
  } catch { return []; }
}

const advised = new Set();
const lined = new Set();

async function agentFetch(body, signal) {
  const run = () => fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  });
  let res = await run();
  if (res.status === 401) {
    try { await res.body?.cancel(); } catch { /* already closed */ }
    if (await refreshAuth()) res = await run();
  }
  return res;
}

async function requestLine(box, job) {
  if (!box || lined.has(job.id)) return;
  lined.add(job.id);
  try {
    const res = await agentFetch({ purpose: 'ready', activeJobId: job.id, message: job.source_url || '', history: [] });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('text/event-stream')) return;
    const last = [...thread].reverse().find((item) => item.role === 'ai');
    const base = String(last?.text || '');
    let extra = '';
    await readEvents(res, (event, payload) => {
      if (event === 'token') extra += payload.text || '';
      else if (event === 'meta' && payload.model) setModel(box, payload.model, payload.quotaReset);
    });
    const line = extra.trim();
    if (line && !base.includes(line)) paint(box, `${base}\n\n${line}`);
    saveSession();
  } catch { /* the capture is already on screen */ }
}

async function advise(box, job) {
  if (!box || advised.has(job.id)) return;
  advised.add(job.id);
  try {
    const res = await agentFetch({
      message: `The capture of ${job.source_url || 'that page'} ended as ${job.status}. ${job.error || ''} Tell the user what to try next in two sentences. Do not call any tool.`,
      history: thread.slice(-20).map((item) => ({ role: item.role, text: item.text })),
      activeJobId: job.id,
      rights_confirmed: true,
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('text/event-stream')) return;
    const last = [...thread].reverse().find((item) => item.role === 'ai');
    const base = String(last?.text || '');
    let extra = '';
    await readEvents(res, (event, payload) => {
      if (event === 'token') {
        extra += payload.text || '';
        paint(box, `${base}\n\n${extra}`);
      } else if (event === 'meta' && payload.model) setModel(box, payload.model, payload.quotaReset);
    });
    saveSession();
  } catch { /* the status line already names the error */ }
}

async function poll(id, box) {
  const mine = ++pollGen;
  const tick = async () => {
    if (mine !== pollGen || activeJob?.id !== id) return;
    let job;
    try { job = await api('/api/jobs/' + encodeURIComponent(id)); }
    catch { return; }
    if (mine !== pollGen || activeJob?.id !== id) return;
    if (jobLive(job) && remainSeconds(job) <= 0) {
      haltScan(job);
      return;
    }
    activeJob = job;
    let status = box.querySelector('[data-status]');
    if (!status) {
      status = document.createElement('div');
      status.dataset.status = '1';
      status.style.marginTop = '8px';
      box.appendChild(status);
    }
    status.textContent = jobLive(job) ? '' : statusLine(job);
    renderLive(box, job);
    if (activeJob?.id === id && !inflight) setSendMode(jobLive(job));
    if (job.status === 'failed' && /stopped/i.test(job.error || '')) {
      clearScanPresentation();
      showStage(job);
      refreshJobs();
      setSendMode(false);
      return;
    }
    if (job.status === 'done') {
      requestLine(box, job);
      maybeChime(job);
    } else if (job.status === 'failed' || job.status === 'blocked') {
      const line = statusLine(job);
      const last = [...thread].reverse().find((item) => item.role === 'ai');
      if (last && line && !last.text.includes(line.slice(0, 48))) last.text = `${last.text}\n\n${line}`;
      saveSession();
      maybeChime(job);
    }
    if (job.status === 'done') {
      if (!box.querySelector('.preview-card')) box.insertAdjacentHTML('beforeend', previewCard(job));
      wireCard(box, job);
      if (deliverOnDone.has(job.id)) {
        const kind = deliverOnDone.get(job.id);
        deliverOnDone.delete(job.id);
        deliver(job, kind);
      }
      showStage(job);
      stickThread(false);
      refreshJobs();
      return;
    }
    showStage(job);
    if (job.status === 'failed' || job.status === 'blocked') {
      if (!/stopped/i.test(job.error || '')) {
        showRetry(box);
        const sent = box.closest('.msg')?.previousElementSibling;
        if (sent?.classList.contains('user')) showRetry(sent.querySelector('.bubble'));
      }
      refreshJobs();
      return;
    }
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 400);
}

async function uploadLogo(file) {
  const token = ++sendToken;
  setSendMode(true);
  const sent = say('user', file.name);
  const box = sayTyping();
  const fd = new FormData();
  fd.append('file', file, file.name);
  try {
    const updated = await api('/api/jobs/' + activeJob.id + '/logo', { method: 'POST', body: fd });
    if (token !== sendToken) return;
    reveal(box, updated.reply || 'Replaced the logo with your image.');
    activeJob = updated;
    showStage(updated, { reload: true });
    saveSession();
    setSendMode(false);
  } catch (err) {
    if (token !== sendToken) return;
    reveal(box, err.message || 'That logo did not upload.');
    showRetry(sent);
    showRetry(box);
    setSendMode(false);
  }
}

async function uploadFile(file) {
  if (activeJob?.status === 'done' && /^image\//.test(file.type || '')) return uploadLogo(file);
  if (!rightsOk('scan upload')) return;
  const token = ++sendToken;
  setSendMode(true);
  const sent = say('user', file.name);
  const box = sayTyping();
  const ctrl = new AbortController();
  inflight = ctrl;
  const fd = new FormData();
  fd.append('file', file, file.name);
  fd.append('rights_confirmed', 'true');
  try {
    const job = await api('/api/upload', { method: 'POST', body: fd, signal: ctrl.signal });
    if (token !== sendToken) {
      if (job?.id) await api('/api/jobs/' + job.id + '/stop', { method: 'POST', body: '{}' }).catch(() => {});
      return;
    }
    reveal(box, 'Reading that file and building the copy.');
    activeJob = job;
    await refreshJobs();
    setSendMode(jobLive(job));
    poll(job.id, box);
    saveSession();
  } catch (err) {
    if (token !== sendToken || err.name === 'AbortError') {
      reveal(box, 'Stopped.');
      if (token === sendToken) setSendMode(false);
      return;
    }
    reveal(box, err.message || 'That file did not upload.');
    showRetry(sent);
    showRetry(box);
    setSendMode(false);
  } finally {
    if (inflight === ctrl) inflight = null;
  }
}

const deliverOnDone = new Map();

function deliver(job, kind) {
  if (!job?.id || job.status !== 'done') return;
  if (kind === 'images') download('/api/jobs/' + job.id + '/zip?type=images', zipName(job, 'images'));
  else download('/api/jobs/' + job.id + '/zip?type=full', zipName(job));
}

function paint(box, text) {
  const last = thread[thread.length - 1];
  if (last && last.role === 'ai') last.text = text;
  if (!box) return;
  box.classList.remove('is-typing');
  const tools = box.parentElement?.querySelector('.actions-row');
  if (tools) tools.hidden = false;
  const retry = tools?.querySelector('[data-act="retry"]');
  if (retry) retry.hidden = false;
  box.innerHTML = linkify(text);
  stickThread(false);
}

function setModel(box, model, quotaReset) {
  const last = [...thread].reverse().find((item) => item.role === 'ai');
  if (last) {
    if (model) last.model = model;
    if (quotaReset) last.quotaReset = quotaReset;
  }
  box?.parentElement?.querySelector('.model-tag')?.remove();
}

function showProposal(box, proposal) {
  const card = document.createElement('div');
  card.className = 'diff-card';
  const kind = proposal.kind === 'html' ? 'HTML' : 'CSS';
  card.innerHTML = `<div class="diff-label">${kind} before</div><pre>${esc(proposal.before)}</pre><div class="diff-label">${kind} after</div><pre>${esc(proposal.after)}</pre><button type="button" class="stage-btn">Apply</button>`;
  card.querySelector('button').onclick = async () => {
    try {
      const job = await api('/api/jobs/' + proposal.jobId + '/apply', {
        method: 'POST',
        body: JSON.stringify(proposal),
      });
      activeJob = job;
      showStage(job, { reload: true });
      card.querySelector('button').disabled = true;
      card.querySelector('button').textContent = 'Applied';
      toast('Applied.');
    } catch (err) {
      toast(err.message || 'That change was not applied.');
    }
  };
  box.appendChild(card);
  stickThread(false);
}

async function readEvents(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let event = 'message';
      const dataLines = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      try { onEvent(event, JSON.parse(dataLines.join(''))); } catch { /* skip a broken event */ }
    }
  }
}

async function runAgent({ token, trimmed, history, box, sent, ctrl, attachments }) {
  const items = attachments || [];
  const editing = activeJob?.status === 'done' && (
    /\b(change|edit|restyle|recolou?r|swap|replace|remo\w*|hide|delete)\b|\b(make|turn|move|update) (the|this|it|that)\b|\b(bigger|smaller|larger|bolder)\b/i.test(trimmed)
    || (/cookie|consent|banner/i.test(trimmed) && /\bremo/i.test(trimmed))
    || (/\b(detail|details|text|price|prices|content)\b/i.test(trimmed) && /\b(file|document|this|these)\b/i.test(trimmed) && /\b(swap|replace|use|take|apply|put|add|bring)\b/i.test(trimmed))
  );
  screenMode = editing ? 'edit' : '';
  if (activeJob) showStage(activeJob);
  try {
    const res = await agentFetch({
      message: trimmed,
      history,
      images: items.filter((item) => !item.kind || item.kind === 'image').slice(0, 2).map((item) => item.url || item),
      files: items.filter((item) => item.kind && item.kind !== 'image').slice(0, 3).map((item) => ({
        name: item.name,
        kind: item.kind,
        text: String(item.text || '').slice(0, 12000),
      })),
      activeJobId: activeJob?.id || null,
      rights_confirmed: true,
    }, ctrl.signal);
    const type = res.headers.get('content-type') || '';
    let data = null;
    if (!type.includes('text/event-stream')) {
      const raw = await res.text();
      let json = null;
      try { json = raw ? JSON.parse(raw) : null; } catch { json = { error: raw }; }
      if (!res.ok) throw new Error(json?.error || 'That did not send.');
      data = json;
    } else {
      let note = '';
      let streamed = '';
      let failed = '';
      await readEvents(res, (event, payload) => {
        if (event === 'meta') {
          note = payload.note || note;
          setModel(box, payload.model, payload.quotaReset);
        } else if (event === 'token') {
          streamed += payload.text || '';
          paint(box, note && !streamed.startsWith(note) ? `${note}\n\n${streamed}` : streamed);
        } else if (event === 'tool' && !streamed) {
          paint(box, note ? `${note}\n\nWorking on it.` : 'Working on it.');
        } else if (event === 'done') data = payload;
        else if (event === 'error') failed = payload.error || 'The chat did not answer.';
      });
      if (failed) throw new Error(failed);
    }
    if (!data) throw new Error('The chat did not answer.');
    if (data.upload) {
      const zip = items.find((item) => item.kind === 'zip' && item.file);
      if (!zip) throw new Error('Attach the ZIP again, then ask to put it on the preview.');
      reveal(box, data.reply || 'Opening that file on the phone.');
      const fd = new FormData();
      fd.append('file', zip.file, zip.file.name);
      fd.append('rights_confirmed', 'true');
      const job = await api('/api/upload', { method: 'POST', body: fd });
      if (token !== sendToken) return;
      activeJob = job;
      await refreshJobs();
      showStage(job);
      setSendMode(jobLive(job));
      poll(job.id, box);
      saveSession();
      return;
    }
    if (token !== sendToken) {
      if (jobLive(data.job)) await api('/api/jobs/' + data.job.id + '/stop', { method: 'POST', body: '{}' }).catch(() => {});
      return;
    }
    const reply = data.reply || 'Done.';
    reveal(box, reply);
    if (data.model) setModel(box, data.model, data.quotaReset);
    for (const proposal of data.proposals || []) showProposal(box, proposal);
    if (data.job && jobLive(data.job)) renderLive(box, data.job);
    if (data.action && data.job) {
      if (data.job.status === 'done') deliver(data.job, data.action);
      else deliverOnDone.set(data.job.id, data.action);
    }
    if (data.shareUrl) copyText(data.shareUrl, 'Live link copied.');
    if (data.job) {
      activeJob = data.job;
      if (data.edited && data.job.previewUrl) {
        const frame = stream.querySelector('iframe');
        if (frame) frame.src = data.job.previewUrl + '?t=' + Date.now();
      }
      showStage(data.job, { reload: !!data.edited });
      if (data.openGallery) {
        setView('images');
        loadGallery(data.job);
      }
      if (jobLive(data.job)) poll(data.job.id, box);
      else if (data.showPreview && data.job.status === 'done') {
        box.insertAdjacentHTML('beforeend', previewCard(data.job));
        wireCard(box, data.job);
        stickThread(false);
      }
      refreshJobs();
    }
    saveSession();
    setSendMode(jobLive(activeJob));
  } catch (err) {
    if (token !== sendToken || err.name === 'AbortError') {
      reveal(box, 'Stopped.');
      if (token === sendToken) setSendMode(jobLive(activeJob));
      return;
    }
    reveal(box, err.message || 'That did not send.');
    showRetry(sent);
    showRetry(box);
    setSendMode(false);
  } finally {
    if (inflight === ctrl) inflight = null;
    if (screenMode) {
      screenMode = '';
      if (activeJob) showStage(activeJob);
    }
  }
}

async function onSend(text, attachments) {
  const trimmed = text.trim();
  const items = attachments || [];
  if (!trimmed) return;
  if (!rightsOk(trimmed)) return;
  if (activeJob?.id && /\b(gallery|pictures|photos)\b|\bshow (the |its )?images\b/i.test(trimmed) && !/\bscan\b|https?:\/\//i.test(trimmed)) {
    say('user', trimmed);
    say('ai', 'Gallery is open.');
    setView('images');
    loadGallery(activeJob);
    return;
  }
  if (!/^[a-f0-9]{8}$/.test(chatId)) {
    chatId = newChatId();
    addressMode = 'push';
  }
  const history = thread.slice(-20).map((item) => ({ role: item.role, text: item.text }));
  const token = ++sendToken;
  setSendMode(true);
  const names = items.map((item) => item.name).filter(Boolean);
  const sent = say('user', names.length ? `${trimmed}\n${names.join(', ')}` : trimmed);
  const box = sayTyping();
  const ctrl = new AbortController();
  inflight = ctrl;
  await runAgent({ token, trimmed, history, box, sent, ctrl, attachments: items });
}

async function resendTurn(userRow, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) { toast('Write a message first.'); return; }
  if (!userRow) return;
  if (!rightsOk(trimmed)) return;
  if (!/^[a-f0-9]{8}$/.test(chatId)) {
    chatId = newChatId();
    addressMode = 'push';
  }
  const index = [...stream.querySelectorAll('.msg')].indexOf(userRow);
  if (index < 0) return;
  const bubbleEl = userRow.querySelector('.bubble');
  if (bubbleEl) {
    bubbleEl.hidden = false;
    bubbleEl.innerHTML = linkify(trimmed);
  }
  userRow.querySelector('.edit-box')?.remove();
  const tools = userRow.querySelector('.actions-row');
  if (tools) tools.hidden = false;
  if (thread[index]) thread[index].text = trimmed;
  cutAfter(userRow);
  const history = thread.slice(0, index).slice(-20).map((item) => ({ role: item.role, text: item.text }));
  const token = ++sendToken;
  setSendMode(true);
  const box = sayTyping();
  const ctrl = new AbortController();
  inflight = ctrl;
  await runAgent({ token, trimmed, history, box, sent: bubbleEl, ctrl });
}

document.getElementById('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (document.getElementById('sendBtn').classList.contains('stop')) {
    stopRunning();
    return;
  }
  const text = input.value;
  if (!text.trim()) {
    toast(refs.length ? 'Say what to do with that file.' : 'Type a message or paste a link first.');
    input.focus();
    return;
  }
  input.value = '';
  input.style.height = '';
  const outgoing = text.trim();
  const held = refs.slice();
  onSend(outgoing, held);
  refs.splice(0, refs.length);
  paintRefs();
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('composer').requestSubmit();
  }
});

let gallery = [];
let galleryJobId = '';
let galleryIndex = -1;
let galleryQuery = '';

function imageSrc(img) {
  if (img.src) return img.src;
  if (img.local && galleryJobId) return '/preview/' + galleryJobId + '/' + String(img.local).replace(/\\/g, '/');
  return '';
}

function setView(name) {
  const phone = document.getElementById('phoneView');
  const images = document.getElementById('galleryView');
  const phoneBtn = document.getElementById('viewPhone');
  const imageBtn = document.getElementById('viewImages');
  const onPhone = name !== 'images';
  phone?.classList.toggle('hidden', !onPhone);
  images?.classList.toggle('hidden', onPhone);
  phoneBtn?.classList.toggle('on', onPhone);
  imageBtn?.classList.toggle('on', !onPhone);
  phoneBtn?.setAttribute('aria-selected', onPhone ? 'true' : 'false');
  imageBtn?.setAttribute('aria-selected', onPhone ? 'false' : 'true');
  document.getElementById('galleryBtn')?.classList.toggle('on', !onPhone);
  if (onPhone) requestAnimationFrame(fitPhone);
}

function closeLightbox() {
  document.getElementById('lightbox')?.classList.add('hidden');
  syncVeil();
  const img = document.getElementById('lbImg');
  if (img) img.removeAttribute('src');
  galleryIndex = -1;
}

function openLightbox(index) {
  if (!gallery.length) return;
  galleryIndex = (index + gallery.length) % gallery.length;
  const img = gallery[galleryIndex];
  const src = imageSrc(img);
  const name = String(img.local || 'image').split('/').pop();
  const kb = Math.max(1, Math.round((img.size || 0) / 1024));
  const picture = document.getElementById('lbImg');
  const label = document.getElementById('lbName');
  const pos = document.getElementById('lbPos');
  if (picture) {
    picture.alt = name;
    picture.src = src;
  }
  if (label) label.textContent = `${name} · ${kb} KB`;
  const dim = document.getElementById('lbDim');
  if (dim) dim.textContent = '';
  if (picture) picture.onload = () => {
    if (dim && picture.naturalWidth) dim.textContent = `${picture.naturalWidth} × ${picture.naturalHeight}`;
  };
  if (pos) pos.textContent = `${galleryIndex + 1} / ${gallery.length}`;
  document.getElementById('lightbox')?.classList.remove('hidden');
  syncVeil();
  document.getElementById('lbPrev')?.classList.toggle('hidden', gallery.length < 2);
  document.getElementById('lbNext')?.classList.toggle('hidden', gallery.length < 2);
  const down = document.getElementById('lbDown');
  if (down) down.onclick = () => download(src, `${siteSlug(activeJob)}-${name}`);
  const copy = document.getElementById('lbCopy');
  if (copy) copy.onclick = () => copyText(absoluteLink(src), 'Copied.', copy);
  const ref = document.getElementById('lbRef');
  if (ref) ref.onclick = () => useGalleryReference(img, name);
}

async function useGalleryReference(img, name) {
  if (!activeJob || activeJob.status !== 'done') {
    toast('Save the page before attaching a reference.');
    return;
  }
  try {
    const res = await fetch(imageSrc(img));
    if (!res.ok) throw new Error('That image did not load.');
    const blob = await res.blob();
    addReference(new File([blob], name || 'reference.png', { type: blob.type || 'image/png' }));
  } catch (err) {
    toast(err.message || 'That image could not be attached.');
  }
}

function galleryKind(img) {
  if (img.kind === 'product' || img.kind === 'icon' || img.kind === 'photo') return img.kind;
  const name = String(img.local || '');
  if (/\.svg$|\.ico$/i.test(name)) return 'icon';
  if ((img.size || 0) > 0 && img.size < 12000) return 'icon';
  return 'photo';
}

function renderGallery(job) {
  const grid = document.getElementById('imgGrid');
  const note = document.getElementById('galleryNote');
  if (!grid) return;
  const query = galleryQuery;
  const visible = gallery.filter((img) => {
    if (!query) return true;
    const name = String(img.local || img.src || '').toLowerCase();
    return name.includes(query) || galleryKind(img).includes(query);
  });
  if (note) {
    const hiddenFiles = Number(job?.gallerySkipped) || 0;
    const countLabel = visible.length ? `${visible.length} image${visible.length === 1 ? '' : 's'}` : 'No images';
    note.textContent = hiddenFiles ? `${countLabel}. ${hiddenFiles} small files are hidden.` : countLabel;
  }
  if (!visible.length) {
    const waiting = job && (job.status === 'queued' || job.status === 'running');
    const empty = query ? 'No images match that search.' : (waiting ? 'Images appear when the scan finishes.' : 'This page has no saved images.');
    grid.innerHTML = `<p class="gallery-empty">${empty}</p>`;
    document.querySelectorAll('[data-jump]').forEach((btn) => { btn.disabled = true; });
    return;
  }
  const titles = { product: 'Products', photo: 'Photos', icon: 'Icons' };
  grid.innerHTML = ['product', 'photo', 'icon'].map((kind) => {
    const rows = visible.map((img) => ({ img, index: gallery.indexOf(img) })).filter((row) => galleryKind(row.img) === kind);
    if (!rows.length) return '';
    const cards = rows.map((row, n) => {
      const src = imageSrc(row.img);
      const kb = Math.max(1, Math.round((row.img.size || 0) / 1024));
      const label = `${titles[kind].replace(/s$/, '')} ${n + 1}`;
      return `<button type="button" class="shot" data-i="${row.index}">
        <img src="${esc(src)}" alt="${esc(label)}" loading="lazy">
        <span>${esc(label)} · ${kb} KB</span>
        <span class="shot-dim">Size loading</span>
      </button>`;
    }).join('');
    return `<h3 class="gal-label" id="gal-${kind}">${titles[kind]}</h3><div class="gal-block ${kind}">${cards}</div>`;
  }).join('');
  document.querySelectorAll('[data-jump]').forEach((btn) => {
    btn.disabled = !document.getElementById('gal-' + btn.dataset.jump);
  });
  grid.querySelectorAll('.shot img').forEach((img) => {
    img.addEventListener('load', () => {
      const dim = img.parentElement?.querySelector('.shot-dim');
      if (img.naturalWidth > 0 && img.naturalWidth < 8) {
        img.style.height = '24px';
      }
      if (dim && img.naturalWidth) dim.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
    });
    img.addEventListener('error', () => {
      const miss = document.createElement('span');
      miss.className = 'shot-miss';
      miss.textContent = 'Could not show this file';
      img.replaceWith(miss);
    });
  });
  grid.querySelectorAll('.shot').forEach((btn) => {
    btn.addEventListener('click', () => openLightbox(Number(btn.dataset.i)));
  });
}

async function loadGallery(job) {
  const countEl = document.getElementById('imageCount');
  if (!job?.id) {
    gallery = [];
    galleryJobId = '';
    if (countEl) {
      countEl.textContent = '';
      countEl.hidden = true;
    }
    renderGallery(job);
    return;
  }
  const tinyBox = document.getElementById('tinyImgs');
  const changedJob = galleryJobId !== job.id;
  if (changedJob) {
    galleryQuery = '';
    const search = document.getElementById('gallerySearch');
    if (search) search.value = '';
    if (tinyBox) tinyBox.checked = !!readPrefs().tiny;
  }
  const tiny = !!tinyBox?.checked;
  let data = { images: [] };
  try {
    data = await api('/api/jobs/' + encodeURIComponent(job.id) + '/images' + (tiny ? '?small=1' : ''));
  } catch {
    data = { images: [] };
  }
  if (activeJob?.id !== job.id) return;
  gallery = data.images || [];
  galleryJobId = job.id;
  job.gallerySkipped = Number(data.skipped) || 0;
  if (countEl) {
    countEl.hidden = false;
    countEl.textContent = String(gallery.length);
  }
  if (changedJob) closeLightbox();
  renderGallery(job);
  const autoKey = 'pb-gal:' + job.id;
  if (job.mode === 'images' && job.status === 'done' && gallery.length && !sessionStorage.getItem(autoKey)) {
    sessionStorage.setItem(autoKey, '1');
    setView('images');
  }
}

function resetChat() {
  activeJob = null;
  thread = [];
  clearSession();
  stream.innerHTML = '';
  const frame = document.getElementById('stage');
  if (frame) {
    frame.classList.add('hidden');
    frame.removeAttribute('src');
  }
  const empty = document.getElementById('stageEmpty');
  if (empty) {
    empty.classList.remove('hidden', 'busy');
    paintStageEmpty(null);
  }
  const frameTitle = document.getElementById('stage');
  if (frameTitle) frameTitle.title = 'Site preview';
  showingOriginal = false;
  const host = document.getElementById('stageHost');
  if (host) host.textContent = 'Preview';
  const title = document.getElementById('stageTitle');
  if (title) title.textContent = deviceLabel();
  const chatTitle = document.getElementById('chatTitle');
  if (chatTitle) chatTitle.textContent = 'New chat';
  chatId = '';
  paintChatId();
  closeLightbox();
  gallery = [];
  galleryJobId = '';
  const count = document.getElementById('imageCount');
  if (count) {
    count.textContent = '';
    count.hidden = true;
  }
  const note = document.getElementById('galleryNote');
  if (note) note.textContent = 'No capture open';
  const grid = document.getElementById('imgGrid');
  if (grid) grid.innerHTML = '<p class="gallery-empty">Open a capture to see its images.</p>';
  setView('phone');
  setWorking(false);
  setSendMode(false);
  syncStageActions(null);
}

function openChat(id) {
  if (!/^[a-f0-9]{8}$/.test(id) || id === chatId) return;
  addressMode = 'push';
  closeSettingsPage();
  closeDrawer();
  restoreSession(id);
}

document.getElementById('newChat').onclick = () => {
  closeSettingsPage();
  closeDrawer();
  closePop();
  addressMode = 'push';
  resetChat();
  refreshJobs();
  input.focus();
};
document.getElementById('menuBtn')?.addEventListener('click', () => {
  document.querySelector('.side')?.classList.add('open');
  document.getElementById('drawerBackdrop')?.classList.remove('hidden');
});
document.getElementById('drawerBackdrop')?.addEventListener('click', closeDrawer);
document.querySelectorAll('#paneSwitch [data-pane]').forEach((btn) => {
  btn.addEventListener('click', () => {
    setPane(btn.dataset.pane);
    if (btn.dataset.pane === 'preview') requestAnimationFrame(fitPhone);
  });
});
function openConnected(anchor) {
  const ready = activeJob?.status === 'done';
  showPop(`<h3>This page</h3><p class="menu-note">Scan a site, share a dev link, or download the page. An attached file stays in this chat until the prompt says what to do with it.</p><button class="menu-act" type="button" data-go="scan">Scan a site</button><button class="menu-act" type="button" data-go="upload">Attach a page</button><button class="menu-act" type="button" data-go="share" ${ready ? '' : 'disabled'}>Share a dev link</button><button class="menu-act" type="button" data-go="download" ${ready ? '' : 'disabled'}>Download</button><button class="menu-act" type="button" data-go="reload" ${ready ? '' : 'disabled'}>Reload preview</button><button class="menu-act" type="button" data-go="fresh">New chat</button>`, anchor, true);
  wirePop({
    scan: () => fillPrompt('scan '),
    upload: () => { closePop(); pickFile('ref'); },
    share: () => { closePop(); if (activeJob) openShare(activeJob); },
    download: () => { closePop(); if (activeJob?.id) download('/api/jobs/' + activeJob.id + '/zip?type=full', zipName(activeJob)); },
    reload: () => { closePop(); reloadPreview(); },
    fresh: () => {
      closePop();
      addressMode = 'push';
      resetChat();
      refreshJobs();
      input.focus();
    },
  });
}
document.getElementById('homeNav').onclick = (event) => {
  closeSettingsPage();
  closeDrawer();
  openConnected(event.currentTarget);
};
function filterChats() {
  const box = document.getElementById('chatSearch');
  const q = box?.value.trim().toLowerCase() || '';
  const clear = document.getElementById('searchClear');
  const count = document.getElementById('searchCount');
  if (clear) clear.hidden = !q;
  let shown = 0;
  document.querySelectorAll('.h-row').forEach((el) => {
    const hit = !q || el.innerText.toLowerCase().includes(q);
    el.hidden = !hit;
    if (hit) shown += 1;
  });
  if (count) {
    count.hidden = !q;
    count.textContent = `${shown} chat${shown === 1 ? '' : 's'}`;
  }
  let empty = document.getElementById('searchEmpty');
  if (q && !shown) {
    if (!empty) {
      empty = document.createElement('p');
      empty.id = 'searchEmpty';
      empty.className = 'group';
      historyEl.appendChild(empty);
    }
    empty.textContent = 'No chats match that.';
    empty.hidden = false;
  } else if (empty) empty.hidden = true;
}
document.getElementById('chatSearch')?.addEventListener('input', filterChats);
document.getElementById('searchClear')?.addEventListener('click', () => {
  const box = document.getElementById('chatSearch');
  if (box) box.value = '';
  filterChats();
  box?.focus();
});
let lastInnerWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (columnDrag) return;
  if (window.innerWidth > 1099 && lastInnerWidth > 1099 && document.querySelector('.app')?.classList.contains('working')) {
    const saved = readWidths();
    if (saved.chat) {
      const fit = fitTrio(saved.side, saved.chat, saved.stage, window.innerWidth - 20);
      writeWidths(fit);
    }
  }
  lastInnerWidth = window.innerWidth;
  applyColumns();
});
function bindStarters() {
  document.querySelectorAll('[data-prompt]').forEach((btn) => {
    btn.onclick = () => {
      const prompt = btn.getAttribute('data-prompt') || '';
      if (btn.dataset.needs === 'page' && activeJob?.status !== 'done') {
        toast('Open a page first. Share and download use that page.');
        return;
      }
      onSend(prompt);
    };
  });
}

function paintStarters() {
  const done = jobs.some((job) => job.status === 'done');
  const items = done
    ? [
      ['Revise the headings', 'On the open page', 'Change the headings'],
      ['Download the images', 'From this page', 'Download the images'],
      ['Share this page', 'Create a view link', 'Share this page'],
    ]
    : [
      ['Scan a sample page', 'A simple public page', 'scan example.com'],
      ['Scan a live site', 'Capture the page as it appears', 'scan https://www.apple.com'],
      ['Collect the images', 'Save the pictures from a page', 'images only https://www.wikipedia.org'],
    ];
  const html = items.map(([title, sub, prompt]) => `<button type="button" data-prompt="${esc(prompt)}"><strong>${esc(title)}</strong><span>${esc(sub)}</span></button>`).join('');
  const home = document.getElementById('starters');
  if (home) home.innerHTML = html;
  bindStarters();
}
paintStarters();

function lastUserText() {
  return thread.filter((item) => item.role === 'user').slice(-1)[0]?.text || '';
}

let toastTimer = 0;
function toast(text, opts = {}) {
  const el = document.getElementById('toast');
  const label = document.getElementById('toastText');
  const retry = document.getElementById('toastRetry');
  const close = document.getElementById('toastClose');
  if (!el) return;
  if (label) label.textContent = text;
  else el.textContent = text;
  el.classList.toggle('is-error', !!opts.error);
  el.classList.remove('hidden');
  if (retry) {
    retry.hidden = typeof opts.retry !== 'function';
    retry.onclick = typeof opts.retry === 'function' ? () => { el.classList.add('hidden'); opts.retry(); } : null;
  }
  if (close) close.onclick = () => el.classList.add('hidden');
  clearTimeout(toastTimer);
  if (!opts.error) toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

function flashCopied(button) {
  if (!button) return;
  const svg = button.querySelector('svg');
  button.classList.add('is-copied');
  if (svg) {
    const previous = svg.innerHTML;
    svg.innerHTML = '<path d="M5 12.5 9.2 16.5 19 7"/>';
    setTimeout(() => {
      svg.innerHTML = previous;
      button.classList.remove('is-copied');
    }, 1200);
    return;
  }
  const previous = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => {
    button.textContent = previous;
    button.classList.remove('is-copied');
  }, 1200);
}

async function copyText(text, ok = 'Copied.', button) {
  const value = String(text || '').trim();
  if (!value) { toast('Nothing to copy.'); return; }
  try {
    await navigator.clipboard.writeText(value);
    flashCopied(button);
    toast(ok);
    return;
  } catch { /* fall through */ }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (copied) flashCopied(button);
    toast(copied ? ok : 'Could not copy that.');
  } catch {
    toast('Could not copy that.');
  }
}

function closePop() {
  pop.classList.add('hidden');
  pop.classList.remove('account-menu');
  syncVeil();
}

function confirmAsk({ title, body, ok = 'Confirm', danger = false }) {
  const root = document.getElementById('confirm');
  const heading = document.getElementById('confirmTitle');
  const copy = document.getElementById('confirmBody');
  const yes = document.getElementById('confirmYes');
  if (!root || !yes) return Promise.resolve(true);
  if (heading) heading.textContent = title;
  if (copy) copy.textContent = body;
  yes.textContent = ok;
  yes.classList.toggle('danger', !!danger);
  root.classList.remove('hidden');
  syncVeil();
  yes.focus();
  return new Promise((resolve) => {
    const finish = (answer) => {
      root.classList.add('hidden');
      syncVeil();
      root.querySelectorAll('[data-yes], [data-no]').forEach((btn) => { btn.onclick = null; });
      resolve(answer);
    };
    root.querySelectorAll('[data-yes]').forEach((btn) => { btn.onclick = () => finish(true); });
    root.querySelectorAll('[data-no]').forEach((btn) => { btn.onclick = () => finish(false); });
  });
}

function showPop(html, anchor, wide) {
  pop.classList.remove('account-menu');
  pop.classList.toggle('wide', !!wide);
  pop.innerHTML = html;
  pop.classList.remove('hidden');
  syncVeil();
  const rect = (anchor || document.getElementById('helpBtn')).getBoundingClientRect();
  const side = document.querySelector('.side').getBoundingClientRect();
  const inSide = rect.left >= side.left - 2 && rect.right <= side.right + 2;
  const width = wide ? Math.min(400, window.innerWidth - 24) : (inSide ? Math.min(220, Math.max(180, side.width - 16)) : 220);
  let left = inSide ? side.left + 8 : rect.left;
  if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12;
  pop.style.width = width + 'px';
  pop.style.left = Math.max(12, left) + 'px';
  pop.style.bottom = 'auto';
  pop.style.top = '12px';
  requestAnimationFrame(() => {
    const box = pop.getBoundingClientRect();
    const composer = document.getElementById('composer')?.getBoundingClientRect();
    const overComposer = composer && rect.top >= composer.top - 8 && rect.bottom <= composer.bottom + 28;
    let top = overComposer ? composer.top - box.height - 12 : rect.top - box.height - 8;
    if (top < 12) top = Math.min(rect.bottom + 8, window.innerHeight - box.height - 12);
    pop.style.top = Math.max(12, top) + 'px';
  });
}

function wirePop(map) {
  pop.querySelectorAll('[data-go]').forEach((btn) => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const fn = map[btn.dataset.go];
      if (fn) fn(btn);
    };
  });
}

function fillPrompt(text) {
  input.value = text;
  input.focus();
  input.setSelectionRange(text.length, text.length);
  closePop();
}

async function removeCapture(id) {
  const job = jobs.find((item) => item.id === id);
  const name = String(job?.source_url || 'this capture').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const yes = await confirmAsk({
    title: 'Remove this capture?',
    body: `${name} and its saved files will be deleted from this computer.`,
    ok: 'Remove',
    danger: true,
  });
  if (!yes) return;
  goneIds.add(id);
  jobs = jobs.filter((item) => item.id !== id);
  try {
    const sessionId = chatIdFor(id);
    localStorage.removeItem(threadKey(id));
    localStorage.removeItem(chatMapKey(id));
    if (sessionId) localStorage.removeItem(sessionStoreKey(sessionId));
  } catch { /* the capture is already gone */ }
  if (activeJob?.id === id) resetChat();
  else renderHistory();
  closePop();
  toast('Capture removed.');
  api('/api/jobs/' + encodeURIComponent(id), { method: 'DELETE' }).catch((err) => {
    goneIds.delete(id);
    toast(err.message);
    refreshJobs();
  });
}

function dropChat(id) {
  try {
    localStorage.removeItem(sessionStoreKey(id));
    if (localStorage.getItem(sessionPointerKey()) === id) localStorage.removeItem(sessionPointerKey());
  } catch { /* already gone */ }
  if (chatId === id) resetChat();
  else renderHistory();
  toast('Chat removed.');
}

async function clearHistory() {
  jobs.forEach((job) => goneIds.add(job.id));
  jobs = [];
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(userPrefix())) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch { /* history is already cleared on the server */ }
  resetChat();
  renderHistory();
  closePop();
  toast('History cleared.');
  api('/api/jobs', { method: 'DELETE' }).catch((err) => {
    toast(err.message);
    refreshJobs();
  });
}

async function clearOpenChat() {
  const yes = await confirmAsk({
    title: 'Clear this chat?',
    body: 'This removes the open chat for this sign-in.',
    ok: 'Clear',
    danger: true,
  });
  if (!yes) return;
  try {
    if (chatId) localStorage.removeItem(sessionStoreKey(chatId));
    localStorage.removeItem(sessionPointerKey());
  } catch {}
  const gone = chatId;
  resetChat();
  if (gone) {
    try { localStorage.removeItem(sessionStoreKey(gone)); } catch { /* already gone */ }
  }
  renderHistory();
  toast('Chat cleared.');
}

async function askClear() {
  const count = jobs.length + listLocalChats().filter((data) => !data.jobId || !jobs.some((job) => job.id === data.jobId)).length;
  if (!count) { toast('History is already empty.'); return; }
  const yes = await confirmAsk({
    title: 'Clear all history?',
    body: 'This removes every chat and capture for this sign-in.',
    ok: `Clear all ${count}`,
    danger: true,
  });
  if (yes) await clearHistory();
}

const THEME_ICONS = {
  system: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  light: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>',
  dark: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z"/></svg>',
};

function themeSegHtml() {
  return `<div class="theme-seg" role="group" aria-label="Theme">${['system', 'light', 'dark'].map((name) => {
    const label = name[0].toUpperCase() + name.slice(1);
    return `<button type="button" data-theme="${name}" data-tip="${label}" aria-label="${label} theme">${THEME_ICONS[name]}</button>`;
  }).join('')}</div>`;
}

function paintThemeButtons(theme) {
  document.querySelectorAll('.theme-seg [data-theme]').forEach((btn) => {
    const on = btn.dataset.theme === theme;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function syncSettingsControls(prefs) {
  [
    ['prefSuggestions', prefs.suggestions],
    ['prefSound', prefs.sound],
    ['prefTiny', prefs.tiny],
  ].forEach(([id, on]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('on', !!on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  paintSideButtons(prefs.chatSide === 'right' ? 'right' : 'left');
  paintThemeButtons(prefs.theme);
}

function paintSideButtons(side) {
  document.querySelectorAll('#prefChatSide [data-side]').forEach((btn) => {
    const on = btn.dataset.side === side;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function updateHistoryLead() {
  const lead = document.getElementById('historyLead');
  if (!lead) return;
  const extra = listLocalChats().filter((data) => !data.jobId || !jobs.some((job) => job.id === data.jobId)).length;
  const count = jobs.length + extra;
  lead.textContent = count
    ? `${count} chat${count === 1 ? '' : 's'} for this sign-in.`
    : 'No chats for this sign-in yet.';
}

const PANEL_TITLES = { account: 'Account', interface: 'Interface', capture: 'Capture', history: 'History' };

function showSettingsPanel(name) {
  const panel = PANEL_TITLES[name] ? name : 'interface';
  document.querySelectorAll('.set-panel').forEach((el) => {
    el.classList.toggle('hidden', el.id !== 'panel-' + panel);
  });
  document.querySelectorAll('.set-link').forEach((el) => {
    el.classList.toggle('on', el.dataset.panel === panel);
  });
  const top = document.getElementById('settingsTop');
  if (top) top.textContent = PANEL_TITLES[panel];
  if (panel === 'history') updateHistoryLead();
  if (panel === 'account') paintAccountPage();
}

function paintAccountPage() {
  const email = readAuth()?.email || 'This computer';
  const label = document.getElementById('accountPageEmail');
  const line = document.getElementById('accountEmail');
  if (label) label.textContent = email ? 'Signed in as this email.' : 'Not signed in';
  if (line) line.textContent = email;
  const images = document.getElementById('acctImages');
  if (images) images.disabled = !activeJob;
}

function openSettingsPage(panel) {
  closePop();
  document.getElementById('settingsShell')?.classList.remove('hidden');
  document.body.classList.add('settings-open');
  syncSettingsControls(readPrefs());
  showSettingsPanel(panel || 'interface');
  markHome();
  document.getElementById('settingsBack')?.focus();
}

function closeSettingsPage() {
  document.getElementById('settingsShell')?.classList.add('hidden');
  document.body.classList.remove('settings-open');
  markHome();
}

function openAccount() {
  closePop();
  openSettingsPage('account');
  document.getElementById('feedbackText')?.closest('form')?.scrollIntoView?.({ block: 'nearest' });
}

function readFeedback() {
  try {
    const list = JSON.parse(localStorage.getItem('pb-feedback') || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function renderFeedback() {
  const list = document.getElementById('feedbackList');
  if (!list) return;
  const items = readFeedback();
  const empty = document.getElementById('feedbackEmpty');
  if (empty) empty.hidden = items.length > 0;
  list.innerHTML = items.map((item) => `<li>${esc(item.text)}</li>`).join('');
}

function openFeedback() {
  openAccount();
  renderFeedback();
  const box = document.getElementById('feedbackText');
  if (box) {
    box.value = '';
    box.focus();
  }
}

function closeFeedback() {
  const box = document.getElementById('feedbackText');
  if (box) box.value = '';
}

function openHelp(e) {
  showPop(`<h3>Help</h3><p class="menu-note">Scan a site, edit it in chat, share a dev link, or download the page. Home, attach, share, download, and reload stay on this chat.</p><button class="menu-act" type="button" data-go="focus">Write a scan</button><button class="menu-act" type="button" data-go="sample">Scan example.com</button><button class="menu-act" type="button" data-go="file">Attach a saved page</button><button class="menu-act" type="button" data-go="images" ${activeJob ? '' : 'disabled'}>Show images</button><button class="menu-act" type="button" data-go="open" ${activeJob?.status === 'done' ? '' : 'disabled'}>Open the preview</button>`, e.currentTarget);
  wirePop({
    focus: () => fillPrompt('scan '),
    sample: () => { closePop(); onSend('scan example.com'); },
    file: () => { closePop(); pickFile('ref'); },
    images: () => {
      closePop();
      if (!activeJob) { toast('Open a capture first.'); return; }
      setView('images');
      loadGallery(activeJob);
    },
    open: () => {
      if (activeJob?.previewUrl) window.open(activeJob.previewUrl, '_blank', 'noopener');
      else toast('The preview is not ready yet.');
      closePop();
    },
  });
}

function openPlus(e) {
  showPop(`<h3>This page</h3><p class="menu-note">Scan a site, attach a file, then say what to do with it. Share and download use the page on the phone.</p><form class="scan-url" id="scanUrlForm"><input id="scanUrl" type="text" inputmode="url" placeholder="https://example.com" autocomplete="off" spellcheck="false" aria-label="Site to scan"><button class="menu-act" type="submit">Scan</button></form><button class="menu-act" type="button" data-go="images">Collect images only</button><button class="menu-act" type="button" data-go="file">Attach a page</button><button class="menu-act" type="button" data-go="share" ${activeJob?.status === 'done' ? '' : 'disabled'}>Share a dev link</button><button class="menu-act" type="button" data-go="download" ${activeJob?.status === 'done' ? '' : 'disabled'}>Download</button><button class="menu-act" type="button" data-go="reload" ${activeJob?.status === 'done' ? '' : 'disabled'}>Reload preview</button>`, e.currentTarget, true);
  const field = document.getElementById('scanUrl');
  document.getElementById('scanUrlForm')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const raw = field?.value.trim() || '';
    if (!raw) { field?.focus(); return; }
    closePop();
    onSend(`scan ${raw}`);
  });
  wirePop({
    images: () => {
      const raw = field?.value.trim();
      if (raw) { closePop(); onSend(`images only ${raw}`); }
      else fillPrompt('images only ');
    },
    file: () => { closePop(); pickFile('ref'); },
    share: () => { closePop(); if (activeJob) openShare(activeJob); },
    download: () => { closePop(); if (activeJob?.id) download('/api/jobs/' + activeJob.id + '/zip?type=full', zipName(activeJob)); },
    reload: () => { closePop(); reloadPreview(); },
  });
  setTimeout(() => field?.focus(), 40);
}

function openDevice(e) {
  const laid = `The frame is ${deviceLabel()} pixels wide. Zoom sits next to Desktop, Tablet, and Phone. Chrome hides the black island.`;
  showPop(`<h3>${esc(deviceLabel())}</h3><p class="menu-note">${laid}</p><button class="menu-act" type="button" data-go="fit">Fit the preview</button><button class="menu-act" type="button" data-go="open" ${activeJob?.status === 'done' ? '' : 'disabled'}>Open ${activeJob ? esc(siteSlug(activeJob)) : 'the preview'}</button>`, e.currentTarget);
  wirePop({
    fit: () => {
      if (!document.querySelector('.app')?.classList.contains('working')) toast('Open a chat to see the phone.');
      else { setZoom('fit'); toast('Preview fitted.'); }
      closePop();
    },
    open: () => {
      if (activeJob?.previewUrl && activeJob.status === 'done') window.open(activeJob.previewUrl, '_blank', 'noopener');
      else toast('The preview is not ready yet.');
      closePop();
    },
  });
}

function openThread(e) {
  showPop(`<h3>This chat</h3><p class="menu-note">${esc(chatLink())}</p><button class="menu-act" type="button" data-go="fresh">New chat</button><button class="menu-act" type="button" data-go="id">Copy chat link</button><button class="menu-act" type="button" data-go="images" ${activeJob ? '' : 'disabled'}>Show images</button><button class="menu-act" type="button" data-go="copy" ${activeJob?.status === 'done' ? '' : 'disabled'}>Copy preview link</button><button class="menu-act" type="button" data-go="share" ${activeJob?.status === 'done' ? '' : 'disabled'}>Share</button><button class="menu-act danger" type="button" data-go="remove" ${activeJob ? '' : 'disabled'}>Remove this capture</button>`, e.currentTarget, true);
  wirePop({
    fresh: () => { closePop(); document.getElementById('newChat').click(); },
    id: (btn) => { copyText(chatLink(), 'Copied.', btn); },
    images: () => {
      closePop();
      if (!activeJob) { toast('Open a capture first.'); return; }
      setView('images');
      loadGallery(activeJob);
    },
    copy: (btn) => { if (activeJob?.previewUrl) copyText(absoluteLink(activeJob.previewUrl), 'Copied.', btn); else toast('The preview is not ready yet.'); },
    share: () => { closePop(); if (activeJob) openShare(activeJob); },
    remove: () => { if (activeJob) removeCapture(activeJob.id); },
  });
}

document.getElementById('plusBtn').onclick = openPlus;
function pickFile(mode) {
  const input = document.getElementById('file');
  if (!input) return;
  input.dataset.mode = mode;
  input.accept = mode === 'ref'
    ? 'image/png,image/jpeg,image/webp,image/gif,.html,.htm,.zip,.txt,.md,.csv,.json,.pdf,text/plain,text/html,application/pdf'
    : '.html,.htm,.zip,text/html';
  input.click();
}
document.getElementById('clipBtn').onclick = () => pickFile('ref');
document.getElementById('stageUpload')?.addEventListener('click', () => openConnected(document.getElementById('homeNav')));
const refs = [];

function paintRefs() {
  const row = document.getElementById('refRow');
  if (!row) return;
  row.hidden = refs.length === 0;
  row.innerHTML = refs.map((item, index) => {
    const body = item.kind === 'image'
      ? `<img src="${item.url}" alt="">`
      : `<span>${esc(item.name)}</span>`;
    return `<div class="ref-chip${item.kind === 'image' ? '' : ' file'}">${body}<button type="button" data-ref="${index}" aria-label="Remove ${esc(item.name)}">×</button></div>`;
  }).join('');
  row.querySelectorAll('[data-ref]').forEach((btn) => {
    btn.onclick = () => {
      refs.splice(Number(btn.dataset.ref), 1);
      paintRefs();
    };
  });
}

async function readableFile(file) {
  const name = file.name || '';
  if (/\.pdf$/i.test(name) || file.type === 'application/pdf') {
    const raw = new TextDecoder('latin1').decode(await file.arrayBuffer());
    const parts = [];
    const re = /\(((?:\\[0-7]{1,3}|\\.|[^\\)]){2,200})\)/g;
    let match;
    while ((match = re.exec(raw)) && parts.join(' ').length < 12000) {
      const text = match[1]
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '')
        .replace(/\\t/g, ' ')
        .replace(/\\([()\\])/g, '$1')
        .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
      if (/[A-Za-z]{3,}/.test(text)) parts.push(text);
    }
    return parts.join(' ').replace(/[^\S\n]+/g, ' ').trim().slice(0, 12000);
  }
  return (await file.text()).slice(0, 12000);
}

async function addReference(file) {
  if (!file) return;
  if (refs.length >= 3) { toast('Three files at a time.'); return; }
  const name = file.name || 'file';
  const image = /^image\//.test(file.type || '') || /\.(png|jpe?g|webp|gif)$/i.test(name);
  if (image) {
    if (file.size > 1500000) { toast('That image is over 1.5 MB.'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      refs.push({ kind: 'image', name, url: String(reader.result || '') });
      paintRefs();
    };
    reader.readAsDataURL(file);
    return;
  }
  if (/\.zip$/i.test(name)) {
    if (file.size > 8000000) { toast('That ZIP is over 8 MB.'); return; }
    refs.push({ kind: 'zip', name, file, text: '' });
    paintRefs();
    return;
  }
  const html = /\.html?$/i.test(name);
  const doc = html || /\.(txt|md|csv|json)$/i.test(name) || /\.pdf$/i.test(name) || /text\/|json|pdf/i.test(file.type || '');
  if (!doc) {
    toast('Use an image, HTML, ZIP, text, or PDF file.');
    return;
  }
  if (file.size > 1500000) { toast('That file is over 1.5 MB.'); return; }
  const text = await readableFile(file);
  if (/\.pdf$/i.test(name) && !text) toast('That PDF had no readable text. A text file works better.');
  refs.push({ kind: html ? 'html' : 'doc', name, text });
  paintRefs();
}

document.getElementById('file').onchange = (e) => {
  const file = e.target.files?.[0];
  const mode = e.target.dataset.mode || 'page';
  e.target.value = '';
  if (!file) return;
  if (mode === 'ref') addReference(file);
  else uploadFile(file).catch((err) => say('ai', err.message));
};

const chatPane = document.querySelector('.chat');
const dropOverlay = document.getElementById('dropOverlay');
['dragenter', 'dragover'].forEach((name) => {
  chatPane?.addEventListener(name, (event) => {
    if (![...event.dataTransfer?.items || []].some((item) => item.kind === 'file')) return;
    event.preventDefault();
    if (dropOverlay) dropOverlay.hidden = false;
  });
});
chatPane?.addEventListener('dragleave', (event) => {
  if (event.relatedTarget && chatPane.contains(event.relatedTarget)) return;
  if (dropOverlay) dropOverlay.hidden = true;
});
chatPane?.addEventListener('drop', (event) => {
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  if (dropOverlay) dropOverlay.hidden = true;
  [...event.dataTransfer.files].slice(0, 3).forEach(addReference);
});
document.getElementById('helpBtn').onclick = openHelp;
document.getElementById('helpPill').onclick = openHelp;
document.getElementById('helpTop').onclick = openHelp;
document.getElementById('moonBtn').onclick = () => document.body.classList.remove('dim');
document.getElementById('gearBtn').onclick = () => openSettingsPage('interface');
document.getElementById('meBtn').onclick = openAccount;
document.getElementById('accountSide').onclick = openAccount;
document.getElementById('newChatSide').onclick = () => document.getElementById('newChat').click();
document.getElementById('accountPill').onclick = openAccount;
document.getElementById('settingsBack').onclick = closeSettingsPage;
document.querySelectorAll('.set-link').forEach((btn) => {
  btn.onclick = () => showSettingsPanel(btn.dataset.panel);
});
document.getElementById('prefSuggestions').onclick = () => {
  writePrefs({ suggestions: !readPrefs().suggestions });
};
document.getElementById('prefSound').onclick = () => {
  writePrefs({ sound: !readPrefs().sound });
};
document.getElementById('prefTiny').onclick = () => {
  writePrefs({ tiny: !readPrefs().tiny });
};
document.getElementById('prefPassword').onclick = () => {
  const form = document.getElementById('passForm');
  form.hidden = false;
  document.getElementById('passCurrent')?.focus();
};
document.getElementById('passCancel').onclick = () => {
  const form = document.getElementById('passForm');
  form.reset();
  form.hidden = true;
  const error = document.getElementById('passError');
  if (error) { error.hidden = true; error.textContent = ''; }
};
document.getElementById('passForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const current = document.getElementById('passCurrent').value;
  const next = document.getElementById('passNext').value;
  const confirm = document.getElementById('passConfirm').value;
  const error = document.getElementById('passError');
  const showError = (text) => { error.textContent = text; error.hidden = false; };
  error.hidden = true;
  if (next.length < 6) { showError('Use a password of at least 6 characters.'); return; }
  if (next !== confirm) { showError('Those new passwords do not match.'); return; }
  const yes = await confirmAsk({ title: 'Change password?', body: 'The next sign-in uses the new password.', ok: 'Change' });
  if (!yes) return;
  try {
    const session = await api('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ current, password: next, confirm }),
    });
    if (session?.access_token) saveAuth(session);
    e.target.reset();
    e.target.hidden = true;
    toast('Password changed.');
  } catch (err) {
    showError(err.message || 'That password was not saved.');
  }
});
document.getElementById('prefSignOut').onclick = async () => {
  const yes = await confirmAsk({ title: 'Sign out?', body: 'You will need your email and password to open Protobuild again.', ok: 'Sign out' });
  if (!yes) return;
  try { sessionStorage.removeItem(rightsKey()); } catch {}
  localStorage.removeItem('pb-auth');
  location.href = '/';
};
document.getElementById('prefChatSide').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-side]');
  if (!btn) return;
  const side = btn.dataset.side === 'right' ? 'right' : 'left';
  if (side === (readPrefs().chatSide === 'right' ? 'right' : 'left')) return;
  writePrefs({ chatSide: side });
});
function onThemeClick(e) {
  const btn = e.target.closest('[data-theme]');
  if (!btn || btn.dataset.theme === readPrefs().theme) return;
  writePrefs({ theme: btn.dataset.theme });
}
document.getElementById('settingsTheme')?.addEventListener('click', onThemeClick);
document.getElementById('accountTheme')?.addEventListener('click', onThemeClick);
document.getElementById('acctSettings').onclick = () => showSettingsPanel('interface');
document.getElementById('acctUpload').onclick = () => { closeSettingsPage(); openConnected(document.getElementById('homeNav')); };
document.getElementById('captureUpload')?.addEventListener('click', () => { closeSettingsPage(); openConnected(document.getElementById('homeNav')); });
document.getElementById('acctWidths').onclick = () => document.getElementById('prefResetWidths').click();
document.getElementById('acctImages').onclick = () => {
  if (!activeJob) { toast('Open a capture first.'); return; }
  closeSettingsPage();
  setView('images');
  loadGallery(activeJob);
};
document.getElementById('acctSignOut').onclick = () => document.getElementById('prefSignOut').click();
document.getElementById('sideTheme').addEventListener('click', onThemeClick);
document.getElementById('prefResetWidths').onclick = async () => {
  const yes = await confirmAsk({ title: 'Reset column widths?', body: 'History, chat, and the preview go back to their default widths.', ok: 'Reset' });
  if (yes) resetColumnWidths();
};
document.getElementById('prefRemove').onclick = () => {
  if (activeJob?.id) { removeCapture(activeJob.id); return; }
  if (thread.some((item) => item && item.text)) { clearOpenChat(); return; }
  toast('Open a chat first.');
};
document.getElementById('prefClear').onclick = (e) => askClear(e.currentTarget);
document.getElementById('feedbackForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const box = document.getElementById('feedbackText');
  const text = box?.value.trim();
  if (!text) { toast('Write a note first.'); return; }
  const items = readFeedback();
  items.unshift({ text, at: new Date().toISOString() });
  localStorage.setItem('pb-feedback', JSON.stringify(items.slice(0, 20)));
  if (box) box.value = '';
  renderFeedback();
  toast('Saved on this computer.');
});
document.getElementById('feedbackCancel').onclick = closeFeedback;
document.getElementById('bellBtn').onclick = (e) => {
  const running = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
  const body = running.length
    ? running.map((job) => esc((job.source_url || 'Upload').replace(/^https?:\/\//, ''))).join('<br>')
    : 'Nothing is running.';
  showPop(`<h3>Alerts</h3><p class="menu-note">${body}</p><button class="menu-act" type="button" data-go="open" ${running[0] ? '' : 'disabled'}>Open the running capture</button>`, e.currentTarget);
  wirePop({
    open: () => { if (running[0]) { closePop(); openJob(running[0].id); } },
  });
};
document.getElementById('chatMenu').onclick = openThread;
document.getElementById('chatId')?.addEventListener('click', (event) => {
  if (chatId) copyText(chatLink(), 'Copied.', event.currentTarget);
});
document.getElementById('threadMenu').onclick = openThread;
document.getElementById('viewPhone').onclick = () => setView('phone');
document.querySelectorAll('#deviceSwitch [data-device]').forEach((btn) => {
  btn.addEventListener('click', () => {
    setView('phone');
    applyDevice(btn.dataset.device);
  });
});
applyDevice();
document.getElementById('viewImages').onclick = () => {
  if (!activeJob) { toast('Open a capture to see its images.'); return; }
  setView('images');
  loadGallery(activeJob);
};
document.getElementById('galleryBtn')?.addEventListener('click', () => {
  if (!activeJob) { toast('Open a capture to see its images.'); return; }
  const open = !document.getElementById('galleryView')?.classList.contains('hidden');
  if (open) { setView('phone'); return; }
  setView('images');
  loadGallery(activeJob);
});
document.getElementById('tinyImgs').addEventListener('change', () => {
  if (activeJob) loadGallery(activeJob);
});
document.getElementById('gallerySearch')?.addEventListener('input', (event) => {
  galleryQuery = String(event.target.value || '').trim().toLowerCase();
  if (activeJob) renderGallery(activeJob);
});
function needCapture(what) {
  if (!activeJob) {
    toast(`Nothing to ${what} yet. Paste a link first.`);
    return false;
  }
  if (activeJob.status === 'blocked' || activeJob.status === 'failed') {
    toast(activeJob.error || 'That capture did not finish. Try another link, or attach a saved page.');
    return false;
  }
  if (activeJob.status !== 'done') {
    toast('The preview is not ready yet.');
    return false;
  }
  return true;
}

document.querySelector('#stageBar [data-open]').onclick = () => {
  if (!needCapture('open')) return;
  if (!activeJob.previewUrl) { toast('The preview is not ready yet.'); return; }
  window.open(activeJob.previewUrl, '_blank', 'noopener');
};
document.querySelector('#stageBar [data-zip]').onclick = () => {
  if (!needCapture('download')) return;
  download('/api/jobs/' + activeJob.id + '/zip?type=full', zipName(activeJob));
};
document.querySelectorAll('[data-share-days]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!needCapture('share')) return;
    const days = Number(btn.dataset.shareDays);
    share(activeJob, days);
  });
});
function reloadPreview() {
  if (!activeJob || activeJob.status !== 'done') {
    toast('Not ready.');
    return;
  }
  const frame = document.getElementById('stage');
  const btn = document.getElementById('reloadBtn');
  if (!frame) return;
  const next = previewAddress(activeJob, true);
  btn?.classList.add('is-spin');
  const stop = () => btn?.classList.remove('is-spin');
  frame.addEventListener('load', stop, { once: true });
  window.setTimeout(stop, 4000);
  frame.src = next;
}
document.getElementById('reloadBtn')?.addEventListener('click', reloadPreview);
document.getElementById('reloadExtra')?.addEventListener('click', reloadPreview);
document.getElementById('winReload')?.addEventListener('click', reloadPreview);
document.getElementById('zoomOut')?.addEventListener('click', () => stepZoom(-1));
document.getElementById('zoomIn')?.addEventListener('click', () => stepZoom(1));
document.getElementById('zoomFit')?.addEventListener('click', () => setZoom('fit'));
paintZoom();
let showChrome = localStorage.getItem('pb-chrome') !== 'off';
function applyChrome() {
  document.getElementById('phoneView')?.classList.toggle('chrome-off', !showChrome);
  const btn = document.getElementById('chromeBtn');
  if (!btn) return;
  btn.classList.toggle('on', showChrome);
  btn.setAttribute('aria-pressed', showChrome ? 'true' : 'false');
  setBtnLabel(btn, showChrome ? 'Chrome' : 'Chrome off');
  btn.dataset.tip = showChrome ? 'Hide the phone chrome' : 'Show the phone chrome';
}
document.getElementById('chromeBtn')?.addEventListener('click', () => {
  showChrome = !showChrome;
  localStorage.setItem('pb-chrome', showChrome ? 'on' : 'off');
  applyChrome();
});
applyChrome();
function applyHistory(on) {
  document.documentElement.dataset.history = on ? 'on' : 'off';
  localStorage.setItem('pb-history', on ? 'on' : 'off');
  const btn = document.getElementById('historyToggle');
  if (btn) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', on ? 'Hide history' : 'Show history');
    btn.dataset.tip = on ? 'Hide history' : 'Show history';
  }
  applyColumns();
}
document.getElementById('historyToggle')?.addEventListener('click', () => {
  applyHistory(document.documentElement.dataset.history === 'off');
});
applyHistory(localStorage.getItem('pb-history') !== 'off');
document.querySelectorAll('[data-jump]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.getElementById('gal-' + btn.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});
stream?.addEventListener('scroll', () => {
  if (sticking) return;
  followThread = nearBottom();
  if (followThread) document.getElementById('newText')?.classList.add('hidden');
});
document.getElementById('newText')?.addEventListener('click', () => stickThread(true));
document.getElementById('shareQuick')?.addEventListener('click', () => {
  if (!activeJob || activeJob.status !== 'done') { toast('Available when the preview finishes.'); return; }
  share(activeJob, 7);
});
document.getElementById('moreBtn')?.addEventListener('click', (event) => {
  event.stopPropagation();
  document.getElementById('stageMenu')?.classList.toggle('hidden');
});
document.addEventListener('click', (event) => {
  const menu = document.getElementById('stageMenu');
  if (!menu || menu.classList.contains('hidden')) return;
  if (event.target.closest('#moreBtn, #stageMenu')) return;
  menu.classList.add('hidden');
});
document.getElementById('compareBtn')?.addEventListener('click', () => {
  if (!activeJob || activeJob.status !== 'done') return;
  showingOriginal = !showingOriginal;
  const frame = document.getElementById('stage');
  if (frame) frame.src = previewAddress(activeJob, true);
  syncStageActions(activeJob);
});

document.getElementById('zipImages').onclick = () => {
  if (!needCapture('download')) return;
  download('/api/jobs/' + activeJob.id + '/zip?type=images', zipName(activeJob, 'images'));
};
document.getElementById('lbClose').onclick = closeLightbox;
document.getElementById('lbPrev').onclick = () => openLightbox(galleryIndex - 1);
document.getElementById('lbNext').onclick = () => openLightbox(galleryIndex + 1);
document.getElementById('lightbox').addEventListener('click', (e) => {
  if (e.target.id === 'lightbox') closeLightbox();
});
document.getElementById('lbImg').addEventListener('error', () => {
  const label = document.getElementById('lbName');
  if (label && !document.getElementById('lightbox').classList.contains('hidden')) label.textContent = 'This file did not display.';
});
document.addEventListener('keydown', (e) => {
  const lb = document.getElementById('lightbox');
  const lbOpen = lb && !lb.classList.contains('hidden');
  if (lbOpen) {
    if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); openLightbox(galleryIndex + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); openLightbox(galleryIndex - 1); }
    return;
  }
  if (e.key !== 'Escape') return;
  if (!pop.classList.contains('hidden')) { e.preventDefault(); closePop(); return; }
  const shell = document.getElementById('settingsShell');
  if (shell && !shell.classList.contains('hidden')) { e.preventDefault(); closeSettingsPage(); }
});
bindSplits();
setInterval(paintClock, 1000);
paintClock();
applyPrefs(readPrefs(), { rights: true });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (readPrefs().theme === 'system') applyPrefs(readPrefs());
});
document.getElementById('clearHist')?.addEventListener('click', (e) => askClear(e.currentTarget));
document.getElementById('micBtn')?.addEventListener('click', openDevice);
document.getElementById('authEye')?.addEventListener('click', () => {
  const input = document.getElementById('authPassword');
  const eye = document.getElementById('authEye');
  if (!input || !eye) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  eye.setAttribute('aria-pressed', show ? 'true' : 'false');
  eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  eye.querySelector('.eye-open')?.toggleAttribute('hidden', show);
  eye.querySelector('.eye-shut')?.toggleAttribute('hidden', !show);
});
function growInput() {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = Math.min(180, input.scrollHeight) + 'px';
}
input?.addEventListener('input', growInput);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  document.title = activeJob ? `${siteSlug(activeJob)} — Protobuild` : 'Protobuild — Capture a site on your computer';
});
document.getElementById('themeBtn').onclick = () => document.body.classList.remove('dim');
document.addEventListener('click', (e) => {
  if (!pop.classList.contains('hidden') && !pop.contains(e.target) && !e.target.closest('#helpBtn, #helpPill, #helpTop, #gearBtn, #meBtn, #accountSide, #accountPill, #chatMenu, #threadMenu, #micBtn, #bellBtn, #plusBtn, #clearHist, #prefClear, [data-share]')) {
    closePop();
  }
});

document.querySelectorAll('[data-view="chat"], [data-view="dash"]').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.pills button').forEach((b) => b.classList.remove('active'));
    document.querySelector('.pills [data-view="chat"]').classList.add('active');
    input.focus();
  };
});
document.querySelector('[data-view="history"]').onclick = () => historyEl.querySelector('.h-item')?.focus();
window.addEventListener('popstate', () => {
  const id = chatIdFromLocation();
  if (id === chatId) return;
  applyingHistory = true;
  const done = id ? restoreSession(id) : Promise.resolve(resetChat());
  Promise.resolve(done).finally(() => { applyingHistory = false; });
});

async function restoreSession(forcedId) {
  const wanted = /^[a-f0-9]{8}$/.test(forcedId || '') ? forcedId : chatIdFromLocation();
  const saved = wanted ? readStoredSession(wanted) : null;
  if (wanted && !saved) {
    activeJob = null;
    thread = [];
    stream.innerHTML = '';
    chatId = wanted;
    setWorking(true);
    restoring = true;
    bubble('ai', 'That chat is not on this computer. Links stay on the browser that made them.');
    restoring = false;
    paintChatId();
    syncStageActions(null);
    return;
  }
  const messages = Array.isArray(saved?.messages) ? saved.messages.filter((item) => item && item.text) : [];
  chatId = wanted || (saved?.chatId && /^[a-f0-9]{8}$/.test(saved.chatId) ? saved.chatId : '');
  paintChatId();
  if (!messages.length && !saved?.jobId) {
    syncStageActions(null);
    return;
  }
  restoring = true;
  thread = [];
  stream.innerHTML = '';
  for (const item of messages) {
    const box = say(item.role === 'user' ? 'user' : 'ai', item.text);
    if (item.model) setModel(box, item.model, item.quotaReset);
  }
  restoring = false;
  if (!saved?.jobId) {
    saveSession();
    syncStageActions(null);
    return;
  }
  try {
    const job = await api('/api/jobs/' + encodeURIComponent(saved.jobId));
    activeJob = job;
    try { localStorage.setItem(chatMapKey(job.id), chatId); } catch {}
    showStage(job);
    setSendMode(jobLive(job));
    saveSession();
    if (jobLive(job)) {
      const bubbles = stream.querySelectorAll('.msg.ai .bubble');
      const box = bubbles[bubbles.length - 1];
      if (box) poll(job.id, box);
    }
  } catch {
    activeJob = null;
    saveSession();
    syncStageActions(null);
  }
}

document.getElementById('pickBtn')?.addEventListener('click', () => {
  const btn = document.getElementById('pickBtn');
  const frame = document.getElementById('stage');
  const on = !btn.classList.contains('on');
  btn.classList.toggle('on', on);
  document.getElementById('pickHint')?.toggleAttribute('hidden', !on);
  frame?.contentWindow?.postMessage({ type: 'pb-pick', on }, '*');
});
document.getElementById('stage')?.addEventListener('load', () => {
  const on = document.getElementById('pickBtn')?.classList.contains('on');
  if (on) document.getElementById('stage').contentWindow?.postMessage({ type: 'pb-pick', on: true }, '*');
});
window.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'pb-picked') return;
  const label = event.data.text ? `${event.data.selector}: ${event.data.text}` : (event.data.selector || 'that element');
  input.value = `Change this (${label}). `;
  input.focus();
  document.getElementById('pickBtn')?.classList.remove('on');
  document.getElementById('pickHint')?.setAttribute('hidden', '');
  document.getElementById('stage')?.contentWindow?.postMessage({ type: 'pb-pick', on: false }, '*');
  growInput();
});
document.getElementById('undoBtn')?.addEventListener('click', async () => {
  if (!activeJob?.id) { toast('No page is open.'); return; }
  try {
    const job = await api('/api/jobs/' + activeJob.id + '/undo', { method: 'POST', body: '{}' });
    activeJob = job;
    showStage(job, { reload: true });
    toast('Undid the last edit.');
  } catch (err) {
    toast(err.message || 'Nothing to undo.');
  }
});

function paintAccount() {
  const who = readAuth();
  const email = who?.email || '';
  const name = document.getElementById('meName');
  const sub = document.getElementById('meSub');
  const line = document.getElementById('accountEmail');
  if (name) name.textContent = email || 'Account';
  if (sub) sub.textContent = email ? 'Signed in' : 'Not signed in';
  if (line) line.textContent = email || 'Not signed in';
}

function startWorkspace() {
  paintAccount();
  return refreshJobs().then(() => {
    const fromChat = chatIdFromLocation();
    const jobId = new URLSearchParams(location.search).get('job');
    if (fromChat) return restoreSession(fromChat);
    if (jobId) {
      addressMode = 'replace';
      return openJob(jobId);
    }
    addressMode = 'replace';
    resetChat();
  }).catch((err) => say('ai', err.message));
}

function showAuth() {
  const gate = document.getElementById('authGate');
  const secure = document.getElementById('authSecure');
  const prep = document.getElementById('prepScreen');
  const error = document.getElementById('authError');
  gate.hidden = false;
  if (secure) secure.hidden = true;
  if (prep) prep.hidden = true;
  if (error) { error.hidden = true; error.textContent = ''; }
}

function prepareWorkspace() {
  const panel = document.getElementById('prepScreen');
  const steps = panel ? [...panel.querySelectorAll('[data-step]')] : [];
  if (!panel || !steps.length) return Promise.resolve();
  panel.hidden = false;
  steps.forEach((step) => step.classList.remove('on', 'done'));
  const slice = 10000 / steps.length;
  return new Promise((resolve) => {
    const timers = steps.map((step, index) => window.setTimeout(() => {
      steps.forEach((item, itemIndex) => {
        item.classList.toggle('done', itemIndex < index);
        item.classList.toggle('on', itemIndex === index);
      });
    }, index * slice));
    timers.push(window.setTimeout(() => {
      steps.forEach((step) => {
        step.classList.remove('on');
        step.classList.add('done');
      });
      window.setTimeout(() => {
        panel.hidden = true;
        resolve();
      }, 350);
    }, 10000));
    panel.dataset.timers = String(timers.length);
  });
}

async function enterApp(opts = {}) {
  const gate = document.getElementById('authGate');
  const secure = document.getElementById('authSecure');
  const work = startWorkspace();
  if (opts.fromLogin) {
    gate.hidden = false;
    secure.hidden = false;
    await new Promise((resolve) => setTimeout(resolve, 6000));
    secure.hidden = true;
    gate.hidden = true;
    await prepareWorkspace();
  }
  const saved = readAuth();
  const fresh = saved?.expires_at && Number(saved.expires_at) * 1000 > Date.now() + 15000;
  if (!fresh) {
    const next = await refreshAuth();
    if (!next) {
      localStorage.removeItem('pb-auth');
      secure.hidden = true;
      showAuth();
      return;
    }
  }
  await work;
  secure.hidden = true;
  gate.hidden = true;
  document.getElementById('prepScreen').hidden = true;
  const agreed = await askRights();
  if (!agreed) {
    showAuth();
  }
}

async function bootAuth() {
  let config = {};
  try { config = await fetch('/api/config').then((res) => res.json()); } catch { config = {}; }
  if (!config.auth) {
    document.getElementById('authGate').hidden = true;
    await startWorkspace();
    await askRights();
    return;
  }
  if (readAuth()?.access_token) return enterApp();
  showAuth();
}

document.getElementById('veil')?.addEventListener('click', () => {
  if (pop && !pop.classList.contains('hidden')) closePop();
});

document.getElementById('authForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const error = document.getElementById('authError');
  const submit = document.getElementById('authSubmit');
  error.hidden = true;
  setBusy(submit, true);
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    saveAuth(data);
    await enterApp({ fromLogin: true });
  } catch (err) {
    error.textContent = err.message || 'Sign-in did not go through.';
    error.hidden = false;
  } finally {
    setBusy(submit, false);
  }
});

bootAuth();
