const { validateCss } = require('./css-safe');
const { applyPrototype, replaceVisible } = require('./prototype');

function cleanText(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function applyModelPlan(html, plan) {
  let next = String(html || '');
  const notes = [];
  const replacements = Array.isArray(plan?.replace) ? plan.replace.slice(0, 8) : [];
  for (const item of replacements) {
    const from = cleanText(item?.from, 240);
    const to = cleanText(item?.to, 500);
    if (!from || from === to) continue;
    const result = replaceVisible(next, from, to);
    if (!result.html) continue;
    next = result.html;
    notes.push(result.line);
  }

  const move = plan?.move;
  const node = cleanText(move?.node, 80);
  const anchor = cleanText(move?.anchor, 80);
  const where = /below|under|after|down/i.test(move?.where || '') ? 'below' : 'above';
  if (node && anchor) {
    const moved = applyPrototype(next, `move the ${node} ${where} the ${anchor}`);
    if (moved?.html) {
      next = moved.html;
      notes.push(moved.line);
    }
  }

  let css = '';
  if (plan?.css) {
    const checked = validateCss(String(plan.css));
    if (checked.ok) css = checked.css;
  }
  return {
    html: next === html ? '' : next,
    css,
    notes,
  };
}

module.exports = { applyModelPlan };
