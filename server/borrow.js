const fs = require('fs');
const path = require('path');

function elementAt(html, index) {
  const open = String(html || '').slice(index).match(/^<([a-z0-9]+)\b[^>]*>/i);
  if (!open) return '';
  const tag = open[1].toLowerCase();
  if (['img', 'br', 'hr', 'input', 'meta', 'link', 'source'].includes(tag)) return open[0];
  const re = new RegExp(`<${tag}\\b[^>]*>|<\\/${tag}>`, 'gi');
  re.lastIndex = index;
  let depth = 0;
  let match;
  while ((match = re.exec(html))) {
    if (match[0][1] === '/') depth -= 1;
    else depth += 1;
    if (depth === 0) return html.slice(index, match.index + match[0].length);
  }
  return '';
}

function extractPart(html, part) {
  const source = String(html || '');
  const idRe = part === 'footer'
    ? /<([a-z0-9]+)\b[^>]*\bid=["'][^"']*footer[^"']*["'][^>]*>/gi
    : /<(div|header|nav)\b[^>]*\bid=["'][^"']*(?:globalheader|commerce-header|site-header|globalnav)[^"']*["'][^>]*>/gi;
  let match;
  while ((match = idRe.exec(source))) {
    if (/modal|cookie|consent/i.test(match[0])) continue;
    const block = elementAt(source, match.index);
    if (block.length > 80) return block;
  }
  const tag = part === 'nav' ? 'nav' : part;
  const tagRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  let best = '';
  while ((match = tagRe.exec(source))) {
    if (/modal|cookie|consent/i.test(match[0])) continue;
    const block = elementAt(source, match.index);
    if (block.length > best.length) best = block;
  }
  if (best) return best;
  if (part === 'header') return extractPart(source, 'nav');
  return '';
}

function retarget(html, prefix) {
  return String(html || '').replace(/(src|href)=(["'])(?!https?:|\/\/|data:|#|mailto:|tel:)([^"']+)\2/gi, (full, attr, quote, val) => {
    if (val.startsWith('/preview/')) return full;
    const clean = val.replace(/^\.\//, '').replace(/^\//, '');
    return `${attr}=${quote}${prefix}${clean}${quote}`;
  });
}

function swapPart(currentHtml, donorHtml, part, donorPrefix) {
  const incoming = retarget(extractPart(donorHtml, part), donorPrefix);
  if (!incoming) return null;
  const current = extractPart(currentHtml, part);
  if (current) return currentHtml.replace(current, incoming);
  if (part === 'footer') return currentHtml.replace(/<\/body>/i, `${incoming}</body>`);
  return currentHtml.replace(/<body[^>]*>/i, (open) => `${open}${incoming}`);
}

function readJobHtml(dir) {
  const file = path.join(dir, 'index.html');
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

module.exports = { extractPart, retarget, swapPart, readJobHtml };
