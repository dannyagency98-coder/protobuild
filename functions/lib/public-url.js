function isPrivateIp(ip) {
  const value = String(ip || '').toLowerCase();
  if (!value || value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  if (value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd')) return true;
  if (value.startsWith('::ffff:')) return isPrivateIp(value.slice(7));
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
  if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  return false;
}

function isIp(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

async function resolveHost(host) {
  const ips = [];
  for (const type of ['A', 'AAAA']) {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { Accept: 'application/dns-json' },
    });
    const data = await res.json().catch(() => ({}));
    for (const answer of data.Answer || []) {
      if (answer.data) ips.push(String(answer.data).replace(/\.$/, ''));
    }
  }
  return ips;
}

export async function assertPublicHttpUrl(raw) {
  let parsed;
  try { parsed = new URL(String(raw || '')); } catch { throw new Error('Enter a valid http or https URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https URLs are allowed.');
  if (parsed.username || parsed.password) throw new Error('URLs with credentials are not allowed.');
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata' || host === 'metadata.google.internal') {
    throw new Error('That host is not allowed.');
  }
  if (isIp(host)) {
    if (isPrivateIp(host)) throw new Error('Private network addresses are not allowed.');
    return parsed.href;
  }
  const ips = await resolveHost(host);
  if (!ips.length) throw new Error('Could not resolve that host.');
  if (ips.some((ip) => isPrivateIp(ip))) throw new Error('That host resolves to a private address.');
  return parsed.href;
}
