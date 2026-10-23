const SKIP = new Set(['html', 'body', 'head', 'script', 'style']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function ranges(html) {
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)\b([^>]*)>/g;
  const stack = [];
  const found = [];
  let match;
  while ((match = re.exec(html))) {
    const full = match[0];
    if (full.startsWith('<!--')) continue;
    const name = String(match[1] || '').toLowerCase();
    if (!name) continue;
    const closing = full.startsWith('</');
    const self = /\/>$/.test(full) || VOID.has(name);
    if (!closing) {
      stack.push({ name, attrs: match[2] || '', start: match.index, openEnd: match.index + full.length, self });
      if (self) {
        const item = stack.pop();
        found.push({ ...item, end: item.openEnd, innerStart: item.openEnd, innerEnd: item.openEnd });
      }
      continue;
    }
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i].name !== name) continue;
      const open = stack[i];
      stack.length = i;
      found.push({ ...open, end: match.index + full.length, innerStart: open.openEnd, innerEnd: match.index });
      break;
    }
  }
  return found;
}

function cut(html, start, end) {
  return html.slice(0, start) + html.slice(end);
}

function shortest(html, test, max = 30000) {
  const hits = ranges(html).filter((item) => {
    if (SKIP.has(item.name)) return false;
    const inner = html.slice(item.innerStart, item.innerEnd);
    const size = item.end - item.start;
    if (size < 20 || size > max) return false;
    return test(item, inner);
  });
  hits.sort((a, b) => (a.end - a.start) - (b.end - b.start));
  return hits[0] || null;
}

const COOKIE_TEXT = /cookie|consent|gdpr|onetrust|cookiebot|aceptar todas|aceptar solo|configuraci[oó]n de cookies|cookies t[eé]cnicas|accept all|accept only|cookie settings|cookie policy|we use cookies|uso de cookies|pol[ií]tica de cookies/i;

export function asksCookie(message) {
  const text = String(message || '').toLowerCase();
  return /\b(remo\w*|hide|delete|dismiss|clear|close|rid)\b/.test(text) && /cookie|consent|gdpr|banner/.test(text);
}

export function dropCookie(html) {
  let next = String(html || '');
  for (let pass = 0; pass < 12; pass += 1) {
    const byName = shortest(next, (item) => /cookie|consent|onetrust|cookiebot|gdpr|didomi|trustarc|privacy-banner|cc-banner|cc-window|ot-sdk/i.test(item.attrs), 200000);
    const byText = shortest(next, (item, inner) => COOKIE_TEXT.test(inner.replace(/<[^>]+>/g, ' ')), 200000);
    const hit = byName || byText;
    if (!hit) break;
    const parent = climbCookie(next, hit);
    const cutHtml = cut(next, parent.start, parent.end);
    if (cutHtml === next) break;
    next = cutHtml;
  }
  if (next === html) return html;
  if (!next.includes('data-proto-cookie')) {
    const hide = '<style data-proto-cookie>[class*="cookie" i],[id*="cookie" i],[class*="consent" i],[id*="onetrust" i],[class*="onetrust" i]{display:none!important}</style>';
    next = /<head[^>]*>/i.test(next) ? next.replace(/<head[^>]*>/i, (open) => `${open}${hide}`) : `${hide}${next}`;
  }
  return next;
}

function climbCookie(html, hit) {
  let current = hit;
  const all = ranges(html);
  for (let guard = 0; guard < 5; guard += 1) {
    const parent = all.find((item) => item.start < current.start && item.end > current.end && !SKIP.has(item.name) && item.name !== 'header' && item.name !== 'nav');
    if (!parent) break;
    const size = parent.end - parent.start;
    if (size > 180000) break;
    const inner = html.slice(parent.innerStart, parent.innerEnd);
    const text = inner.replace(/<[^>]+>/g, ' ');
    if (/<img\b/i.test(inner) && !/<img\b/i.test(html.slice(current.innerStart, current.innerEnd))) break;
    if (!COOKIE_TEXT.test(text)) break;
    if (size > (current.end - current.start) * 4 && text.length > 4000) break;
    current = parent;
  }
  return current;
}

export function dropPhrase(html, phrase) {
  const needle = String(phrase || '').replace(/\s+/g, ' ').trim();
  if (needle.length < 3) return html;
  const hit = shortest(html, (item, inner) => inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase().includes(needle.toLowerCase()));
  if (!hit) return html;
  return cut(html, hit.start, hit.end);
}

const SECTION = {
  header: /header|banner|masthead/i,
  nav: /nav|menu|navigation/i,
  footer: /footer/i,
  hero: /hero|banner|jumbotron/i,
};

export function sectionKind(message) {
  const text = String(message || '').toLowerCase();
  if (/\bfooter\b/.test(text)) return 'footer';
  if (/\b(nav|menu|navigation)\b/.test(text)) return 'nav';
  if (/\b(hero|banner)\b/.test(text)) return 'hero';
  return 'header';
}

export function wantsEdit(message) {
  return /\b(change|edit|restyle|recolou?r|swap|replace|remove|hide|delete)\b|\b(make|turn|move|update) (the|this|it|that)\b|\b(bigger|smaller|larger|bolder)\b/i.test(String(message || ''));
}

export function wantsBorrow(message) {
  return wantsEdit(message)
    && /\b(swap|replace|use|take|copy|bring|grab)\b/i.test(String(message || ''))
    && /\b(header|nav|menu|navigation|footer|hero|banner|button|section|component)\b/i.test(String(message || ''));
}

export function wantsPreviewFile(message) {
  const text = String(message || '');
  if (/\b(detail|details|text|copy|price|prices|content|words|info|information|heading|title)\b/i.test(text)
    && /\b(on|onto|into) (the |this )?(site|page|screen|preview)\b/i.test(text)) return false;
  return /\b(put|place|open|show|preview|display|load|add)\b[^.?\n]{0,48}\b(file|files|page|html|zip|website|document)\b[^.?\n]{0,48}\b(preview|phone|screen)\b/i.test(text)
    || /\b(use|make) (this |the |these )?(file|files|page|html|website) (as|for) (the )?(preview|phone|screen)\b/i.test(text);
}

export function wantsApplyFile(message) {
  const text = String(message || '');
  return /\b(swap|replace|use|take|copy|apply|put|add|bring)\b/i.test(text)
    && /\b(detail|details|text|copy|price|prices|content|words|info|information|heading|title|name)\b/i.test(text)
    && /\b(file|files|document|documents|doc|attachment|this|these)\b/i.test(text);
}

export function fileLooksHtml(text) {
  return /<(?:html|body|header|main|section|div|img)\b/i.test(String(text || ''));
}

function takeSection(html, kind) {
  const test = SECTION[kind] || SECTION.header;
  const hits = ranges(html).filter((item) => {
    if (SKIP.has(item.name)) return false;
    const size = item.end - item.start;
    if (size < 40 || size > 80000) return false;
    if (item.name === kind) return true;
    return test.test(`${item.name} ${item.attrs}`);
  });
  hits.sort((a, b) => {
    const prefer = (item) => (item.name === kind ? 0 : 1);
    return prefer(a) - prefer(b) || (a.end - a.start) - (b.end - b.start);
  });
  return hits[0] || null;
}

export function absolutizeFragment(html, base) {
  return String(html || '').replace(/(\s(?:src|href)=)(["'])([^"']+)\2/gi, (all, attr, quote, url) => {
    if (/^(https?:|data:|#|mailto:|tel:)/i.test(url)) return all;
    try { return `${attr}${quote}${new URL(url, base).href}${quote}`; } catch { return all; }
  });
}

export function swapSection(page, fragment, kind) {
  const incoming = takeSection(fragment, kind);
  const local = takeSection(page, kind);
  if (!incoming || !local) return '';
  const chunk = fragment.slice(incoming.start, incoming.end).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  return page.slice(0, local.start) + chunk + page.slice(local.end);
}

function escapeText(value) {
  return String(value || '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

function linkTargets(html) {
  const zones = ranges(html).filter((item) => item.name === 'header' || item.name === 'nav' || /nav|menu|header/i.test(item.attrs));
  const zone = zones.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
  const slice = zone ? html.slice(zone.start, zone.end) : html;
  const base = zone ? zone.start : 0;
  const found = [];
  const re = /<(a|button)\b[^>]*>[\s\S]*?<\/\1>/gi;
  let match;
  while ((match = re.exec(slice))) {
    const text = match[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 40) continue;
    found.push({ start: base + match.index, end: base + match.index + match[0].length, html: match[0] });
  }
  return found;
}

export function relabelAsked(html, message) {
  const text = String(message || '');
  if (!/\b(change|rename|replace|set|update|make)\b/i.test(text)) return '';
  if (!/\b(nav|menu|links?|buttons?|hero|label|text|heading|title)\b/i.test(text)) return '';
  const tail = text.split(/\bto\b/i).slice(1).join('to').replace(/[.?!]+$/g, '').trim();
  if (!tail) return '';
  const perLink = /\b(nav|menu|links?|buttons?)\b/i.test(text);
  const labels = perLink
    ? tail.split(/\s+/).filter((word) => word && !/^and$/i.test(word))
    : [tail];
  if (!labels.length) return '';
  if (!perLink) {
    const heading = String(html || '').match(/<(h1|h2)\b[^>]*>[\s\S]*?<\/\1>/i);
    if (!heading) return '';
    const next = heading[0].replace(/>([^<]{1,160})</, `>${escapeText(labels[0])}<`);
    if (next === heading[0]) return '';
    return html.replace(heading[0], next);
  }
  const targets = linkTargets(html);
  if (!targets.length) return '';
  let next = String(html || '');
  const count = Math.min(labels.length, targets.length);
  for (let i = count - 1; i >= 0; i -= 1) {
    const target = targets[i];
    const replaced = target.html.replace(/>([^<]{1,80})</, `>${escapeText(labels[i])}<`);
    if (replaced === target.html) continue;
    next = next.slice(0, target.start) + replaced + next.slice(target.end);
  }
  return next === html ? '' : next;
}

export function dropAsked(html, message) {
  const text = String(message || '').toLowerCase();
  if (!/\b(remo\w*|hide|delete|close|dismiss|clear|rid)\b/.test(text)) return '';
  if (/cookie|consent|gdpr|banner|popup|pop-up|modal|dialog|overlay/.test(text) || asksCookie(message)) {
    const next = dropCookie(html);
    if (next !== html) return next;
  }
  const quoted = String(message || '').match(/["“](.+?)["”]/);
  if (quoted) {
    const next = dropPhrase(html, quoted[1]);
    if (next !== html) return next;
  }
  return '';
}
