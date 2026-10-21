const ALLOWED_PROPS = new Set([
  'color', 'background', 'background-color', 'background-position', 'background-repeat', 'background-size',
  'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
  'text-align', 'text-decoration', 'text-decoration-line', 'text-transform', 'white-space',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'gap', 'row-gap', 'column-gap',
  'border', 'border-radius', 'border-color', 'border-width', 'border-style',
  'border-top', 'border-right', 'border-bottom', 'border-left',
  'width', 'max-width', 'min-width', 'height', 'max-height', 'min-height',
  'display', 'visibility', 'opacity', 'overflow', 'object-fit',
  'position', 'top', 'right', 'bottom', 'left', 'z-index',
  'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'justify-content', 'align-items', 'align-content', 'align-self', 'order',
  'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row', 'grid-auto-flow', 'justify-self', 'place-items', 'place-content',
  'box-shadow', 'transform', 'cursor', 'list-style', 'list-style-type',
  'inset', 'float', 'clear', 'aspect-ratio', 'object-position',
]);
const DISPLAY = new Set(['none', 'block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'contents']);
const POSITION = new Set(['static', 'relative', 'absolute', 'sticky']);

const BANNED = [/@import/i, /url\s*\(/i, /expression\s*\(/i, /javascript:/i, /</, /<\//, /behavior\s*:/i];

function validateCss(css) {
  if (typeof css !== 'string') return { ok: false, error: "Couldn't apply that, try rephrasing" };
  if (css.length > 8000) return { ok: false, error: "Couldn't apply that, try rephrasing" };
  if (BANNED.some((re) => re.test(css))) return { ok: false, error: "Couldn't apply that, try rephrasing" };

  const cleaned = [];
  const blocks = css.split('}');
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const brace = trimmed.indexOf('{');
    if (brace === -1) continue;
    const selector = trimmed.slice(0, brace).trim();
    if (!selector || /@|[\x00-\x08]/.test(selector)) continue;
    const decls = trimmed.slice(brace + 1).split(';');
    const keep = [];
    for (const decl of decls) {
      const colon = decl.indexOf(':');
      if (colon === -1) continue;
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const value = decl.slice(colon + 1).trim();
      if (!ALLOWED_PROPS.has(prop) || !valueOk(prop, value)) continue;
      keep.push(`  ${prop}: ${value};`);
    }
    if (keep.length) cleaned.push(`${selector} {\n${keep.join('\n')}\n}`);
  }
  if (!cleaned.length) return { ok: false, error: "Couldn't apply that, try rephrasing" };
  return { ok: true, css: cleaned.join('\n\n') };
}

function valueOk(prop, value) {
  if (!value || value.length > 280) return false;
  if (BANNED.some((re) => re.test(value))) return false;
  if (prop === 'display') return DISPLAY.has(value.toLowerCase());
  if (prop === 'visibility') return ['hidden', 'visible', 'collapse'].includes(value.toLowerCase());
  if (prop === 'opacity') return /^(0|1|0?\.\d+)$/.test(value);
  if (prop === 'position') return POSITION.has(value.toLowerCase());
  if (prop === 'z-index') return /^-?\d{1,4}$/.test(value);
  if (prop === 'float') return ['left', 'right', 'none'].includes(value.toLowerCase());
  if (prop === 'clear') return ['left', 'right', 'both', 'none'].includes(value.toLowerCase());
  if (prop === 'order') return /^-?\d{1,3}$/.test(value);
  return true;
}

const COLORS = {
  black: '#111111', white: '#ffffff', red: '#c45c4a', blue: '#3ec6e0',
  green: '#3d8b6e', grey: '#8a9aa4', gray: '#8a9aa4', orange: '#d4a017',
  navy: '#0e2740', beige: '#e8e4d9',
};

function namedColor(phrase) {
  const hex = String(phrase || '').match(/#([0-9a-f]{3,8})\b/i);
  if (hex) return `#${hex[1]}`;
  const lower = String(phrase || '').toLowerCase();
  for (const [name, val] of Object.entries(COLORS)) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) return val;
  }
  return null;
}

function cssFromInstruction(instruction, outline) {
  const text = String(instruction || '').trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (/\b(popup|pop-up|modal|overlay|banner|cookie|consent)\b/.test(lower) && /\b(remove|hide|close|dismiss|off)\b/.test(lower)) {
    return '#onetrust-consent-sdk, #onetrust-banner-sdk, .onetrust-pc-dark-filter, [id*="cookie"], [class*="cookie"], [id*="consent"], [class*="consent"], [role="dialog"], [aria-modal="true"] { display: none }';
  }
  const question = /\?\s*$/.test(text) || /^(what|why|how|who|when)\b/.test(lower);
  if (question && !/\b(change|make|set|switch|update|restyle)\b/.test(lower)) return null;
  const sections = outline?.sections || [];
  let selector = 'body';
  for (const s of sections) {
    const token = (s.selector || '').replace(/[^a-z]/gi, '').toLowerCase();
    if (token && lower.includes(token) && s.selector) {
      selector = s.selector;
      break;
    }
  }
  if (/header|nav|top bar/.test(lower)) selector = sections.find((s) => /header|nav/i.test(s.selector || ''))?.selector || 'header, nav';
  else if (/footer/.test(lower)) selector = 'footer';
  else if (/button/.test(lower)) selector = 'button, .btn, a.button';
  else if (/hero/.test(lower)) selector = sections.find((s) => /hero|banner|section/i.test(`${s.selector || ''} ${s.snippet || ''}`))?.selector || 'main, section';

  const decls = [];
  const bgPhrase = (lower.match(/background(?:\s+color)?\s+(?:to\s+)?([#a-z0-9]+)/) || [])[1];
  const textPhrase = (lower.match(/(?:text|foreground|font)\s+(?:color\s+)?(?:to\s+)?([#a-z0-9]+)/) || [])[1];
  const bg = bgPhrase ? namedColor(bgPhrase) : null;
  const fg = textPhrase ? namedColor(textPhrase) : null;
  if (bg) decls.push(`background-color: ${bg}`);
  if (fg) decls.push(`color: ${fg}`);
  if (!bg && !fg) {
    const color = namedColor(text);
    if (color && /text|color|foreground/.test(lower)) decls.push(`color: ${color}`);
    else if (color) decls.push(`background-color: ${color}`);
  }
  if (/hide|hidden|remove the|remove it/.test(lower)) decls.push('display: none');
  if (/center/.test(lower)) decls.push('text-align: center');
  if (/bold/.test(lower)) decls.push('font-weight: 700');
  if (/bigger|larger/.test(lower)) decls.push('font-size: 1.35em');
  if (/smaller/.test(lower)) decls.push('font-size: 0.85em');
  const size = lower.match(/(\d+)\s*px/);
  if (size && /font|text|size/.test(lower)) decls.push(`font-size: ${size[1]}px`);
  const namedFace = text.match(/\b(Georgia|Inter|Arial|Helvetica|Verdana|Garamond|Courier|Menlo|Monaco|system-ui|Times New Roman|Times)\b/i);
  const fontPhrase = text.match(/\b(?:font|typeface)\s+(?:to|as|be)\s+["']?([A-Za-z][A-Za-z0-9 .'-]{1,32})/i);
  let face = namedFace ? namedFace[1] : '';
  if (!face && fontPhrase) {
    face = fontPhrase[1].replace(/\b(for|on|in|the|all|headings?|headers?|body|text|everywhere)\b.*$/i, '').trim();
    if (/\b(would|could|should|you|use|what|how)\b/i.test(face)) face = '';
  }
  if (face && /font|typeface|heading|georgia|inter|arial|helvetica|verdana|garamond|times|courier/i.test(text)) {
    decls.push(`font-family: "${face.replace(/"/g, '')}", ${/times|georgia|garamond/i.test(face) ? 'serif' : 'sans-serif'}`);
  }
  if (/heading/.test(lower)) selector = 'h1, h2, h3, h4';
  const first = sections.find((s) => s.selector && !/footer|nav|skip/i.test(s.selector));
  const moving = /\b(move|push|shift|nudge|drop)\b/.test(lower);
  const down = moving && /\b(down|lower|below)\b/.test(lower);
  const up = moving && /\b(up|higher)\b/.test(lower);
  const firstBlock = /\b(first|top)\b/.test(lower) && /\b(section|block|part|area|page|preview)\b/.test(lower);
  if (firstBlock) selector = 'body';
  else if (/\bheader\b/.test(lower) && first?.selector) selector = first.selector;
  const shift = size && /move|push|shift|nudge|margin|padding|down|up/.test(lower) ? `${size[1]}px` : '88px';
  if (down) decls.push(`${firstBlock ? 'padding-top' : 'margin-top'}: ${shift}`);
  else if (up) decls.push(`${firstBlock ? 'padding-top' : 'margin-top'}: 0`);
  if (!decls.length) return null;
  return `${selector} {\n${decls.map((d) => '  ' + d + ';').join('\n')}\n}`;
}

module.exports = { validateCss, cssFromInstruction };
