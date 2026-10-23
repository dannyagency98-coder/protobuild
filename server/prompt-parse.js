const ALLOWED_ACTIONS = new Set(['click', 'wait', 'scroll', 'setViewport']);

function parseCapturePrompt(text, fallbackMode = 'clone') {
  const result = {
    mode: fallbackMode === 'images' ? 'images' : 'clone',
    viewport: 'desktop',
    actions: [],
    imageScope: 'all',
    crawl: false,
    productShots: false,
  };
  const raw = String(text || '').trim();
  if (!raw) return result;
  const lower = raw.toLowerCase();
  if (/\bimages?\s*only\b|\bonly images\b/.test(lower)) result.mode = 'images';
  if (/\bmobile\b|\bphone\b/.test(lower)) result.viewport = 'mobile';
  if (/\bhero\b/.test(lower)) result.imageScope = 'hero';
  if (/\bproduct/.test(lower)) result.imageScope = 'products';

  const clickRe = /click(?:\s+on)?\s+["']?([^,"'\n]+)["']?/gi;
  let m;
  while ((m = clickRe.exec(raw))) {
    result.actions.push({ type: 'click', target: m[1].trim() });
  }
  const waitRe = /wait\s+(\d+)\s*(ms|s|sec|seconds?)?/gi;
  while ((m = waitRe.exec(raw))) {
    let ms = Number(m[1]);
    if (!m[2] || /^s/.test(m[2])) ms = m[2] && m[2].startsWith('ms') ? ms : ms * 1000;
    result.actions.push({ type: 'wait', ms: Math.min(ms, 8000) });
  }
  if (/\b(first two|two images|product images|each product|every product|all products|product pages?)\b/.test(lower) && /\b(images?|photos?|pictures?|gallery)\b/.test(lower)) {
    result.productShots = true;
  } else if (/\bcrawl\b|\balso copy\b|\bcollection page\b/.test(lower)) result.crawl = true;
  if (/\bscroll\b/.test(lower)) {
    result.actions.push({ type: 'scroll', to: /footer/.test(lower) ? 'footer' : 'bottom' });
  }
  result.actions = result.actions.filter((a) => ALLOWED_ACTIONS.has(a.type));
  return result;
}

module.exports = { parseCapturePrompt, ALLOWED_ACTIONS };
