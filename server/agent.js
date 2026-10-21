const dns = require('dns').promises;
const { cssFromInstruction, validateCss } = require('./css-safe');
const { completeChat } = require('./llm');

const SKIP = new Set([
  'this', 'that', 'it', 'page', 'site', 'sites', 'again', 'the', 'a', 'my',
  'your', 'please', 'now', 'today', 'website', 'web', 'link', 'url',
]);

function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return url || 'that page'; }
}

function explicitTargets(text) {
  const found = [];
  const urlRe = /https?:\/\/[^\s)]+/gi;
  let match;
  while ((match = urlRe.exec(text))) {
    found.push(match[0].replace(/[.,]$/, ''));
  }
  const domRe = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[^\s)]*)?/gi;
  while ((match = domRe.exec(text))) {
    const raw = match[0].replace(/[.,]$/, '');
    const href = `https://${raw}`;
    if (!found.some((item) => item.includes(raw))) found.push(href);
  }
  return found.slice(0, 2);
}

async function namedTarget(text) {
  const match = text.match(/\b(?:scan|capture|clone|open|grab|scrape|save|visit|copy|extract)\s+(?:the\s+)?(?:site\s+|page\s+|website\s+)?([a-z0-9][a-z0-9-]{1,48})\b/i);
  if (!match) return '';
  const name = match[1].toLowerCase();
  if (SKIP.has(name)) return '';
  if (name.includes('.')) return `https://${name}`;
  for (const tld of ['com', 'net', 'dev', 'io', 'org', 'co']) {
    const host = `${name}.${tld}`;
    try {
      await dns.lookup(host);
      return `https://${host}`;
    } catch { /* try the next public suffix */ }
  }
  return '';
}

function parseModelJson(raw) {
  const text = String(raw || '').trim();
  const fenced = text.match(/\{[\s\S]*\}/);
  if (!fenced) return null;
  try { return JSON.parse(fenced[0]); } catch { return null; }
}

function imageIntent(text) {
  const lower = text.toLowerCase();
  if (!/\b(images?|pictures?|photos?)\b/.test(lower)) return '';
  if (/\b(download|zip|save|give me|send me)\b/.test(lower)) return 'download';
  if (/\b(only|just|extract|pull|grab)\b/.test(lower)) return 'extract';
  return '';
}

function wantsProducts(text) {
  return /\b(products?|shop|collection|catalog)\b/i.test(text);
}

function looksLikeEdit(text) {
  const lower = String(text || '').toLowerCase();
  const question = /\?\s*$/.test(text) || /^(what|why|how|who|when)\b/.test(lower);
  if (question && !/\b(change|make|set|switch|update|restyle)\b/.test(lower)) return false;
  return /\b(change|make|set|use|switch|update|restyle|bigger|smaller|bold|center|hide|font|color|colour|background|spacing|padding|margin|round|serif|sans|move|push|shift|nudge)\b/.test(lower);
}

const TYPOS = {
  wetie: 'write', wriet: 'write', wirte: 'write', wrte: 'write',
  ypi: 'you', yu: 'you',
  esay: 'essay', essy: 'essay',
  stying: 'styling', stylng: 'styling',
};

function normalizeTypos(text) {
  return String(text || '').replace(/\b[a-z']+\b/gi, (word) => TYPOS[word.toLowerCase()] || word);
}

function isGibberish(text) {
  const t = String(text || '').trim();
  if (!t || /^(hi|hey|hello|yo|ok|okay|thanks|thank you)\b/i.test(t)) return false;
  const letters = t.replace(/[^a-z]/gi, '');
  if (!letters || t.length <= 2) return true;
  if (t.length <= 5 && !/[aeiou]/i.test(letters)) return true;
  if (!/\s/.test(t) && letters.length <= 6 && !/[aeiou]/i.test(letters)) return true;
  return false;
}

function wantsProductHelp(text) {
  const lower = String(text || '').toLowerCase();
  const aboutSite = /\b(styl\w*|css|html|javascript|website|frontend|front-end)\b/.test(lower) || /\bmy site\b/.test(lower);
  const asking = /\b(can|could|would|will|work|help|able|do)\b/.test(lower);
  return aboutSite && asking && !looksLikeEdit(text);
}

function writingPrompt(message) {
  const words = String(message || '').match(/(\d+)\s*words?/i);
  const count = words ? Math.min(800, Math.max(40, Number(words[1]) || 200)) : 0;
  const topic = String(message || '').match(/\babout\s+(.{3,80})/i);
  const subject = topic ? topic[1].replace(/[.?!].*$/, '').trim() : '';
  if (count && /\bessay\b/i.test(message)) {
    return `Write a ${count} word essay${subject ? ` about ${subject}` : ' about a rainy afternoon in a city'}. Output only the essay.`;
  }
  if (count) return `Write about ${count} words${subject ? ` about ${subject}` : ''}. Output only the piece.`;
  return `${message}\n\nWrite the full piece now.`;
}

function refused(text) {
  return /didn'?t understand|did not understand|can'?t help|cannot help|i can not|not able to help|as an ai/i.test(String(text || ''));
}

function replyBudget(message) {
  const words = String(message || '').match(/(\d+)\s*words?/i);
  const writing = /\b(essay|story|poem|article|paragraph|letter)\b/i.test(message) || !!words;
  if (words) {
    const count = Math.min(800, Math.max(80, Number(words[1]) || 200));
    return { maxTokens: Math.min(1400, count * 3), timeout: 60000, cap: 8000, writing: true };
  }
  if (writing) return { maxTokens: 900, timeout: 45000, cap: 6000, writing: true };
  return { maxTokens: 320, timeout: 20000, cap: 1600, writing: false };
}

function sameAnswer(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const left = norm(a);
  const right = norm(b);
  if (left.length < 24 || right.length < 24) return false;
  return left.slice(0, 90) === right.slice(0, 90);
}

async function talk(message, history, outcome) {
  const facts = [];
  if (outcome.jobs?.length) facts.push(`Started a capture of ${outcome.jobs.map((job) => job.source_url).join(' and ')}.`);
  if (outcome.shareUrl) facts.push(`Live share link: ${outcome.shareUrl}`);
  if (outcome.edited) facts.push('A style edit was applied and the preview refreshed.');
  if (outcome.reset) facts.push('Edits were removed.');
  if (outcome.download === 'images') facts.push('The images zip is downloading.');
  if (outcome.download === 'full') facts.push('The full project zip is downloading.');
  if (outcome.error) facts.push(`Error: ${outcome.error}`);
  const budget = replyBudget(message);
  const factual = facts.length > 0;
  const messages = [{
    role: 'system',
    content: factual
      ? 'You are Protobuild. Reply in one or two short sentences using only the facts. If a share link is listed, include that exact URL. Do not invent a button, a newsletter, a file, or a link. Never write "user:" or "ai:".'
      : budget.writing
        ? 'You write the piece the user asked for. Spelling mistakes still count. Output only that piece, at the length they asked for. Do not apologize, do not refuse, and do not say you did not understand.'
        : 'You are a helpful assistant. Answer only the latest message. If they say hello, greet them and ask what they need. Do not invent a definition for a random string. Do not repeat an earlier answer. Never write "user:" or "ai:".',
  }];
  const prior = factual || budget.writing ? [] : (history || []).slice(-6);
  for (const item of prior) {
    const content = String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!content) continue;
    messages.push({ role: item.role === 'user' ? 'user' : 'assistant', content });
  }
  const asked = budget.writing ? writingPrompt(message) : message;
  messages.push({ role: 'user', content: factual ? `${message}\n\nFacts:\n${facts.join('\n')}` : asked });
  let text = cleanReply(message, await completeChat(messages, budget), budget.cap);
  const wanted = (String(message).match(/(\d+)\s*words?/i) || [])[1];
  const got = text.trim() ? text.trim().split(/\s+/).length : 0;
  const shortPiece = budget.writing && wanted && got < Number(wanted) * 0.4;
  if (budget.writing && (refused(text) || shortPiece || !text)) {
    text = cleanReply(message, await completeChat([
      { role: 'system', content: 'Output only the essay.' },
      { role: 'user', content: writingPrompt(message) },
    ], budget), budget.cap);
  }
  const last = [...(history || [])].reverse().find((item) => item.role !== 'user' && item.text);
  if (!budget.writing && last && sameAnswer(text, last.text) && !sameAnswer(message, last.text)) {
    text = cleanReply(message, await completeChat([messages[0], { role: 'user', content: message }], budget), budget.cap);
    if (sameAnswer(text, last.text)) text = '';
  }
  if (refused(text) && /\b(site|website|css|html|style)\b/i.test(message)) text = '';
  return text;
}

function cleanReply(message, raw, cap = 1600) {
  let text = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (/\b(user|ai|assistant)\s*:/i.test(text)) {
    const chunks = text.split(/\b(?:ai|assistant)\s*:\s*/i);
    text = (chunks[chunks.length - 1] || '').split(/\buser\s*:/i)[0].trim();
  }
  const ask = String(message || '').toLowerCase();
  const out = text.toLowerCase();
  if (/\b(click|newsletter|subscribe)\b/.test(out) && !/\b(click|newsletter|subscribe)\b/.test(ask)) return '';
  return text.slice(0, cap);
}

async function cssFromModel(message, sections) {
  const brief = (sections || []).slice(0, 8).map((s) => `${s.selector || 'section'}: ${(s.snippet || '').slice(0, 60)}`).join('\n');
  const raw = await completeChat([
    {
      role: 'system',
      content: 'Return JSON only: {"css":"","say":""}. css is a small stylesheet for the request. Allowed properties: color, background-color, font-family, font-size, font-weight, font-style, line-height, letter-spacing, margin, padding, display, text-align, border, border-radius, opacity, width, max-width. No url(), no @import, no HTML. If this is not a visual edit, leave css empty.',
    },
    { role: 'user', content: `Page:\n${brief || '(no outline)'}\n\nRequest: ${message}` },
  ], { timeout: 7000, maxTokens: 220 });
  const parsed = parseModelJson(raw);
  if (!parsed) return null;
  const css = typeof parsed.css === 'string' ? parsed.css.trim() : '';
  const say = typeof parsed.say === 'string' ? parsed.say.trim() : '';
  if (!css) return { say };
  const checked = validateCss(css);
  if (!checked.ok) return { say };
  return { css: checked.css, say };
}

function converse(message, outcome) {
  const open = outcome.active || outcome.latest;
  const name = open ? hostOf(open.source_url) : '';
  const bits = (outcome.sections || []).map((s) => s.snippet).filter(Boolean).slice(0, 3);
  const seen = bits.length ? ` On the page I can see ${bits.join(' · ')}.` : '';
  if (outcome.rights) return 'Paste the page you want copied.';
  if (outcome.error && !outcome.jobs?.length) return outcome.error;
  if (outcome.jobs?.length) {
    const names = outcome.jobs.map((job) => hostOf(job.source_url)).join(' and ');
    const images = outcome.jobs.some((job) => job.mode === 'images');
    return images
      ? `I'm pulling just the images from ${names}. I'll put them in the Images tab and the preview as soon as they land.`
      : `I'm copying ${names} now. The preview fills in here, then we can restyle it, download it, or make a live link.`;
  }
  if (outcome.shareUrl) return `Here is the live link:\n${outcome.shareUrl}`;
  if (outcome.reset) return `I put ${name} back to the original capture and refreshed the preview.`;
  if (outcome.missing) return `${name || 'That capture'} is marked finished, but the saved files are gone. Paste the link again and I will copy it.`;
  if (outcome.overlay && outcome.edited) return `I hid the popup on ${name}. The preview stays on the saved page, so it will not jump back to the live site.`;
  if (outcome.edited) return `Updated ${name}. The preview just refreshed. Tell me if you want another change, or say reset.`;
  if (outcome.editFailed) return 'I could not turn that into a style change. Try “use Georgia for the headings” or “make the header background black”.';
  if (outcome.download === 'images') return `The images from ${name} are downloading as a zip. The same pictures are in the Images tab.`;
  if (outcome.download === 'full') return `The project for ${name} is downloading. It includes the page, images, fonts, and any edits. Open index.html to see the same preview.`;
  if (outcome.upload) return 'Drop the saved HTML or ZIP on the paperclip. I will rebuild it here the same way as a live scan.';
  if (outcome.needsSite) return 'Which page? Paste the link, for example https://example.com.';
  if (outcome.needsProducts) return `I could not find a products link on ${name || 'this page'}. Paste the products page URL and I will extract only its images.`;
  if (outcome.decline) return 'Okay. I will not scan anything.';
  if (outcome.askLink) return 'Yes. Paste the page link and I will copy it. When the preview is ready, Download saves the files.';
  if (outcome.previewNote) return `The preview stays on the saved ${name || 'page'}. It will not jump back to the live site. If a banner is covering it, say remove the popup.`;
  if (outcome.help) {
    return open && open.status === 'done'
      ? `Yes. ${name} is open. Tell me the change, for example “use Georgia for the headings” or “make the background black”.`
      : 'Yes. Paste the page link and I will put it in the preview. Then tell me what to change, like the type or the colors.';
  }
  const q = String(message || '').toLowerCase();
  if (/\b(essay|story|poem|article|paragraph|letter)\b/.test(q) || /\d+\s*words?\b/.test(q)) {
    return 'I did not finish that piece. Send it once more and I will write it.';
  }
  if (/thank/.test(q)) return name ? `You're welcome. ${name} is still open.${seen}` : 'You are welcome. Paste a link and I will put that page in the preview.';
  if (/what can you|how do you|who are you|help\b/.test(q)) {
    return `Paste a link and I copy that page into the preview.${name ? ` ${name} is open now.` : ''} Then ask me to change the type or colors, download the project or only the images, or make a live link.`;
  }
  if (open && open.status === 'done') return `${name} is in the preview.${seen} What should we change, or do you want the files or a live link?`;
  if (open && (open.status === 'failed' || open.status === 'blocked')) return `${name} did not finish. ${open.error || 'Try another link, or attach a saved copy of the page.'}`;
  if (open) return `Still working on ${name}. I'll update this as soon as the copy is ready.`;
  return 'Paste the page you want copied. Once it is in the preview, we can edit it, download it, or make a live link.';
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'scan',
      description: 'Copy a public page into the preview. Use for any request to copy, scan, capture, or open a site. Set mode to images when they want pictures only, viewport to mobile for a phone-sized capture, scroll to footer when they want the bottom of the page, and crawl true to also copy one product page and one collection page on that site.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          mode: { type: 'string', enum: ['clone', 'images'] },
          viewport: { type: 'string', enum: ['desktop', 'mobile'] },
          scroll: { type: 'string', enum: ['none', 'footer'] },
          crawl: { type: 'boolean' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_page',
      description: 'Read the captured page. Use for questions about the open page, such as the headline or the nav font, and to search for a product, color, or section. Pass query when looking for a phrase. Do not scan just to answer a question.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_css',
      description: 'Propose a CSS change for the captured page. It is shown as a before and after and applied only after the person accepts. If this returns an error, rewrite the CSS and call edit_css again. Target the selector they clicked when they say change this.',
      parameters: {
        type: 'object',
        properties: { css: { type: 'string' } },
        required: ['css'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_html',
      description: 'Propose an exact text replacement in the captured HTML, including words and markup. Applied only after the person accepts. If the find string is missing, call read_page and try a shorter exact string.',
      parameters: {
        type: 'object',
        properties: {
          find: { type: 'string' },
          replace: { type: 'string' },
        },
        required: ['find', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'share',
      description: 'Turn on the live link for the open preview.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'download',
      description: 'Download the captured project, or only its images.',
      parameters: {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['full', 'images'] } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reset',
      description: 'Undo the last accepted edit. Pass all true only when they want every edit removed and the original capture back.',
      parameters: {
        type: 'object',
        properties: { all: { type: 'boolean' } },
      },
    },
  },
];

function toolArgs(call) {
  try { return JSON.parse(call.function.arguments || '{}'); } catch { return {}; }
}

function httpUrl(value) {
  const raw = String(value || '').trim().replace(/[),.;]+$/, '');
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(raw)) return `https://${raw}`;
  return '';
}

async function findInnerPages(pageUrl) {
  let html = '';
  try {
    const res = await fetch(pageUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Protobuild' },
    });
    html = (await res.text()).slice(0, 200000);
  } catch { return []; }
  let host = '';
  try { host = new URL(pageUrl).host; } catch { return []; }
  const found = [];
  for (const match of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    try {
      const next = new URL(match[1], pageUrl);
      if (next.host !== host || !/^https?:$/.test(next.protocol)) continue;
      found.push(next.href);
    } catch { /* skip a bad href */ }
  }
  const product = found.find((href) => /\/products?\//i.test(href) || /\/shop\//i.test(href));
  const collection = found.find((href) => /\/collections?\//i.test(href) && href !== product);
  return [product, collection].filter(Boolean);
}

async function runTool(call, ctx) {
  const args = toolArgs(call);
  const name = call.function.name;
  if (name === 'scan') {
    let url = httpUrl(args.url);
    if (!url && args.url) url = await namedTarget(`scan ${String(args.url).slice(0, 80)}`);
    if (!url) return { error: 'Pass a full http or https URL.' };
    const mode = args.mode === 'images' ? 'images' : 'clone';
    const capture = {
      mode,
      viewport: args.viewport === 'mobile' ? 'mobile' : 'desktop',
      scroll: args.scroll === 'footer' ? 'footer' : '',
    };
    const started = await ctx.deps.scan(url, mode, ctx.message, capture);
    ctx.job = started;
    ctx.jobs.push(started);
    const also = [];
    if (args.crawl) {
      for (const page of await findInnerPages(started.source_url || url)) {
        try {
          const inner = await ctx.deps.scan(page, mode, ctx.message, capture);
          ctx.jobs.push(inner);
          also.push(inner.source_url || page);
        } catch (err) {
          also.push(`${page} did not start: ${err.message}`);
        }
      }
    }
    return { jobId: started.id, url: started.source_url, status: started.status, also };
  }
  if (!ctx.job) return { error: 'No page is open. Ask for the link first.' };
  if (name === 'read_page') return ctx.deps.readPage(ctx.job, String(args.query || ''));
  if (name === 'edit_css') {
    const proposed = ctx.deps.proposeCss(ctx.job, String(args.css || ''));
    if (proposed.error) return proposed;
    ctx.proposals.push(proposed.proposal);
    return { ok: true, pending: true, message: 'Shown as a before and after. It is not applied until they accept.' };
  }
  if (name === 'edit_html') {
    const proposed = ctx.deps.proposeHtml(ctx.job, String(args.find || ''), String(args.replace || ''));
    if (proposed.error) return proposed;
    ctx.proposals.push(proposed.proposal);
    return { ok: true, pending: true, message: 'Shown as a before and after. It is not applied until they accept.' };
  }
  if (name === 'share') {
    if (ctx.job.status !== 'done') return { error: 'The copy is still running. The link can be made when the preview is ready.' };
    const shared = await ctx.deps.share(ctx.job);
    ctx.job = shared;
    ctx.shareUrl = shared.shareUrl || '';
    return { shareUrl: ctx.shareUrl };
  }
  if (name === 'download') {
    ctx.action = args.kind === 'images' ? 'images' : 'full';
    return { kind: ctx.action, ready: ctx.job.status === 'done' };
  }
  if (name === 'reset') {
    if (args.all) {
      ctx.job = await ctx.deps.reset(ctx.job);
      ctx.edited = true;
      return { ok: true, all: true };
    }
    const undone = await ctx.deps.undo(ctx.job);
    if (undone.job) ctx.job = undone.job;
    ctx.edited = !!undone.ok;
    return undone;
  }
  return { error: `Unknown tool ${name}` };
}

async function runAgent({ message, history, activeJob, pageText, image, onEvent, deps }) {
  const text = String(message || '').trim();
  const prior = (Array.isArray(history) ? history : []).slice(-20).map((item) => ({
    role: item.role === 'ai' || item.role === 'assistant' ? 'assistant' : 'user',
    content: String(item.text || item.content || '').slice(0, 4000),
  })).filter((item) => item.content);
  const page = String(pageText || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  const system = [
    'You are Protobuild. You copy a public page into a local preview and edit that copy.',
    'Call the tools when the user wants something done. More than one tool per message is normal.',
    'scan copies a page. Choose images mode, a mobile viewport, a footer scroll, or a crawl of the product and collection pages from the sentence.',
    'Questions about the open page use read_page. Search the capture with a query. Do not start a scan to answer them.',
    'edit_css and edit_html only propose a change. Tell them it is waiting below until they accept.',
    'If a tool returns an error, correct it and call that tool again.',
    'reset undoes one accepted edit. Pass all true only for a full return to the original capture.',
    'Do not scan when they said not to.',
    'Write a full answer when they ask. Do not stop after a sentence if they asked for an explanation or a code change.',
    page ? `Open page outline:\n${page.slice(0, 1200)}` : 'No page is open yet.',
  ].join('\n');
  const messages = [
    { role: 'system', content: system },
    ...prior,
    {
      role: 'user',
      content: image
        ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: image } }]
        : text,
    },
  ];
  const ctx = {
    message: text,
    deps,
    job: activeJob || null,
    jobs: [],
    proposals: [],
    shareUrl: '',
    action: null,
    edited: false,
  };
  let model = '';
  let note = '';
  let quotaReset = '';
  let spoken = '';
  for (let round = 0; round < 5; round += 1) {
    const turn = await completeChat(messages, {
      tools: TOOLS,
      maxTokens: 4096,
      onToken: (chunk) => {
        spoken += chunk;
        onEvent?.({ type: 'token', text: chunk });
      },
      onMeta: (meta) => {
        model = meta.model || model;
        note = meta.note || note;
        quotaReset = meta.quotaReset || quotaReset;
        onEvent?.({ type: 'meta', model, note, quotaReset });
      },
    });
    model = turn.model || model;
    note = turn.note || note;
    quotaReset = turn.quotaReset || quotaReset;
    if (round === 0 && !turn.text && !(turn.toolCalls || []).length && !turn.error) {
      const urls = explicitTargets(text);
      if (urls.length && !/\b(no|don't|dont|do not|never)\b/i.test(text)) {
        const mode = /\bimages?\s*only\b|\bonly images\b/i.test(text) ? 'images' : 'clone';
        const capture = {
          mode,
          viewport: /\bmobile\b|\bphone\b/i.test(text) ? 'mobile' : 'desktop',
          scroll: /\bfooter\b/i.test(text) ? 'footer' : '',
        };
        for (const url of urls.slice(0, 2)) {
          try {
            onEvent?.({ type: 'tool', name: 'scan' });
            const started = await deps.scan(url, mode, text, capture);
            ctx.job = started;
            ctx.jobs.push(started);
          } catch (err) {
            messages.push({ role: 'user', content: `The copy did not start: ${err.message}` });
          }
        }
        if (ctx.jobs.length) {
          messages.push({
            role: 'user',
            content: `A copy of ${ctx.jobs.map((job) => job.source_url).join(' and ')} has started. Tell them it is running. Do not invent a finished preview.`,
          });
        }
      }
      const plain = await completeChat(messages, {
        maxTokens: 2046,
        onToken: (chunk) => {
          spoken += chunk;
          onEvent?.({ type: 'token', text: chunk });
        },
        onMeta: (meta) => {
          model = meta.model || model;
          note = meta.note || note;
          quotaReset = meta.quotaReset || quotaReset;
          onEvent?.({ type: 'meta', model, note, quotaReset });
        },
      });
      model = plain.model || model;
      if (!spoken && plain.text) {
        spoken = plain.text;
        onEvent?.({ type: 'token', text: plain.text });
      }
      if (plain.error && !spoken) {
        spoken = plain.error;
        onEvent?.({ type: 'token', text: plain.error });
      }
      break;
    }
    if (turn.error && !turn.text && !(turn.toolCalls || []).length) {
      if (!spoken) {
        spoken = turn.error;
        onEvent?.({ type: 'token', text: turn.error });
      }
      break;
    }
    const urls = explicitTargets(text);
    if (round === 0 && urls.length && !(turn.toolCalls || []).length && !/\b(no|don't|dont|do not|never)\b/i.test(text)) {
      messages.push({ role: 'assistant', content: turn.text || '' });
      messages.push({
        role: 'user',
        content: 'If they want that page copied, call scan with the URL and the right mode, viewport, scroll, and crawl. If they only asked a question, answer without scanning.',
      });
      continue;
    }
    if ((turn.toolCalls || []).length) {
      messages.push({ role: 'assistant', content: turn.text || '', tool_calls: turn.toolCalls });
      for (const call of turn.toolCalls) {
        onEvent?.({ type: 'tool', name: call.function.name });
        let result;
        try { result = await runTool(call, ctx); }
        catch (err) { result = { error: err.message || 'That step failed.' }; }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 12000),
        });
      }
      continue;
    }
    if (!spoken && turn.text) {
      spoken = turn.text;
      onEvent?.({ type: 'token', text: turn.text });
    }
    break;
  }
  let reply = spoken.trim();
  if (!ctx.proposals.length && ctx.job) {
    const rule = reply.match(/[.#a-zA-Z][^{}\n]{0,80}\{[^}]+\}/);
    if (rule) {
      const proposed = ctx.deps.proposeCss(ctx.job, rule[0]);
      if (proposed?.proposal) ctx.proposals.push(proposed.proposal);
    }
  }
  if (note && !reply.includes(note)) reply = reply ? `${note}\n\n${reply}` : note;
  if (!reply && ctx.jobs.length) reply = 'The copy is running. I will keep this message updated.';
  const job = ctx.jobs[0] || ctx.job || null;
  return {
    reply,
    job,
    action: ctx.action,
    shareUrl: ctx.shareUrl || null,
    proposals: ctx.proposals,
    model,
    quotaReset,
    note,
    showPreview: !!(job && job.status === 'done' && !ctx.jobs.length),
    edited: ctx.edited,
  };
}

module.exports = { runAgent, explicitTargets, namedTarget };
