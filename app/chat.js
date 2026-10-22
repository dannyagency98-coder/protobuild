const stream = document.getElementById('stream');
const historyEl = document.getElementById('history');
const input = document.getElementById('input');
const pop = document.getElementById('popover');
let jobs = [];
let activeJob = null;
let thread = [];
const SESSION_KEY = 'pb-session';
let restoring = false;
let chatId = '';

function newChatId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function chatIdFor(jobId) {
  const key = 'pb-chat:' + jobId;
  let id = '';
  try { id = localStorage.getItem(key) || ''; } catch { id = ''; }
  if (!/^[a-f0-9]{8}$/.test(id)) {
    id = newChatId();
    try { localStorage.setItem(key, id); } catch { /* keep the id in memory */ }
  }
  return id;
}

let undoMemory = false;
let undoMemoryId = '';

function chatLink() {
  return `${location.origin}/?c=${chatId}`;
}

function syncAddress() {
  if (!/^[a-f0-9]{8}$/.test(chatId)) return;
  const next = `/?c=${chatId}`;
  if (location.pathname !== '/' && location.pathname !== '') return;
  if (location.search === `?c=${chatId}`) return;
  history.replaceState(null, '', next);
}

function paintChatId() {
  const el = document.getElementById('chatId');
  if (!el) return;
  el.textContent = chatId;
  el.hidden = !chatId;
  el.title = chatId ? chatLink() : '';
  syncAddress();
}

function readStoredSession(id) {
  try {
    const raw = id ? localStorage.getItem('pb-session:' + id) : localStorage.getItem(SESSION_KEY);
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
  if (!chatId) chatId = newChatId();
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
    localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    localStorage.setItem('pb-session:' + chatId, JSON.stringify(payload));
    if (activeJob?.id) {
      localStorage.setItem('pb-thread:' + activeJob.id, JSON.stringify(messages));
      localStorage.setItem('pb-chat:' + activeJob.id, chatId);
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
  if (tip) {
    el.dataset.tip = tip;
    el.setAttribute('aria-label', tip);
  } else {
    delete el.dataset.tip;
    el.removeAttribute('aria-label');
  }
}

function deviceLabel() {
  if (previewDevice === 'desktop') return 'Desktop';
  if (previewDevice === 'tablet') return 'Tablet';
  return 'iPhone 15 Pro';
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
  const wait = scanning ? `Still scanning ${name}` : 'Open a finished capture';
  tuneBtn(document.querySelector('#stageBar [data-open]'), ready && !!job.previewUrl, 'Open', ready ? `Open ${name}` : wait);
  tuneBtn(document.querySelector('#stageBar [data-zip]'), ready, ready && file.length <= 22 ? file : 'Download', ready ? `Download ${file}` : wait);
  tuneBtn(document.querySelector('#stageBar [data-share]'), ready, job?.shareUrl ? 'Shared' : 'Share', ready ? (job.shareUrl ? `Link for ${name} is on` : `Share ${name}`) : wait);
  tuneBtn(document.querySelector('#stageBar [data-host]'), false, 'Host', 'Use Share. A separate site is not connected.');
  tuneBtn(document.getElementById('pickBtn'), ready, ready ? `Pick` : 'Pick', ready ? `Pick on ${name}` : wait);
  tuneBtn(document.getElementById('undoBtn'), undoReady(job), 'Undo', undoReady(job) ? `Undo the last edit on ${name}` : (ready ? 'Nothing to undo' : wait));
  tuneBtn(document.getElementById('zipImages'), ready, ready && imagesFile.length <= 26 ? imagesFile : 'Download images', ready ? `Download ${imagesFile}` : wait);
  const images = document.getElementById('viewImages');
  if (images) {
    images.disabled = !job?.id;
    images.dataset.tip = job?.id ? `Images from ${name}` : 'Open a capture to see its images';
  }
  const previewPane = document.querySelector('#paneSwitch [data-pane="preview"]');
  if (previewPane) previewPane.disabled = !job?.id;
  const clear = document.getElementById('clearHist');
  if (clear) {
    clear.disabled = !jobs.length;
    clear.dataset.tip = jobs.length ? `Clear ${jobs.length} chat${jobs.length === 1 ? '' : 's'}` : 'Nothing to clear';
  }
  const clearAll = document.getElementById('prefClear');
  if (clearAll) clearAll.disabled = !jobs.length;
  const remove = document.getElementById('prefRemove');
  if (remove) {
    remove.disabled = !job?.id;
    remove.textContent = job?.id ? `Remove ${name}` : 'Remove';
  }
  const chip = document.getElementById('micBtn');
  if (chip) {
    chip.textContent = deviceLabel();
    chip.dataset.tip = `Preview size: ${deviceLabel()}`;
  }
  const stageTitle = document.getElementById('stageTitle');
  if (stageTitle) stageTitle.textContent = deviceLabel();
  const box = document.getElementById('input');
  if (box) {
    box.placeholder = ready
      ? `Change, download, or share ${name}…`
      : (scanning ? `Scanning ${name}…` : 'Paste a link, or ask me to change, download, or share it…');
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
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData) && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { error: text }; }
  if (!res.ok) throw new Error(json?.error || res.statusText);
  return json;
}

function iconBtn(name, label, path) {
  return `<button class="mini" type="button" data-act="${name}" data-tip="${label}" aria-label="${label}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">${path}</svg></button>`;
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
  const retry = iconBtn('retry', 'Resend', '<path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/>');
  tools.innerHTML = copy + retry;
  if (opts.pending) tools.hidden = true;
  const retryBtn = tools.querySelector('[data-act="retry"]');
  retryBtn.hidden = true;
  tools.querySelector('[data-act="copy"]').onclick = () => copyText(row.querySelector('.bubble')?.innerText || '');
  retryBtn.onclick = () => {
    const last = role === 'user' ? (row.querySelector('.bubble')?.innerText || '') : lastUserText();
    if (!last) { toast('Nothing to send again.'); return; }
    onSend(last);
  };
  row.appendChild(tools);
  stream.appendChild(row);
  stream.scrollTop = stream.scrollHeight;
  return row.querySelector('.bubble');
}

function showRetry(bubbleEl) {
  const row = bubbleEl?.closest('.msg');
  if (!row) return;
  const tools = row.querySelector('.actions-row');
  const retry = row.querySelector('[data-act="retry"]');
  if (tools) tools.hidden = false;
  if (retry) retry.hidden = false;
}

function isNarrow() {
  return window.innerWidth <= 980;
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

function applyColumns() {
  const app = document.querySelector('.app');
  if (!app) return;
  app.classList.toggle('chat-right', chatOnRight());
  labelSplits();
  if (window.innerWidth <= 980) {
    app.style.gridTemplateColumns = '';
    return;
  }
  const working = app.classList.contains('working');
  const saved = readWidths();
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
      if (ev.button !== 0 || window.innerWidth <= 980) return;
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
      if (window.innerWidth <= 980) return;
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

function applyDevice(name) {
  previewDevice = name === 'tablet' || name === 'desktop' ? name : 'phone';
  localStorage.setItem('pb-device', previewDevice);
  const canvas = document.getElementById('phoneView');
  if (canvas) canvas.dataset.device = previewDevice;
  document.querySelectorAll('#deviceSwitch [data-device]').forEach((btn) => {
    const on = btn.dataset.device === previewDevice;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const frame = document.getElementById('stage');
  if (frame) frame.title = previewDevice === 'phone' ? 'iPhone preview' : (previewDevice === 'tablet' ? 'Tablet preview' : 'Desktop preview');
  syncStageActions(activeJob);
  fitPhone();
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
    return;
  }
  if (previewDevice !== 'phone') {
    slot.style.width = '100%';
    slot.style.height = '100%';
    device.style.transform = 'none';
    return;
  }
  const scale = Math.min((canvas.clientWidth - 28) / 449, (canvas.clientHeight - 16) / 892, 0.96);
  const s = scale > 0.45 ? scale : 0.45;
  slot.style.width = Math.round(449 * s) + 'px';
  slot.style.height = Math.round(892 * s) + 'px';
  device.style.transformOrigin = 'top left';
  device.style.transform = `scale(${s})`;
}

function ensureRights() {
  return Promise.resolve(true);
}

function rightsSaved() {
  return true;
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

function paintClock() {
  const clock = jobLive(activeJob) ? formatElapsed(activeJob.created_at) : '';
  const badge = document.getElementById('stageClock');
  if (badge) {
    badge.hidden = !clock;
    badge.textContent = clock;
  }
  document.querySelectorAll('.live-clock').forEach((el) => { el.textContent = clock; });
}

let sendToken = 0;
let inflight = null;

function setSendMode(on) {
  const btn = document.getElementById('sendBtn');
  if (!btn) return;
  btn.classList.toggle('stop', !!on);
  btn.dataset.tip = on ? 'Stop' : 'Send';
  btn.setAttribute('aria-label', on ? 'Stop' : 'Send');
}

async function stopRunning() {
  sendToken += 1;
  const ctrl = inflight;
  inflight = null;
  try { ctrl?.abort(); } catch {}
  const job = activeJob;
  setSendMode(false);
  if (!jobLive(job)) {
    toast('Stopped.');
    return;
  }
  try {
    const updated = await api('/api/jobs/' + job.id + '/stop', { method: 'POST', body: '{}' });
    if (activeJob?.id === job.id) {
      activeJob = updated;
      showStage(updated);
      saveSession();
    }
    refreshJobs();
    toast('Stopped.');
  } catch (err) {
    toast(err.message || 'Could not stop that.');
    setSendMode(jobLive(activeJob));
  }
}

function say(role, text) {
  thread.push({ role, text });
  setWorking(true);
  saveSession();
  return bubble(role, esc(text).replace(/\n/g, '<br>'));
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
  const html = esc(text).replace(/\n/g, '<br>').replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  box.innerHTML = html;
  box.classList.remove('arrived');
  void box.offsetWidth;
  box.classList.add('arrived');
  stream.scrollTop = stream.scrollHeight;
  saveSession();
}

function showStage(job, opts = {}) {
  const frame = document.getElementById('stage');
  const empty = document.getElementById('stageEmpty');
  const title = document.getElementById('stageTitle');
  if (!frame || !job) return;
  setWorking(true);
  if (empty) {
    empty.classList.toggle('busy', job.status === 'queued' || job.status === 'running');
    if (job.status === 'done') empty.textContent = '';
    else if (job.status === 'blocked') empty.textContent = 'This site refused the scanner.';
    else if (job.status === 'failed' && /stopped/i.test(job.error || '')) empty.textContent = 'Stopped.';
    else if (job.status === 'failed') empty.textContent = 'This capture did not finish.';
    else empty.textContent = `${job.phase === 'packaging' ? 'The page is saved' : 'Opening the page'} · ${formatElapsed(job.created_at)}`;
  }
  const previewUrl = job.previewUrl || (job.id ? '/preview/' + job.id + '/' : '');
  const previewReady = job.status === 'done' || job.phase === 'packaging';
  if (previewReady && previewUrl) {
    const next = opts.reload ? previewUrl + '?t=' + Date.now() : previewUrl;
    if (opts.reload || frame.getAttribute('src') !== next) frame.src = next;
    frame.classList.remove('hidden');
    empty?.classList.add('hidden');
  } else {
    frame.classList.add('hidden');
    frame.removeAttribute('src');
    empty?.classList.remove('hidden');
  }
  if (title) title.textContent = deviceLabel();
  loadGallery(job);
  const host = document.getElementById('stageHost');
  const chatTitle = document.getElementById('chatTitle');
  const name = (job.source_url || 'Uploaded file').replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (host) {
    const scanning = job.status === 'queued' || job.status === 'running';
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
    nameEl.textContent = scanning ? `Scanning ${name}` : name;
    badge.hidden = !scanning;
    badge.textContent = scanning ? formatElapsed(job.created_at) : '';
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
  bar.querySelector('[data-open]').onclick = () => {
    if (job.status === 'done' && job.previewUrl) window.open(job.previewUrl, '_blank', 'noopener');
    else toast('The preview is not ready yet.');
  };
  bar.querySelector('[data-zip]').onclick = () => download('/api/jobs/' + job.id + '/zip?type=full', zipName(job));
  bar.querySelector('[data-share]').onclick = (event) => openShare(job, event.currentTarget);
  bar.querySelector('[data-host]').onclick = () => hostPage(job);
  syncStageActions(job);
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
      <button class="linkish" type="button" data-host disabled title="Use Share. A separate site is not connected.">Host</button>
    </div>
  </div>`;
}

async function refreshJobs() {
  const data = await api('/api/jobs');
  jobs = data.jobs || [];
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
      const title = job.source_url || 'Uploaded file';
      const label = title.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const dot = job.status === 'done' ? 'ok' : (job.status === 'failed' || job.status === 'blocked' ? 'bad' : 'wait');
      btn.innerHTML = `<span class="dot ${dot}"></span><span class="h-text">${esc(label)}</span><span class="h-id">${esc(chatIdFor(job.id))}</span>`;
      btn.onclick = () => openJob(job.id);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'h-x';
      remove.title = 'Remove';
      remove.setAttribute('aria-label', 'Remove ' + label);
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
  if (!jobs.length) historyEl.innerHTML = '<p class="group">No captures yet. Paste a link in the chat.</p>';
  updateHistoryLead();
  syncStageActions(activeJob);
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
  stream.scrollTop = stream.scrollHeight;
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

const LIVE_STEPS = [
  ['opening', 'Opening the page'],
  ['reading', 'Reading layout and images'],
  ['scrolling', 'Loading the rest of the page'],
  ['saving', 'Saving the copy'],
  ['packaging', 'Preparing the preview'],
];

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
  const names = LIVE_STEPS.map((step) => step[0]);
  let idx = names.indexOf(job.phase);
  if (idx < 0) idx = job.status === 'running' ? 1 : 0;
  live.innerHTML = `<div class="live-clock">${formatElapsed(job.created_at)}</div>` + LIVE_STEPS.map((step, i) => {
    const state = i < idx ? 'done' : i === idx ? 'now' : '';
    return `<div class="live-step ${state}">${step[1]}</div>`;
  }).join('') + (job.phaseDetail ? `<div class="live-step">${esc(job.phaseDetail)}</div>` : '');
}

function statusLine(job) {
  if (job.status === 'done') return 'The page is in the preview. You can edit it, share it, or download it.';
  if (job.status === 'blocked') return cleanError(job.error) || 'This site blocked the scan. Attach a saved copy of the page.';
  if (job.status === 'failed' && /stopped/i.test(job.error || '')) return 'Stopped.';
  if (job.status === 'failed') return cleanError(job.error) || 'The scan did not finish. Try again, or attach a saved copy of the page.';
  const step = LIVE_STEPS.find((item) => item[0] === job.phase);
  const now = step ? step[1] : 'Opening the live page';
  const count = Number(job.stats?.images || 0);
  const images = count ? ` · ${count} images saved` : '';
  return `${now}${images} · ${formatElapsed(job.created_at)}`;
}

function wireCard(box, job) {
  box.querySelector('[data-open]')?.addEventListener('click', () => window.open(job.previewUrl, '_blank', 'noopener'));
  box.querySelector('[data-zip]')?.addEventListener('click', () => download('/api/jobs/' + job.id + '/zip?type=full', zipName(job)));
  box.querySelector('[data-share]')?.addEventListener('click', (event) => openShare(job, event.currentTarget));
  box.querySelector('[data-host]')?.addEventListener('click', () => hostPage(job));
}

async function download(path, filename) {
  const res = await fetch(path);
  if (!res.ok) { toast('The files are not ready yet.'); return; }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Download started.');
}

function hostPage() {
  toast('Use Share. A separate site for this capture is not connected.');
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
    if (days === 'off') { toast('Share link turned off.'); return; }
    const link = absoluteLink(updated.shareUrl);
    if (!link) { toast('I could not turn the link on.'); return; }
    await copyText(link, 'Share link copied.');
    say('ai', `Live link:\n${link}`);
  } catch (err) {
    toast(err.message);
  }
}

function openShare(job, anchor) {
  if (!job) { toast('Open a capture first.'); return; }
  showPop('<h3>Share preview</h3><p class="menu-note">The link opens the preview, including on a phone.</p><button class="menu-act" type="button" data-go="d7">7 days</button><button class="menu-act" type="button" data-go="d30">30 days</button><button class="menu-act" type="button" data-go="never">Until the capture expires</button><button class="menu-act danger" type="button" data-go="off">Turn the link off</button>', anchor || document.getElementById('threadMenu'));
  wirePop({
    d7: () => { closePop(); share(job, 7); },
    d30: () => { closePop(); share(job, 30); },
    never: () => { closePop(); share(job, 0); },
    off: () => { closePop(); share(job, 'off'); },
  });
}

const chimedJobs = new Set();

function maybeChime(job) {
  if (!job?.id) return;
  if (job.status !== 'done' && job.status !== 'failed' && job.status !== 'blocked') return;
  if (chimedJobs.has(job.id)) return;
  chimedJobs.add(job.id);
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
    const rows = JSON.parse(localStorage.getItem('pb-thread:' + jobId) || 'null');
    return Array.isArray(rows) ? rows.filter((item) => item && item.text) : [];
  } catch { return []; }
}

const advised = new Set();
const lined = new Set();

async function requestLine(box, job) {
  if (!box || lined.has(job.id)) return;
  lined.add(job.id);
  try {
    const res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'ready', activeJobId: job.id, message: job.source_url || '', history: [] }),
    });
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
    const res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `The capture of ${job.source_url || 'that page'} ended as ${job.status}. ${job.error || ''} Tell the user what to try next in two sentences. Do not call any tool.`,
        history: thread.slice(-20).map((item) => ({ role: item.role, text: item.text })),
        activeJobId: job.id,
        rights_confirmed: true,
      }),
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
  const tick = async () => {
    if (activeJob?.id !== id) return;
    let job;
    try { job = await api('/api/jobs/' + encodeURIComponent(id)); }
    catch { return; }
    if (activeJob?.id !== id) return;
    activeJob = job;
    let status = box.querySelector('[data-status]');
    if (!status) {
      status = document.createElement('div');
      status.dataset.status = '1';
      status.style.marginTop = '8px';
      box.appendChild(status);
    }
    status.textContent = statusLine(job);
    renderLive(box, job);
    if (activeJob?.id === id && !inflight) setSendMode(jobLive(job));
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
      stream.scrollTop = stream.scrollHeight;
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
  box.innerHTML = esc(text).replace(/\n/g, '<br>').replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  stream.scrollTop = stream.scrollHeight;
}

function setModel(box, model, quotaReset) {
  const last = [...thread].reverse().find((item) => item.role === 'ai');
  if (last) {
    if (model) last.model = model;
    if (quotaReset) last.quotaReset = quotaReset;
  }
  if (!box || !model) return;
  let tag = box.parentElement?.querySelector('.model-tag');
  if (!tag) {
    tag = document.createElement('div');
    tag.className = 'model-tag';
    box.insertAdjacentElement('afterend', tag);
  }
  let when = '';
  if (quotaReset) {
    const back = new Date(quotaReset);
    if (!Number.isNaN(back.getTime())) {
      when = ` · back ${back.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    }
  }
  tag.textContent = `${model}${when}`;
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
  stream.scrollTop = stream.scrollHeight;
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

async function onSend(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const token = ++sendToken;
  setSendMode(true);
  const history = thread.slice(-20).map((item) => ({ role: item.role, text: item.text }));
  const sent = say('user', trimmed);
  const box = sayTyping();
  const ctrl = new AbortController();
  inflight = ctrl;
  try {
    const res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: trimmed,
        history,
        images: refs.map((item) => item.url),
        activeJobId: activeJob?.id || null,
        rights_confirmed: true,
      }),
      signal: ctrl.signal,
    });
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
      if (jobLive(data.job)) poll(data.job.id, box);
      else if (data.showPreview && data.job.status === 'done') {
        box.insertAdjacentHTML('beforeend', previewCard(data.job));
        wireCard(box, data.job);
        stream.scrollTop = stream.scrollHeight;
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
  }
}

document.getElementById('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (document.getElementById('sendBtn').classList.contains('stop')) {
    stopRunning();
    return;
  }
  const text = input.value;
  if (!text.trim() && !refs.length) {
    toast('Type a message or paste a link first.');
    input.focus();
    return;
  }
  input.value = '';
  const outgoing = text.trim() || 'Use the attached image as a reference.';
  onSend(outgoing);
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
  if (onPhone) requestAnimationFrame(fitPhone);
}

function closeLightbox() {
  document.getElementById('lightbox')?.classList.add('hidden');
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
  if (pos) pos.textContent = `${galleryIndex + 1} / ${gallery.length}`;
  document.getElementById('lightbox')?.classList.remove('hidden');
  document.getElementById('lbPrev')?.classList.toggle('hidden', gallery.length < 2);
  document.getElementById('lbNext')?.classList.toggle('hidden', gallery.length < 2);
  const down = document.getElementById('lbDown');
  if (down) down.onclick = () => download(src, `${siteSlug(activeJob)}-${name}`);
}

function renderGallery(job) {
  const grid = document.getElementById('imgGrid');
  const note = document.getElementById('galleryNote');
  if (!grid) return;
  if (note) {
    const hiddenFiles = Number(job?.gallerySkipped) || 0;
    const countLabel = gallery.length ? `${gallery.length} image${gallery.length === 1 ? '' : 's'}` : 'No images yet';
    note.textContent = hiddenFiles ? `${countLabel} · ${hiddenFiles} left out` : countLabel;
  }
  if (!gallery.length) {
    const waiting = job && (job.status === 'queued' || job.status === 'running');
    grid.innerHTML = `<p class="gallery-empty">${waiting ? 'Images show up when the capture finishes.' : 'No images in this capture.'}</p>`;
    return;
  }
  grid.innerHTML = gallery.map((img, index) => {
    const src = imageSrc(img);
    const name = String(img.local || 'image').split('/').pop();
    const kb = Math.max(1, Math.round((img.size || 0) / 1024));
    return `<button type="button" class="shot" data-i="${index}">
      <img src="${esc(src)}" alt="${esc(name)}" loading="lazy">
      <span>${esc(name)} · ${kb} KB${img.small ? ' · tiny' : ''}</span>
    </button>`;
  }).join('');
  grid.querySelectorAll('.shot img').forEach((img) => {
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
    if (countEl) countEl.textContent = '0';
    renderGallery(job);
    return;
  }
  const tinyBox = document.getElementById('tinyImgs');
  const changedJob = galleryJobId !== job.id;
  if (changedJob && tinyBox) tinyBox.checked = !!readPrefs().tiny;
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
  if (countEl) countEl.textContent = String(gallery.length);
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
    empty.textContent = 'Preview';
  }
  const host = document.getElementById('stageHost');
  if (host) host.textContent = 'Preview';
  const title = document.getElementById('stageTitle');
  if (title) title.textContent = deviceLabel();
  const chatTitle = document.getElementById('chatTitle');
  if (chatTitle) chatTitle.textContent = 'New chat';
  chatId = newChatId();
  paintChatId();
  saveSession();
  closeLightbox();
  gallery = [];
  galleryJobId = '';
  const count = document.getElementById('imageCount');
  if (count) count.textContent = '0';
  const note = document.getElementById('galleryNote');
  if (note) note.textContent = 'No capture open';
  const grid = document.getElementById('imgGrid');
  if (grid) grid.innerHTML = '<p class="gallery-empty">Open a capture to see its images.</p>';
  setView('phone');
  setWorking(false);
  setSendMode(false);
  syncStageActions(null);
}

document.getElementById('newChat').onclick = () => {
  closeSettingsPage();
  closeDrawer();
  resetChat();
  refreshJobs();
  input.focus();
  toast('New chat.');
};
document.getElementById('menuBtn')?.addEventListener('click', () => {
  document.querySelector('.side')?.classList.add('open');
  document.getElementById('drawerBackdrop')?.classList.remove('hidden');
});
document.getElementById('drawerBackdrop')?.addEventListener('click', closeDrawer);
document.querySelectorAll('#paneSwitch [data-pane]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.pane === 'preview' && !document.querySelector('.app')?.classList.contains('working')) {
      toast('Start a scan to open the preview.');
      return;
    }
    setPane(btn.dataset.pane);
    if (btn.dataset.pane === 'preview') requestAnimationFrame(fitPhone);
  });
});
document.getElementById('homeNav').onclick = () => {
  closeSettingsPage();
  closeDrawer();
  closePop();
  resetChat();
  refreshJobs();
  input.focus();
};
document.getElementById('chatSearch')?.addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll('.h-row').forEach((el) => {
    const hit = el.innerText.toLowerCase().includes(q);
    el.style.display = hit ? '' : 'none';
    if (hit) shown += 1;
  });
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
});
let lastInnerWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (columnDrag) return;
  if (window.innerWidth > 980 && lastInnerWidth > 980 && document.querySelector('.app')?.classList.contains('working')) {
    const saved = readWidths();
    if (saved.chat) {
      const fit = fitTrio(saved.side, saved.chat, saved.stage, window.innerWidth - 20);
      writeWidths(fit);
    }
  }
  lastInnerWidth = window.innerWidth;
  applyColumns();
});
document.querySelectorAll('[data-prompt]').forEach((btn) => {
  btn.onclick = () => onSend(btn.getAttribute('data-prompt'));
});

function lastUserText() {
  return thread.filter((item) => item.role === 'user').slice(-1)[0]?.text || '';
}

let toastTimer = 0;
function toast(text) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

async function copyText(text, ok = 'Copied.') {
  const value = String(text || '').trim();
  if (!value) { toast('Nothing to copy.'); return; }
  try {
    await navigator.clipboard.writeText(value);
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
    toast(copied ? ok : 'Could not copy that.');
  } catch {
    toast('Could not copy that.');
  }
}

function closePop() {
  pop.classList.add('hidden');
  pop.classList.remove('account-menu');
}

function showPop(html, anchor) {
  pop.classList.remove('account-menu');
  pop.innerHTML = html;
  pop.classList.remove('hidden');
  const rect = (anchor || document.getElementById('helpBtn')).getBoundingClientRect();
  const side = document.querySelector('.side').getBoundingClientRect();
  const inSide = rect.left >= side.left - 2 && rect.right <= side.right + 2;
  const width = inSide ? Math.max(200, side.width - 16) : 280;
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
  try {
    await api('/api/jobs/' + encodeURIComponent(id), { method: 'DELETE' });
    try {
      localStorage.removeItem('pb-thread:' + id);
      localStorage.removeItem('pb-chat:' + id);
    } catch { /* the capture is already gone */ }
    if (activeJob?.id === id) resetChat();
    await refreshJobs();
    toast('Capture removed.');
    closePop();
  } catch (err) {
    toast(err.message);
  }
}

async function clearHistory() {
  try {
    const data = await api('/api/jobs', { method: 'DELETE' });
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('pb-thread:') || key.startsWith('pb-chat:'))) keys.push(key);
      }
      keys.forEach((key) => localStorage.removeItem(key));
    } catch { /* history is already cleared on the server */ }
    resetChat();
    await refreshJobs();
    closePop();
    toast(data.removed ? `Cleared ${data.removed} capture${data.removed === 1 ? '' : 's'}.` : 'History is already empty.');
  } catch (err) {
    toast(err.message);
  }
}

function askClear(anchor) {
  if (!jobs.length) { toast('History is already empty.'); return; }
  showPop(`<h3>Clear history</h3><p class="menu-note">This removes every capture on this computer, including the saved pages and zip files.</p><button class="menu-act danger" type="button" data-go="yes">Clear ${jobs.length} capture${jobs.length === 1 ? '' : 's'}</button><button class="menu-act" type="button" data-go="no">Cancel</button>`, anchor);
  wirePop({ yes: clearHistory, no: closePop });
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
  lead.textContent = jobs.length
    ? `${jobs.length} capture${jobs.length === 1 ? '' : 's'} saved on this computer.`
    : 'No captures saved on this computer yet.';
}

const PANEL_TITLES = { interface: 'Interface', capture: 'Capture', history: 'History' };

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

function openAccount(e) {
  if (!pop.classList.contains('hidden') && pop.classList.contains('account-menu')) {
    closePop();
    return;
  }
  showPop(`<div class="acct-id"><span class="ava"></span><div><b>Local</b><span>This computer</span></div></div><button class="menu-act" type="button" data-go="settings"><span>Settings</span></button><button class="menu-act" type="button" data-go="feedback"><span>Feedback</span></button><div class="acct-row theme-row"><span>Theme</span>${themeSegHtml()}</div><button class="menu-act" type="button" data-go="more"><span>More</span><svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 6l6 6-6 6"/></svg></button><div class="more-box hidden" id="moreBox"><button class="menu-act" type="button" data-go="help">Help</button><button class="menu-act" type="button" data-go="upload">Upload a saved page</button><button class="menu-act" type="button" data-go="widths">Reset column widths</button><button class="menu-act" type="button" data-go="images" ${activeJob ? '' : 'disabled'}>Show images</button></div>`, e.currentTarget);
  pop.classList.add('account-menu');
  paintThemeButtons(readPrefs().theme);
  pop.querySelectorAll('[data-theme]').forEach((btn) => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      writePrefs({ theme: btn.dataset.theme });
    };
  });
  wirePop({
    settings: () => openSettingsPage('interface'),
    feedback: () => { closePop(); openFeedback(); },
    more: (btn) => {
      document.getElementById('moreBox')?.classList.toggle('hidden');
      btn.classList.toggle('on');
    },
    help: () => openHelp({ currentTarget: document.getElementById('meBtn') }),
    upload: () => { closePop(); document.getElementById('file').click(); },
    widths: () => { closePop(); resetColumnWidths(); },
    images: () => {
      closePop();
      if (!activeJob) { toast('Open a capture first.'); return; }
      setView('images');
      loadGallery(activeJob);
    },
  });
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
  list.innerHTML = items.map((item) => `<li>${esc(item.text)}</li>`).join('');
}

function openFeedback() {
  document.getElementById('feedback')?.classList.remove('hidden');
  renderFeedback();
  const box = document.getElementById('feedbackText');
  if (box) {
    box.value = '';
    box.focus();
  }
}

function closeFeedback() {
  document.getElementById('feedback')?.classList.add('hidden');
}

function openHelp(e) {
  showPop(`<h3>Help</h3><p class="menu-note">Name a site in the chat on your computer. Protobuild saves the page and shows it in the iPhone preview. A shared link can open on a phone. Drag the gaps between the columns. Each one keeps its own width. The Local menu opens settings, the theme, and feedback.</p><button class="menu-act" type="button" data-go="focus">Write a scan</button><button class="menu-act" type="button" data-go="sample">Scan example.com</button><button class="menu-act" type="button" data-go="file">Attach a saved page</button><button class="menu-act" type="button" data-go="images" ${activeJob ? '' : 'disabled'}>Show images</button><button class="menu-act" type="button" data-go="open" ${activeJob?.status === 'done' ? '' : 'disabled'}>Open the preview</button>`, e.currentTarget);
  wirePop({
    focus: () => fillPrompt('scan '),
    sample: () => { closePop(); onSend('scan example.com'); },
    file: () => { closePop(); document.getElementById('file').click(); },
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
  showPop(`<h3>Start</h3><button class="menu-act" type="button" data-go="scan">Scan a site</button><button class="menu-act" type="button" data-go="images">Images only</button><button class="menu-act" type="button" data-go="file">Upload a saved page</button>`, e.currentTarget);
  wirePop({
    scan: () => fillPrompt('scan '),
    images: () => fillPrompt('images only '),
    file: () => { closePop(); document.getElementById('file').click(); },
  });
}

function openDevice(e) {
  const laid = previewDevice === 'phone'
    ? 'The page is laid out at 393 by 852, with the Dynamic Island.'
    : `The preview is showing ${deviceLabel().toLowerCase()}.`;
  showPop(`<h3>${esc(deviceLabel())}</h3><p class="menu-note">${laid}</p><button class="menu-act" type="button" data-go="fit">Fit the preview</button><button class="menu-act" type="button" data-go="open" ${activeJob?.status === 'done' ? '' : 'disabled'}>Open ${activeJob ? esc(siteSlug(activeJob)) : 'the preview'}</button>`, e.currentTarget);
  wirePop({
    fit: () => {
      if (!document.querySelector('.app')?.classList.contains('working')) toast('Open a chat to see the phone.');
      else { fitPhone(); toast('Preview fitted.'); }
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
  showPop(`<h3>This chat</h3><p class="menu-note">${esc(chatLink())}</p><button class="menu-act" type="button" data-go="fresh">New chat</button><button class="menu-act" type="button" data-go="id">Copy chat link</button><button class="menu-act" type="button" data-go="images" ${activeJob ? '' : 'disabled'}>Show images</button><button class="menu-act" type="button" data-go="copy" ${activeJob?.status === 'done' ? '' : 'disabled'}>Copy preview link</button><button class="menu-act" type="button" data-go="share" ${activeJob?.status === 'done' ? '' : 'disabled'}>Share</button><button class="menu-act" type="button" data-go="host" disabled>Host is not connected</button><button class="menu-act danger" type="button" data-go="remove" ${activeJob ? '' : 'disabled'}>Remove this capture</button>`, e.currentTarget);
  wirePop({
    fresh: () => { closePop(); document.getElementById('newChat').click(); },
    id: () => { copyText(chatLink(), 'Chat link copied.'); },
    images: () => {
      closePop();
      if (!activeJob) { toast('Open a capture first.'); return; }
      setView('images');
      loadGallery(activeJob);
    },
    copy: () => { if (activeJob?.previewUrl) copyText(activeJob.previewUrl, 'Preview link copied.'); else toast('The preview is not ready yet.'); },
    share: () => { closePop(); if (activeJob) openShare(activeJob); },
    host: () => { closePop(); hostPage(); },
    remove: () => { if (activeJob) removeCapture(activeJob.id); },
  });
}

document.getElementById('plusBtn').onclick = openPlus;
document.getElementById('clipBtn').onclick = () => document.getElementById('file').click();
document.getElementById('uploadNav').onclick = () => {
  closeSettingsPage();
  document.getElementById('file').click();
};
const refs = [];

function paintRefs() {
  const row = document.getElementById('refRow');
  if (!row) return;
  row.hidden = refs.length === 0;
  row.innerHTML = refs.map((item, index) => `<div class="ref-chip"><img src="${item.url}" alt=""><button type="button" data-ref="${index}" aria-label="Remove ${esc(item.name)}">×</button></div>`).join('');
  row.querySelectorAll('[data-ref]').forEach((btn) => {
    btn.onclick = () => {
      refs.splice(Number(btn.dataset.ref), 1);
      paintRefs();
    };
  });
}

function addReference(file) {
  if (!file) return;
  const image = /^image\//.test(file.type || '') || /\.(png|jpe?g|webp|gif)$/i.test(file.name || '');
  if (!image) {
    uploadFile(file).catch((err) => say('ai', err.message));
    return;
  }
  if (refs.length >= 3) { toast('Three reference images at a time.'); return; }
  if (file.size > 1500000) { toast('That image is over 1.5 MB.'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    refs.push({ name: file.name || 'image', url: String(reader.result || '') });
    paintRefs();
  };
  reader.readAsDataURL(file);
}

document.getElementById('file').onchange = (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) addReference(file);
};

const composer = document.getElementById('composer');
['dragenter', 'dragover'].forEach((name) => {
  composer.addEventListener(name, (event) => {
    if (![...event.dataTransfer?.items || []].some((item) => item.kind === 'file')) return;
    event.preventDefault();
    composer.classList.add('drop-on');
  });
});
composer.addEventListener('dragleave', () => composer.classList.remove('drop-on'));
composer.addEventListener('drop', (event) => {
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  composer.classList.remove('drop-on');
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
document.getElementById('micBtn').onclick = openDevice;
document.getElementById('accountPill').onclick = openAccount;
document.getElementById('settingsBack').onclick = closeSettingsPage;
document.querySelectorAll('.set-link').forEach((btn) => {
  btn.onclick = () => showSettingsPanel(btn.dataset.panel);
});
document.getElementById('prefSuggestions').onclick = () => writePrefs({ suggestions: !readPrefs().suggestions });
document.getElementById('prefSound').onclick = () => writePrefs({ sound: !readPrefs().sound });
document.getElementById('prefTiny').onclick = () => writePrefs({ tiny: !readPrefs().tiny });
document.getElementById('prefChatSide').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-side]');
  if (!btn) return;
  writePrefs({ chatSide: btn.dataset.side === 'right' ? 'right' : 'left' });
});
function onThemeClick(e) {
  const btn = e.target.closest('[data-theme]');
  if (!btn) return;
  writePrefs({ theme: btn.dataset.theme });
}
document.getElementById('settingsTheme').addEventListener('click', onThemeClick);
document.getElementById('sideTheme').addEventListener('click', onThemeClick);
document.getElementById('prefResetWidths').onclick = () => resetColumnWidths();
document.getElementById('prefRemove').onclick = () => {
  if (!activeJob) { toast('Open a capture first.'); return; }
  removeCapture(activeJob.id);
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
document.getElementById('feedback').addEventListener('click', (e) => {
  if (e.target.id === 'feedback') closeFeedback();
});
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
document.getElementById('chatId')?.addEventListener('click', () => {
  if (chatId) copyText(chatLink(), 'Chat link copied.');
});
document.getElementById('threadMenu').onclick = openThread;
document.getElementById('viewPhone').onclick = () => setView('phone');
document.querySelectorAll('#deviceSwitch [data-device]').forEach((btn) => {
  btn.addEventListener('click', () => {
    setView('phone');
    applyDevice(btn.dataset.device);
  });
});
applyDevice(previewDevice);
document.getElementById('viewImages').onclick = () => {
  if (!activeJob) { toast('Open a capture to see its images.'); return; }
  setView('images');
  loadGallery(activeJob);
};
document.getElementById('tinyImgs').addEventListener('change', () => {
  if (activeJob) loadGallery(activeJob);
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
document.querySelector('#stageBar [data-share]').onclick = (event) => {
  if (!needCapture('share')) return;
  openShare(activeJob, event.currentTarget);
};
document.querySelector('#stageBar [data-host]').onclick = () => {
  if (!needCapture('host')) return;
  hostPage(activeJob);
};

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
  const feedback = document.getElementById('feedback');
  if (feedback && !feedback.classList.contains('hidden')) { e.preventDefault(); closeFeedback(); return; }
  if (!pop.classList.contains('hidden')) { e.preventDefault(); closePop(); return; }
  const shell = document.getElementById('settingsShell');
  if (shell && !shell.classList.contains('hidden')) { e.preventDefault(); closeSettingsPage(); }
});
bindSplits();
setInterval(paintClock, 1000);
applyPrefs(readPrefs(), { rights: true });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (readPrefs().theme === 'system') applyPrefs(readPrefs());
});
document.getElementById('clearHist').onclick = (e) => askClear(e.currentTarget);
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

async function restoreSession(forcedId) {
  const wanted = /^[a-f0-9]{8}$/.test(forcedId || '') ? forcedId : '';
  let saved = wanted ? readStoredSession(wanted) : readStoredSession();
  if (wanted && !saved) {
    const latest = readStoredSession();
    if (latest?.chatId === wanted) saved = latest;
  }
  const messages = Array.isArray(saved?.messages) ? saved.messages.filter((item) => item && item.text) : [];
  chatId = wanted || (saved?.chatId && /^[a-f0-9]{8}$/.test(saved.chatId) ? saved.chatId : newChatId());
  paintChatId();
  if (!messages.length && !saved?.jobId) {
    saveSession();
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
    try { localStorage.setItem('pb-chat:' + job.id, chatId); } catch {}
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
  document.getElementById('stage')?.contentWindow?.postMessage({ type: 'pb-pick', on: false }, '*');
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

refreshJobs().then(() => {
  const params = new URLSearchParams(location.search);
  const fromChat = params.get('c') || '';
  const jobId = params.get('job');
  if (/^[a-f0-9]{8}$/.test(fromChat)) {
    const stored = readStoredSession(fromChat);
    if (stored && (stored.messages?.length || stored.jobId)) return restoreSession(fromChat);
  }
  if (jobId) return openJob(jobId);
  if (/^[a-f0-9]{8}$/.test(fromChat)) return restoreSession(fromChat);
  return restoreSession();
}).catch((err) => say('ai', err.message));
