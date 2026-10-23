import puppeteer from '@cloudflare/puppeteer';

const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

function crc32(data) {
  let c = ~0;
  for (let i = 0; i < data.length; i += 1) {
    c ^= data[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function bytes(nums) {
  return new Uint8Array(nums);
}

function u16(n) {
  return [n & 255, (n >> 8) & 255];
}

function u32(n) {
  return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
}

function zipStore(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const file of files) {
    const name = enc.encode(file.name);
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const crc = crc32(data);
    const local = bytes([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0),
    ]);
    parts.push(local, name, data);
    central.push(bytes([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
    ]), name);
    offset += local.length + name.length + data.length;
  }
  let centralSize = 0;
  for (const part of central) centralSize += part.length;
  const end = bytes([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);
  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...parts, ...central, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function freezePage(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+=(?:"[^"]*"|'[^']*')/gi, '');
}

function screenshotPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#fff}img{width:100%;height:auto;display:block}</style></head><body><img src="screenshots/phone.png" alt=""></body></html>`;
}

async function saveJob(env, job) {
  await env.R2.put(`sites/${job.id}/job.json`, JSON.stringify(job), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function captureInBrowser(env, job) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(PHONE_UA);
    await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(job.source_url, { waitUntil: 'domcontentloaded', timeout: 22000 });
    await page.evaluate(() => new Promise((resolve) => {
      const done = () => resolve();
      if (document.readyState === 'complete') setTimeout(done, 600);
      else window.addEventListener('load', () => setTimeout(done, 600), { once: true });
      setTimeout(done, 4000);
    })).catch(() => {});
    const shot = new Uint8Array(await page.screenshot({ type: 'png' }));
    const raw = await page.content();
    const text = raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const html = text.length > 80 ? freezePage(raw) : screenshotPage();
    await env.R2.put(`sites/${job.id}/screenshots/phone.png`, shot, {
      httpMetadata: { contentType: 'image/png' },
    });
    await env.R2.put(`sites/${job.id}/index.html`, html, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    });
    const zip = zipStore([
      { name: 'index.html', data: new TextEncoder().encode(html) },
      { name: 'screenshots/phone.png', data: shot },
    ]);
    await env.R2.put(`sites/${job.id}/full.zip`, zip, {
      httpMetadata: { contentType: 'application/zip' },
    });
    await saveJob(env, {
      ...job,
      status: 'done',
      phase: 'packaging',
      phaseDetail: 'Previewing the screen',
      error: null,
      finished_at: new Date().toISOString(),
      stats: { images: shot.length ? 1 : 0 },
    });
  } finally {
    await browser.close();
  }
}
