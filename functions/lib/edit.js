function escapeHtml(value) {
  return String(value || '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

function escapeRe(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function applyReplacements(html, list) {
  let next = String(html || '');
  const notes = [];
  for (const item of (Array.isArray(list) ? list : []).slice(0, 8)) {
    const from = String(item?.from || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const to = String(item?.to || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!from || from === to) continue;
    const re = new RegExp(`(>[^<]{0,400})${escapeRe(from)}`, 'i');
    if (!re.test(next)) continue;
    next = next.replace(re, `$1${escapeHtml(to)}`);
    notes.push(`Replaced “${from}” with “${to}”.`);
  }
  return { html: next === html ? '' : next, notes };
}
