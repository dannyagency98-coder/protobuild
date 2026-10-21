const ALLOWED = new Set([
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
const BANNED = [/@import/i, /url\s*\(/i, /expression\s*\(/i, /javascript:/i, /</i];

export function validateCss(css) {
  if (typeof css !== 'string' || css.length > 8000) return { ok: false, error: "Couldn't apply that, try rephrasing" };
  if (BANNED.some((re) => re.test(css))) return { ok: false, error: "Couldn't apply that, try rephrasing" };
  const cleaned = [];
  for (const block of css.split('}')) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const brace = trimmed.indexOf('{');
    if (brace === -1) continue;
    const selector = trimmed.slice(0, brace).trim();
    if (!selector || /@/.test(selector)) continue;
    const keep = [];
    for (const decl of trimmed.slice(brace + 1).split(';')) {
      const colon = decl.indexOf(':');
      if (colon === -1) continue;
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const value = decl.slice(colon + 1).trim();
      if (!ALLOWED.has(prop) || !valueOk(prop, value)) continue;
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
