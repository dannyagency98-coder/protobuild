export function fontFile(type, url) {
  const kind = `${type || ''} ${url || ''}`.toLowerCase();
  if (kind.includes('woff2')) return { ext: '.woff2', type: 'font/woff2' };
  if (kind.includes('woff')) return { ext: '.woff', type: 'font/woff' };
  if (kind.includes('ttf') || kind.includes('font/sfnt')) return { ext: '.ttf', type: 'font/ttf' };
  if (kind.includes('otf')) return { ext: '.otf', type: 'font/otf' };
  return null;
}

export function imageFile(bytes, type) {
  const head = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (head.length < 8) return null;
  if (head[0] === 0x89 && head[1] === 0x50) return { ext: '.png', type: 'image/png' };
  if (head[0] === 0xff && head[1] === 0xd8) return { ext: '.jpg', type: 'image/jpeg' };
  if (head[0] === 0x47 && head[1] === 0x49) return { ext: '.gif', type: 'image/gif' };
  if (head[0] === 0x52 && head[1] === 0x49 && head[8] === 0x57) return { ext: '.webp', type: 'image/webp' };
  const text = new TextDecoder().decode(head.slice(0, 180)).trim();
  if (text.startsWith('<svg') || text.startsWith('<?xml')) return { ext: '.svg', type: 'image/svg+xml' };
  const kind = String(type || '').toLowerCase();
  if (kind.includes('png')) return { ext: '.png', type: 'image/png' };
  if (kind.includes('svg')) return { ext: '.svg', type: 'image/svg+xml' };
  if (kind.includes('webp')) return { ext: '.webp', type: 'image/webp' };
  if (kind.includes('gif')) return { ext: '.gif', type: 'image/gif' };
  if (kind.includes('avif')) return { ext: '.avif', type: 'image/avif' };
  if (kind.startsWith('image/')) return { ext: '.jpg', type: 'image/jpeg' };
  return null;
}

export function rewriteMirrored(html, pairs) {
  let next = String(html || '');
  const ordered = [...(pairs || [])]
    .map((pair) => ({ from: String(pair.from || ''), to: String(pair.to || '') }))
    .filter((pair) => pair.from && pair.to)
    .sort((a, b) => b.from.length - a.from.length);
  for (const pair of ordered) {
    const escaped = pair.from.replace(/&/g, '&amp;');
    next = next.split(pair.from).join(pair.to);
    if (escaped !== pair.from) next = next.split(escaped).join(pair.to);
  }
  return next;
}

export function pinLocalAssets(html, root) {
  if (!root) return String(html || '');
  const abs = (rel) => {
    try { return new URL(rel, root).href; } catch { return rel; }
  };
  return String(html || '')
    .replace(/(\s(?:src|href)=)(["'])(assets\/[^"']+)\2/gi, (all, attr, quote, url) => `${attr}${quote}${abs(url)}${quote}`)
    .replace(/srcset=(["'])([^"']+)\1/gi, (all, quote, val) => {
      const next = val.split(',').map((part) => {
        const bits = part.trim().split(/\s+/);
        if (bits[0] && /^assets\//i.test(bits[0])) bits[0] = abs(bits[0]);
        return bits.join(' ');
      }).join(', ');
      return `srcset=${quote}${next}${quote}`;
    })
    .replace(/url\((['"]?)(assets\/[^'")]+)\1\)/gi, (all, quote, url) => `url(${quote}${abs(url)}${quote})`);
}
