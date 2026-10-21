const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = 'proto-build';
const SKIP = new Set(['edits.json', 'result.json', 'status.json', 'outline.json', 'manifest.json']);

function copyWeb(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name) || entry.name === 'screenshots') continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyWeb(src, dest);
    else if (entry.isFile() && !entry.name.endsWith('.zip')) fs.copyFileSync(src, dest);
  }
}

function prepareHtml(dir) {
  const file = path.join(dir, 'index.html');
  if (!fs.existsSync(file)) return;
  let html = fs.readFileSync(file, 'utf8');
  html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/gi, '');
  if (fs.existsSync(path.join(dir, 'custom.css')) && !html.includes('custom.css')) {
    html = html.replace(/<\/head>/i, '<link rel="stylesheet" href="custom.css"></head>');
  }
  fs.writeFileSync(file, html);
}

function publishSite(siteDir) {
  if (!fs.existsSync(path.join(siteDir, 'index.html'))) {
    return Promise.reject(new Error('The page is not ready to host.'));
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'protobuild-'));
  copyWeb(siteDir, staging);
  prepareHtml(staging);
  return new Promise((resolve, reject) => {
    const branch = `site-${path.basename(siteDir).slice(0, 24)}`;
    const child = spawn('npx', [
      'wrangler', 'pages', 'deploy', staging,
      '--project-name', PROJECT,
      '--branch', branch,
      '--commit-message', 'Host prototype',
    ], { cwd: siteDir });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Cloudflare took too long to publish the page.'));
    }, 120000);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      fs.rmSync(staging, { recursive: true, force: true });
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(staging, { recursive: true, force: true });
      if (code !== 0) {
        console.error(output.slice(-800));
        reject(new Error('Cloudflare did not accept the page.'));
        return;
      }
      resolve(`https://${branch}.${PROJECT}.pages.dev`);
    });
  });
}

module.exports = { publishSite, PROJECT };
