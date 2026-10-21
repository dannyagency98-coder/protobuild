const dns = require('dns').promises;
const net = require('net');

function isBlockedHostname(hostname) {
  if (!hostname) return true;
  const lower = hostname.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower === '0.0.0.0' || lower.endsWith('.local') || lower.endsWith('.internal')) return true;
  if (lower === 'metadata.google.internal' || lower === 'metadata') return true;
  return false;
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true;
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (ip.startsWith('::ffff:')) return isPrivateIp(ip.slice(7));
  if (net.isIP(ip) !== 4) return false;
  const p = ip.split('.').map(Number);
  if (p[0] === 10 || p[0] === 127) return true;
  if (p[0] === 0) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
  return false;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolvePublic(hostname) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const results = await dns.lookup(hostname, { all: true });
      if (results.length) return results;
    } catch (err) {
      lastError = err;
    }
    try {
      const v4 = await dns.resolve4(hostname);
      if (v4.length) return v4.map((address) => ({ address, family: 4 }));
    } catch (err) {
      lastError = err;
    }
    try {
      const v6 = await dns.resolve6(hostname);
      if (v6.length) return v6.map((address) => ({ address, family: 6 }));
    } catch (err) {
      lastError = err;
    }
    if (attempt < 2) await wait(300 * (attempt + 1));
  }
  const error = new Error('Could not resolve that host.');
  error.cause = lastError;
  throw error;
}

async function assertPublicHttpUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('Enter a valid http or https URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https URLs are allowed.');
  if (parsed.username || parsed.password) throw new Error('URLs with credentials are not allowed.');
  if (isBlockedHostname(parsed.hostname)) throw new Error('That host is not allowed.');
  if (net.isIP(parsed.hostname) && isPrivateIp(parsed.hostname)) throw new Error('Private network addresses are not allowed.');
  const results = await resolvePublic(parsed.hostname);
  if (results.some((item) => isPrivateIp(item.address))) throw new Error('That host resolves to a private address.');
  return parsed.href;
}

module.exports = { assertPublicHttpUrl, isPrivateIp, isBlockedHostname };
