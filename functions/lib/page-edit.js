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
