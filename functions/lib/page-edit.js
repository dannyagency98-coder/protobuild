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

function shortest(html, test) {
  const hits = ranges(html).filter((item) => {
    if (SKIP.has(item.name)) return false;
    const inner = html.slice(item.innerStart, item.innerEnd);
    const size = item.end - item.start;
    if (size < 20 || size > 30000) return false;
    return test(item, inner);
  });
  hits.sort((a, b) => (a.end - a.start) - (b.end - b.start));
  return hits[0] || null;
}

export function dropCookie(html) {
  const byName = shortest(html, (item) => /cookie|consent|onetrust|cookiebot|gdpr|didomi|trustarc|privacy-banner|cc-banner|cc-window/i.test(item.attrs));
  if (byName) return cut(html, byName.start, byName.end);
  const byText = shortest(html, (item, inner) => /cookie settings|accept all|cookie policy|personalise cookie|continue without accepting/i.test(inner));
  if (byText) return cut(html, byText.start, byText.end);
  return html;
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

export function dropAsked(html, message) {
  const text = String(message || '').toLowerCase();
  if (!/\b(remove|hide|delete|close|dismiss|clear|get rid)\b/.test(text)) return '';
  if (/cookie|consent|gdpr|banner|popup|pop-up|modal|dialog|overlay/.test(text)) {
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
