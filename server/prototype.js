function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractBlocks(html, tag) {
  const blocks = [];
  const lower = html.toLowerCase();
  const open = `<${tag}`;
  const close = `</${tag}`;
  let from = 0;
  while (from < html.length) {
    const start = lower.indexOf(open, from);
    if (start === -1) break;
    const nextChar = lower[start + open.length];
    if (nextChar && /[a-z0-9]/.test(nextChar)) {
      from = start + open.length;
      continue;
    }
    let depth = 1;
    let i = lower.indexOf('>', start);
    if (i === -1) break;
    i += 1;
    let end = -1;
    while (i < html.length && depth > 0) {
      const nextOpen = lower.indexOf(open, i);
      const nextClose = lower.indexOf(close, i);
      if (nextClose === -1) return blocks;
      const openOk = nextOpen !== -1 && !/[a-z0-9]/.test(lower[nextOpen + open.length] || '');
      if (openOk && nextOpen < nextClose) {
        depth += 1;
        i = nextOpen + open.length;
      } else {
        depth -= 1;
        if (depth === 0) end = html.indexOf('>', nextClose) + 1;
        i = nextClose + close.length;
      }
    }
    if (end > start) blocks.push({ start, end, html: html.slice(start, end), tag });
    from = end > 0 ? end : i;
  }
  return blocks;
}

function labelOf(chunk) {
  const id = (chunk.match(/\bid=["']([^"']+)/i) || [])[1] || '';
  const cls = (chunk.match(/\bclass=["']([^"']+)/i) || [])[1] || '';
  const text = chunk.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return `${id} ${cls} ${text}`.toLowerCase();
}

function allBlocks(html) {
  const tags = ['header', 'nav', 'footer', 'main', 'section', 'aside', 'article'];
  const blocks = [];
  for (const tag of tags) {
    for (const block of extractBlocks(html, tag)) {
      blocks.push({ ...block, label: `${tag} ${labelOf(block.html)}` });
    }
  }
  return blocks.sort((a, b) => a.start - b.start);
}

function findBlock(html, word) {
  const name = String(word || '').toLowerCase().replace(/^(the|a|an)\s+/, '').trim();
  if (!name) return null;
  return allBlocks(html).find((block) => block.tag === name || block.label.includes(name)) || null;
}

function ensureStyle(html) {
  if (html.includes('data-proto-brand')) return html;
  const tag = '<style data-proto-brand="1">.pb-wordmark{font:600 1.35rem/1 Georgia,serif;letter-spacing:-.03em;display:inline-block;color:inherit}</style>';
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}</head>`);
  return tag + html;
}

function findLogo(html) {
  const word = html.match(/<span class="pb-wordmark">[\s\S]*?<\/span>/i);
  if (word) return { start: word.index, end: word.index + word[0].length, html: word[0], kind: 'text' };
  const regions = [...extractBlocks(html, 'header'), ...extractBlocks(html, 'nav')];
  const scopes = regions.length ? regions : [{ start: 0, html: html.slice(0, 12000) }];
  for (const scope of scopes) {
    const marked = scope.html.match(/<(img|svg)\b[^>]*(logo|brand|wordmark)[^>]*>/i);
    if (!marked) continue;
    if (marked[1].toLowerCase() === 'img') {
      const start = scope.start + marked.index;
      return { start, end: start + marked[0].length, html: marked[0], kind: 'img' };
    }
    const hit = extractBlocks(scope.html, 'svg').find((block) => /logo|brand|wordmark/i.test(block.html.slice(0, 240)));
    if (hit) return { start: scope.start + hit.start, end: scope.start + hit.end, html: hit.html, kind: 'svg' };
  }
  for (const scope of scopes) {
    const img = scope.html.match(/<img\b[^>]*>/i);
    if (img) {
      const start = scope.start + img.index;
      return { start, end: start + img[0].length, html: img[0], kind: 'img' };
    }
    const svg = extractBlocks(scope.html, 'svg')[0];
    if (svg) return { start: scope.start + svg.start, end: scope.start + svg.end, html: svg.html, kind: 'svg' };
  }
  return null;
}

function replaceRange(html, range, next) {
  return html.slice(0, range.start) + next + html.slice(range.end);
}

function replaceLogo(html, { text, src }) {
  const logo = findLogo(html);
  if (!logo) return { error: 'There is no logo in the header.' };
  if (text) {
    const styled = ensureStyle(html);
    const shifted = findLogo(styled);
    return {
      html: replaceRange(styled, shifted, `<span class="pb-wordmark">${escapeHtml(text)}</span>`),
      line: `Replaced the logo with ${text}.`,
    };
  }
  const safe = String(src || '');
  if (!/^assets\/[a-z0-9._-]+$/i.test(safe)) return { error: 'Attach your logo image, then say replace the logo with mine.' };
  let next;
  if (logo.kind === 'img') {
    next = /\ssrc=/i.test(logo.html)
      ? logo.html.replace(/\ssrc=(["'])[^"']*\1/i, ` src="${safe}"`)
      : logo.html.replace(/<img/i, `<img src="${safe}"`);
  } else {
    next = `<img class="pb-logo" src="${safe}" alt="Logo">`;
  }
  return { html: replaceRange(html, logo, next), line: 'Replaced the logo with your image.' };
}

function replaceHeadline(html, text) {
  const heading = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/i);
  if (!heading) return { error: 'This page has no headline to change.' };
  const next = heading[0].replace(/>[\s\S]*<\/h1>/i, `>${escapeHtml(text)}</h1>`);
  return { html: html.replace(heading[0], next), line: `Set the headline to ${text}.` };
}

function replaceVisible(html, from, to) {
  const re = new RegExp(`(>[^<]{0,400})${escapeRe(from)}`, 'i');
  if (!re.test(html)) return { error: `“${from}” is not on this page.` };
  return {
    html: html.replace(re, `$1${escapeHtml(to)}`),
    line: `Replaced “${from}” with “${to}”.`,
  };
}

function swapRanges(html, a, b) {
  const first = a.start < b.start ? a : b;
  const second = a.start < b.start ? b : a;
  if (first.end > second.start) return { error: 'Those two parts overlap, so I left them where they are.' };
  return html.slice(0, first.start) + second.html + html.slice(first.end, second.start) + first.html + html.slice(second.end);
}

function moveBlock(html, node, anchor, where) {
  if (node.start === anchor.start) return { error: 'Pick two different parts of the page.' };
  if ((node.start < anchor.start && node.end > anchor.start) || (anchor.start < node.start && anchor.end > node.start)) {
    return { error: 'Those two parts overlap, so I left them where they are.' };
  }
  const without = html.slice(0, node.start) + html.slice(node.end);
  const delta = node.end - node.start;
  let start = anchor.start;
  let end = anchor.end;
  if (anchor.start > node.start) {
    start -= delta;
    end -= delta;
  }
  const at = where === 'before' ? start : end;
  return { html: without.slice(0, at) + node.html + without.slice(at) };
}

function tidy(value) {
  return String(value || '')
    .replace(/\s+like\s+(?:the\s+)?first\s+thing\b.*$/i, '')
    .replace(/[."”]+$/g, '')
    .replace(/^(the|a|an)\s+/i, '')
    .trim();
}

function normalizeInstruction(text) {
  return String(text || '')
    .replace(/\bmorelink\b/gi, 'more link')
    .replace(/\bablove\b/gi, 'above')
    .replace(/\babov\b/gi, 'above')
    .replace(/\bleav\w+\s+more\s+link\b/gi, 'learn more link');
}

function findPiece(html, phrase) {
  const raw = tidy(phrase).toLowerCase();
  const iconish = /\b(icon|svg|book)\b/.test(raw) && !/\b(link|button|headline|text)\b/.test(raw);
  if (iconish || raw === 'icon' || raw === 'image') {
    const icon = html.match(/<svg\b[\s\S]*?<\/svg>/i) || html.match(/<img\b[^>]*>/i);
    if (!icon) return null;
    return { start: icon.index, end: icon.index + icon[0].length, html: icon[0] };
  }
  const words = raw
    .replace(/\b(link|button|text|item)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word && word !== 'the');
  if (!words.length) return null;
  const re = /<(a|button|h1|h2|h3|p|li|span)\b[^>]*>[\s\S]*?<\/\1>/gi;
  let match;
  let best = null;
  while ((match = re.exec(html))) {
    const visible = match[0].replace(/<[^>]+>/g, ' ').toLowerCase();
    if (!words.every((word) => visible.includes(word))) continue;
    if (!best || match[0].length < best.html.length) {
      best = { start: match.index, end: match.index + match[0].length, html: match[0] };
    }
  }
  return best;
}

function placeParts(text) {
  const relation = text.match(/(.{2,60}?)\s+(?:should be|needs to be|goes|go|be)\s+(above|over|before|below|under|after)\s+(?:the\s+)?(.{2,60})/i);
  if (relation) return { node: tidy(relation[1]), where: relation[2], anchor: tidy(relation[3]) };
  const directed = text.match(/\b(?:make|move|put|place|shift)\s+(?:the\s+)?(.{2,60}?)\s+(up|higher|above|down|lower|below)\b(?:\s+(?:the\s+)?(.{2,60}))?/i);
  if (directed) return { node: tidy(directed[1]), where: directed[2], anchor: tidy(directed[3] || '') };
  return null;
}

function applyPrototype(html, instruction, opts = {}) {
  const text = normalizeInstruction(instruction).trim();
  if (!text || !html) return null;
  const lower = text.toLowerCase();

  if (/\blogo\b/.test(lower) && /\b(my logo|with mine|with my image|this image|uploaded logo)\b/.test(lower)) {
    return replaceLogo(html, { src: opts.logoSrc });
  }

  const logoText = text.match(/\b(?:replace|change|swap|turn)\s+(?:the\s+)?logo\s+(?:with|to|into)\s+(?:the\s+)?(?:text|words?|wordmark\s+)?["“]?([^"”\n]+?)["”]?\s*$/i);
  if (logoText && !/\b(image|picture|photo|mine)\b/i.test(logoText[1])) {
    const word = tidy(logoText[1]).replace(/^(the\s+)?(text|words?|wordmark)\s+/i, '');
    if (word) return replaceLogo(html, { text: word });
  }

  const headline = text.match(/\b(?:change|replace|set|make)\s+(?:the\s+)?(headline|heading|title|hero text|button text)\s+(?:to|with|say)\s+["“]?([^"”\n]+?)["”]?\s*$/i);
  if (headline) return replaceHeadline(html, tidy(headline[2]));

  const quoted = text.match(/\breplace\s+["“]([^"”]+)["”]\s+with\s+["“]([^"”]+)["”]/i);
  if (quoted) return replaceVisible(html, quoted[1], quoted[2]);

  const move = text.match(/\b(?:move|put|place)\s+(?:the\s+)?(.{2,40}?)\s+(below|under|after|above|over|before)\s+(?:the\s+)?(.{2,40}?)\s*$/i);
  if (move) {
    const node = findBlock(html, tidy(move[1]));
    const anchor = findBlock(html, tidy(move[3]));
    if (node && anchor) {
      const where = /above|over|before/.test(move[2]) ? 'before' : 'after';
      const moved = moveBlock(html, node, anchor, where);
      if (moved.error) return moved;
      return { html: moved.html, line: `Moved the ${tidy(move[1])} ${move[2]} the ${tidy(move[3])}.` };
    }
  }

  const swap = text.match(/\b(?:swap|switch)\s+(?:the\s+)?(.{2,40}?)\s+(?:and|with)\s+(?:the\s+)?(.{2,40}?)\s*$/i)
    || text.match(/\breplace\s+(?:the\s+)?(.{2,40}?)\s+with\s+(?:the\s+)?(header|nav|footer|hero|main|newsletter|products?|banner|sidebar)\b(?:\s+(?:section|block|ui))?\s*$/i);
  if (swap) {
    const a = findBlock(html, tidy(swap[1]));
    const b = findBlock(html, tidy(swap[2]));
    if (!a || !b) return { error: 'Those two parts are not both on this page.' };
    const htmlNext = swapRanges(html, a, b);
    if (typeof htmlNext !== 'string') return htmlNext;
    return { html: htmlNext, line: `Swapped the ${tidy(swap[1])} and the ${tidy(swap[2])}.` };
  }

  const place = placeParts(text);
  if (place) {
    const node = findPiece(html, place.node) || findBlock(html, place.node);
    let anchor = place.anchor ? (findPiece(html, place.anchor) || findBlock(html, place.anchor)) : null;
    const upward = /above|over|before|up|higher/.test(place.where);
    if (!anchor && upward && node) {
      const region = html.slice(0, node.start);
      const icons = [...region.matchAll(/<svg\b[\s\S]*?<\/svg>|<img\b[^>]*>/gi)];
      const last = icons[icons.length - 1];
      if (last) anchor = { start: last.index, end: last.index + last[0].length, html: last[0] };
    }
    if (!node) return { error: `“${place.node}” is not on this page.` };
    if (!anchor) return { error: 'Name the part it should sit above or below. For example: move the learn more link above the icon.' };
    const moved = moveBlock(html, node, anchor, upward ? 'before' : 'after');
    if (moved.error) return moved;
    let htmlNext = moved.html;
    if (upward && /<svg\b|<img\b/i.test(anchor.html)) {
      if (!/pb-raised/.test(node.html)) {
        const stamped = node.html.replace(/^<([a-z0-9]+)/i, '<$1 class="pb-raised"');
        htmlNext = htmlNext.replace(node.html, stamped);
      }
      if (!htmlNext.includes('data-proto-place')) {
        const fix = '<style data-proto-place>.pb-raised{display:block;margin:0 auto 12px}svg,img{margin-top:.75em !important}</style>';
        htmlNext = htmlNext.includes('</body>') ? htmlNext.replace('</body>', `${fix}</body>`) : htmlNext + fix;
      }
    }
    const relation = upward ? 'above' : 'below';
    const target = place.anchor || 'the icon';
    const label = (value) => (/^(the|a|an)\b/i.test(value) ? value : `the ${value}`);
    return { html: htmlNext, line: `Moved ${label(place.node)} ${relation} ${label(target)}.` };
  }

  return null;
}

module.exports = { applyPrototype, findLogo, findBlock, replaceVisible };
