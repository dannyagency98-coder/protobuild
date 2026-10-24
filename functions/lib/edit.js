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
    const pattern = escapeRe(from).replace(/\\?\s+/g, '\\s+');
    const re = new RegExp(pattern, 'i');
    if (!re.test(next.replace(/<[^>]+>/g, ' '))) continue;
    const safe = escapeHtml(to);
    next = next.replace(/(>[^<]*)/g, (chunk) => chunk.replace(new RegExp(pattern, 'gi'), safe));
    notes.push(`Replaced “${from}” with “${to}”.`);
  }
  return { html: next === html ? '' : next, notes };
}
