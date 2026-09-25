// Fetch a public web page's HTML on behalf of the browser (which is blocked by CORS).
// Shared by the local dev server (../server.js) and the Firebase Cloud Function (index.js).
import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15000;

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw Object.assign(new Error('That is not a valid URL'), { status: 400 }); }
  if (!['http:', 'https:'].includes(u.protocol)) throw Object.assign(new Error('Only http(s) links are supported'), { status: 400 });
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw Object.assign(new Error('Could not find that website'), { status: 400 });
  if (addrs.some(a => isPrivateAddress(a.address))) throw Object.assign(new Error('Private network addresses are not allowed'), { status: 400 });
  return u;
}

// Sites differ in what they block, so try an honest bot UA first, then a browser-like one.
const HEADER_SETS = [
  { 'User-Agent': 'Mozilla/5.0 (compatible; RecipeBox/1.0; personal recipe importer)', 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
  { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
];

async function fetchFollowingRedirects(url, headers, signal) {
  let res;
  // Follow redirects manually so every hop is checked
  for (let hop = 0; hop < 5; hop++) {
    res = await fetch(url, { redirect: 'manual', signal, headers });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await assertPublicUrl(new URL(res.headers.get('location'), url).toString());
      continue;
    }
    break;
  }
  return { res, url };
}

export async function fetchPage(rawUrl) {
  let url = await assertPublicUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res;
    for (const headers of HEADER_SETS) {
      ({ res, url } = await fetchFollowingRedirects(url, headers, controller.signal));
      if (res.ok || ![401, 403, 429, 503].includes(res.status)) break;
    }
    if (!res.ok) throw Object.assign(new Error(`The site refused the request (${res.status}). Some sites block automated imports — use the "Save to Recipe Box" bookmark button on the page instead, or paste the recipe text.`), { status: 502 });
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { controller.abort(); break; }
      chunks.push(value);
    }
    const html = Buffer.concat(chunks).toString('utf8');
    return { html, finalUrl: url.toString() };
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('The site took too long to respond'), { status: 504 });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
