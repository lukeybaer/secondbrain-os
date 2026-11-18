'use strict';

// Public links and pages, read from EC2 (Chat harness fix 4, owner decision).
//
// On the desktop, Amy opens a Dropbox or Google Drive link the owner pastes and looks at a
// page that only renders in a browser. Chat Amy had WebFetch, which gets neither a
// shared file nor a page built by JavaScript, and its browser tool was PC-only. These two
// readers run on EC2 with no cookies and no sign-in:
//   open_shared_link  saves the file behind a public share link into the turn workspace.
//   cloud_browse      loads a public page in headless Chromium and returns its text.
// Every request, including each redirect and every request the page makes, must resolve
// to a public address: never the instance metadata service, localhost or the VPC.
// A page that needs the owner's sign-in is a Need for the owner, not something to work around.

const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');
const { BROWSE_FOLDER, SHARED_LINK_FOLDER, plainWorkspaceDir } = require('./workspace-plain-dir.js');

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TEXT_CHARS_MAX = 400_000;
const LINK_LIMIT = 60;
// A page load the owner waits on inside a turn; the turn itself is the watched job.
const PAGE_LOAD_MS = 45 * 1000;
const PAGE_SETTLE_MS = 8 * 1000;
const FETCH_IDLE_MS = 60 * 1000;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 AmyReader/1.0';

class PublicWebRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublicWebRefusal';
    this.code = 'EPUBLICWEB';
  }
}

function ipv4Private(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

// True for any address that is not on the public internet.
// An IPv6 address as its eight 16-bit groups, with a trailing dotted IPv4 folded in.
function ipv6Groups(value) {
  let text = value;
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [w, x, y, z] = dotted.slice(1).map(Number);
    text = `${text.slice(0, -dotted[0].length)}${((w << 8) | x).toString(16)}:${((y << 8) | z).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : new Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((group) => parseInt(group || '0', 16));
}

function groupsToIpv4(high, low) {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function privateAddress(address) {
  const value = String(address || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const family = net.isIP(value);
  if (family === 4) return ipv4Private(value);
  if (family !== 6) return true;
  const g = ipv6Groups(value);
  if (g.length !== 8 || g.some((n) => !Number.isFinite(n))) return true;
  const zeros = (from, to) => g.slice(from, to).every((n) => n === 0);
  // IPv4-compatible (::a.b.c.d, which also covers :: and ::1) and IPv4-mapped
  // (::ffff:a.b.c.d) carry an IPv4 address that decides it.
  if (zeros(0, 5) && (g[5] === 0 || g[5] === 0xffff)) return ipv4Private(groupsToIpv4(g[6], g[7]));
  // 6to4 (2002::/16) carries one in groups 2 and 3.
  if (g[0] === 0x2002) return ipv4Private(groupsToIpv4(g[1], g[2]));
  return (
    (g[0] & 0xfe00) === 0xfc00 || // unique local
    (g[0] & 0xffc0) === 0xfe80 || // link local
    (g[0] & 0xffc0) === 0xfec0 || // old site local
    (g[0] & 0xff00) === 0xff00 || // multicast
    (g[0] === 0x64 && g[1] === 0xff9b) || // NAT64 can reach IPv4 private space
    (g[0] === 0x2001 && g[1] === 0) || // Teredo hides an IPv4 address
    (g[0] === 0x2001 && g[1] === 0xdb8) // documentation
  );
}

function lookupAll(lookup, hostname) {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(addresses || [])));
  });
}

// The URL, once it is plain http(s) to a host that resolves only to public addresses.
async function assertPublicUrl(raw, { lookup = dns.lookup } = {}) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new PublicWebRefusal('that is not a valid web address');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new PublicWebRefusal('only http and https links can be opened');
  if (url.username || url.password) throw new PublicWebRefusal('links with a user name or password in them are not opened');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || /^localhost$|\.localhost$|\.internal$|\.local$/i.test(host)) throw new PublicWebRefusal(`${host || 'that host'} is not on the public internet`);
  let addresses;
  if (net.isIP(host)) addresses = [{ address: host }];
  else {
    try {
      addresses = await lookupAll(lookup, host);
    } catch (error) {
      throw new PublicWebRefusal(`${host} could not be found (${error.code || error.message})`);
    }
  }
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) {
    throw new PublicWebRefusal(`${host} is not on the public internet`);
  }
  return url;
}

// The same check at connect time, so a host cannot resolve public for the check and
// private for the connection.
function guardedLookup(lookup = dns.lookup) {
  return (hostname, options, callback) => {
    const opts = typeof options === 'object' && options ? options : { family: options };
    lookup(hostname, { ...opts, all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = addresses || [];
      if (!list.length || list.some((entry) => privateAddress(entry.address))) {
        return callback(new PublicWebRefusal(`${hostname} is not on the public internet`));
      }
      if (opts.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

function base64Url(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Where the file behind a share page can be downloaded, and what the link is.
function sharedLinkDownload(raw) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const pathName = url.pathname;
  if (/(^|\.)dropbox\.com$/.test(host)) {
    url.searchParams.delete('raw');
    url.searchParams.set('dl', '1');
    return { service: 'dropbox', url: url.toString() };
  }
  if (host === 'drive.google.com') {
    const id = pathName.match(/\/file\/d\/([\w-]+)/)?.[1] || url.searchParams.get('id');
    if (id) return { service: 'google-drive', url: `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t` };
    return { service: 'google-drive', url: raw, page: true };
  }
  if (host === 'docs.google.com') {
    const doc = pathName.match(/^\/(document|spreadsheets|presentation)\/d\/([\w-]+)/);
    if (doc) {
      const [, kind, id] = doc;
      const base = `https://docs.google.com/${kind}/d/${encodeURIComponent(id)}/export`;
      if (kind === 'document') return { service: 'google-docs', url: `${base}?format=txt` };
      if (kind === 'spreadsheets') {
        const gid = url.searchParams.get('gid') || url.hash.match(/gid=(\d+)/)?.[1];
        return { service: 'google-sheets', url: `${base}?format=csv${gid ? `&gid=${encodeURIComponent(gid)}` : ''}` };
      }
      return { service: 'google-slides', url: `${base}?format=pdf` };
    }
  }
  if (host === '1drv.ms' || host === 'onedrive.live.com') {
    return { service: 'onedrive', url: `https://api.onedrive.com/v1.0/shares/u!${base64Url(raw)}/root/content` };
  }
  if (/\.sharepoint\.com$/.test(host)) {
    url.searchParams.set('download', '1');
    return { service: 'sharepoint', url: url.toString() };
  }
  if (/(^|\.)box\.com$/.test(host) && /^\/s\//.test(pathName)) {
    // A Box share page needs its file id to download; read it as a page instead.
    return { service: 'box', url: raw, page: true };
  }
  return { service: 'direct', url: raw };
}

function contentFileName(disposition, url) {
  const header = String(disposition || '');
  const encoded = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/)?.[1];
  let name = '';
  if (encoded) {
    try {
      name = decodeURIComponent(encoded.replace(/^"|"$/g, ''));
    } catch {
      name = '';
    }
  }
  if (!name) name = header.match(/filename\s*=\s*"([^"]+)"/)?.[1] || header.match(/filename\s*=\s*([^;]+)/)?.[1] || '';
  if (!name) {
    try {
      name = decodeURIComponent(path.posix.basename(new URL(url).pathname));
    } catch {
      name = '';
    }
  }
  const safe = path.basename(String(name).replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').replace(/^\.+/, '').trim().slice(0, 140);
  return safe || 'download';
}

function textLike(contentType, fileName) {
  return /^text\/|\/(?:json|xml|csv|x-ndjson|javascript)\b|\+json|\+xml/.test(contentType) || /\.(?:txt|md|csv|tsv|json|xml|html?|ics|vcf|log)$/i.test(fileName);
}

function htmlText(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// One request with the connect-time address check; redirects are the caller's.
function guardedRequest(url, { method = 'GET', headers = {}, body = null, lookup = dns.lookup, idleMs = FETCH_IDLE_MS } = {}) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      url,
      { method, lookup: guardedLookup(lookup), headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...headers } },
      (response) => resolve({ status: response.statusCode, headers: response.headers, body: response }),
    );
    request.setTimeout(idleMs, () => request.destroy(new PublicWebRefusal('the site stopped responding')));
    request.on('error', reject);
    request.end(body || undefined);
  });
}

function guardedGet(url, options = {}) {
  return guardedRequest(url, { ...options, method: 'GET' });
}

async function readCapped(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) {
      stream.destroy?.();
      throw new PublicWebRefusal(`over the ${maxBytes} byte limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Headers a fulfilled response must not carry: the body is already whole and decoded.
const HOP_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);
const PAGE_RESOURCE_BYTES = 20 * 1024 * 1024;

// The guard asks for an uncompressed body, but a site may compress anyway. The
// fulfilled response drops content-encoding, so the body must be decoded here, with
// the same size cap on what it inflates to (deploy review 2026-11-11).
function decodeBody(body, encoding, maxBytes = PAGE_RESOURCE_BYTES) {
  const kinds = String(encoding || '').toLowerCase().split(',').map((kind) => kind.trim()).filter((kind) => kind && kind !== 'identity');
  const limit = { maxOutputLength: maxBytes };
  let out = body;
  // Encodings apply in the order listed, so they come off in reverse.
  for (const kind of kinds.reverse()) {
    try {
      if (kind === 'gzip' || kind === 'x-gzip') out = zlib.gunzipSync(out, limit);
      else if (kind === 'br') out = zlib.brotliDecompressSync(out, limit);
      else if (kind === 'deflate') {
        try {
          out = zlib.inflateSync(out, limit);
        } catch {
          out = zlib.inflateRawSync(out, limit);
        }
      } else throw new PublicWebRefusal(`the site used an unknown content encoding (${kind.slice(0, 20)})`);
    } catch (error) {
      if (error instanceof PublicWebRefusal) throw error;
      throw new PublicWebRefusal(`the site sent a ${kind} body that would not decode within ${maxBytes} bytes`);
    }
  }
  return out;
}

// Serves one browser request through the guarded client, so Chromium's own DNS never
// decides where a page connects. Redirects go back to Chromium, which routes the next
// hop here again.
async function fulfillThroughGuard(route, { request = guardedRequest, lookup = dns.lookup } = {}) {
  const browserRequest = route.request();
  const url = await assertPublicUrl(browserRequest.url(), { lookup });
  const headers = { ...(await browserRequest.allHeaders()) };
  for (const name of Object.keys(headers)) {
    if (name.startsWith(':') || name === 'host' || name === 'accept-encoding' || name === 'connection') delete headers[name];
  }
  headers['accept-encoding'] = 'identity';
  const response = await request(url, { method: browserRequest.method(), headers, body: browserRequest.postDataBuffer(), lookup });
  const encoding = Object.entries(response.headers || {}).find(([name]) => name.toLowerCase() === 'content-encoding')?.[1];
  const body = decodeBody(await readCapped(response.body, PAGE_RESOURCE_BYTES), Array.isArray(encoding) ? encoding.join(',') : encoding);
  const outHeaders = {};
  for (const [name, value] of Object.entries(response.headers || {})) {
    if (!HOP_HEADERS.has(name.toLowerCase())) outHeaders[name] = Array.isArray(value) ? value.join(name.toLowerCase() === 'set-cookie' ? '\n' : ', ') : String(value);
  }
  return route.fulfill({ status: response.status, headers: outHeaders, body });
}

// Follows redirects, checking each hop, and streams the body into a buffer up to the cap.
async function download(rawUrl, { get = guardedGet, lookup = dns.lookup, maxBytes = MAX_FILE_BYTES } = {}) {
  let url = await assertPublicUrl(rawUrl, { lookup });
  for (let hop = 0; ; hop += 1) {
    const response = await get(url, { lookup });
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      response.body?.resume?.();
      if (hop >= MAX_REDIRECTS) throw new PublicWebRefusal('the link redirected too many times');
      url = await assertPublicUrl(new URL(response.headers.location, url).toString(), { lookup });
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      response.body?.resume?.();
      return { ok: false, status: response.status, url: url.toString() };
    }
    const declared = Number(response.headers['content-length'] || 0);
    if (declared > maxBytes) {
      response.body?.destroy?.();
      throw new PublicWebRefusal(`the file is ${declared} bytes, over the ${maxBytes} byte limit`);
    }
    const bytes = await readCapped(response.body, maxBytes).catch((error) => {
      throw error instanceof PublicWebRefusal ? new PublicWebRefusal(`the file is ${error.message}`) : error;
    });
    return { ok: true, status: response.status, url: url.toString(), headers: response.headers, bytes };
  }
}

function freshFolder(workspace, folder, prefix) {
  if (!workspace) throw new PublicWebRefusal('files are kept only in a turn workspace');
  // The engine's shell can write in its workspace, so the folder must be a real folder.
  const root = plainWorkspaceDir(workspace, folder);
  // A new folder per save: two files never share a name, and nothing planted is written through.
  return fs.mkdtempSync(path.join(root, prefix));
}

async function openSharedLink({ url, workspace, get, lookup } = {}) {
  const target = sharedLinkDownload(String(url || '').trim());
  if (target.page) {
    return {
      ok: false,
      service: target.service,
      reason: `a ${target.service} link like this is a page, not a direct file; read it with cloud_browse`,
    };
  }
  const fetched = await download(target.url, { get, lookup });
  if (!fetched.ok) {
    return {
      ok: false,
      service: target.service,
      status: fetched.status,
      reason:
        fetched.status === 401 || fetched.status === 403 || fetched.status === 404
          ? 'the file is not public (or no longer exists); it needs the owner to share it publicly or open it himself'
          : `the site answered HTTP ${fetched.status}`,
    };
  }
  const contentType = String(fetched.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const fileName = contentFileName(fetched.headers['content-disposition'], fetched.url);
  if (contentType === 'text/html' && target.service !== 'direct') {
    // A share service that answers with a page wants a sign-in or is a folder.
    return {
      ok: false,
      service: target.service,
      reason: 'the link opened a web page instead of a file: it may need a sign-in or be a folder; try cloud_browse',
      page_text: htmlText(fetched.bytes.toString('utf8')).slice(0, 4000),
    };
  }
  const directory = freshFolder(workspace, SHARED_LINK_FOLDER, 'link-');
  const destination = path.join(directory, fileName);
  fs.writeFileSync(destination, fetched.bytes, { mode: 0o600, flag: 'wx' });
  const result = { ok: true, service: target.service, path: destination, file_name: fileName, mime_type: contentType || null, bytes: fetched.bytes.length };
  if (textLike(contentType, fileName)) {
    const raw = fetched.bytes.toString('utf8');
    const text = contentType === 'text/html' || /\.html?$/i.test(fileName) ? htmlText(raw) : raw;
    result.text = text.slice(0, TEXT_CHARS_MAX);
    if (text.length > TEXT_CHARS_MAX) result.text_truncated = true;
  } else {
    result.note = 'Saved; open it with Read (PDFs and images too) or convert it in your shell.';
  }
  return result;
}

// Every page request is answered through the guarded client, so Chromium itself never
// needs the network. Its own traffic goes to a proxy that is not there, so anything the
// request routing does not see (a WebRTC probe, a prefetch) reaches nothing (review
// 2026-11-10: WebSocket and DNS-rebinding paths around the routing).
const BROWSE_LAUNCH_OPTIONS = Object.freeze({
  headless: true,
  proxy: { server: 'http://127.0.0.1:9', bypass: '' },
  args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-features=DnsOverHttps,NetworkPrediction'],
});

function defaultLaunch() {
  const { chromium } = require('playwright');
  const { hardenedLaunchOptions } = require('./hardened-browser-launch.js');
  return chromium.launch(hardenedLaunchOptions({ ...BROWSE_LAUNCH_OPTIONS, args: [...BROWSE_LAUNCH_OPTIONS.args] }));
}

async function browsePage({ url, workspace = null, screenshot = false, launch = defaultLaunch, lookup = dns.lookup, request = guardedRequest } = {}) {
  const start = await assertPublicUrl(url, { lookup });
  const checked = new Map();
  const allowed = async (requestUrl) => {
    if (/^(?:data|blob|about):/i.test(requestUrl)) return true;
    let host;
    try {
      host = new URL(requestUrl).host;
    } catch {
      return false;
    }
    if (!checked.has(host)) checked.set(host, assertPublicUrl(requestUrl, { lookup }).then(() => true, () => false));
    return checked.get(host);
  };
  const blocked = [];
  const browser = await launch();
  try {
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', userAgent: USER_AGENT });
    // A WebSocket does not pass through route(); a page being read needs none.
    if (typeof context.routeWebSocket === 'function') await context.routeWebSocket(/.*/, (socket) => socket.close());
    await context.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      if (/^(?:data|blob|about):/i.test(requestUrl)) return route.continue();
      if (await allowed(requestUrl)) {
        try {
          return await fulfillThroughGuard(route, { request, lookup });
        } catch {
          // Refused at connect time, too big, or the site failed: the page loads without it.
        }
      }
      if (blocked.length < 10) blocked.push(requestUrl.slice(0, 200));
      return route.abort('blockedbyclient').catch(() => {});
    });
    const page = await context.newPage();
    const response = await page.goto(start.toString(), { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_MS });
    await page.waitForLoadState('networkidle', { timeout: PAGE_SETTLE_MS }).catch(() => {
      // A page that keeps polling is read as it stands.
    });
    const title = await page.title();
    const text = String((await page.evaluate(() => (document.body ? document.body.innerText : ''))) || '');
    const links = (await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .slice(0, 400)
        .map((anchor) => ({ text: (anchor.innerText || anchor.getAttribute('aria-label') || '').trim().slice(0, 120), href: anchor.href })),
    ))
      .filter((link) => /^https?:/i.test(link.href) && link.text)
      .slice(0, LINK_LIMIT);
    let shot = null;
    if (screenshot) {
      shot = path.join(freshFolder(workspace, BROWSE_FOLDER, 'page-'), 'page.png');
      await page.screenshot({ path: shot, fullPage: true });
    }
    const signIn = /\b(sign in|log in|login)\b/i.test(title) || /accounts\.google\.com|login\.microsoftonline\.com|\/login\b|\/signin\b/i.test(page.url());
    return {
      ok: true,
      url: start.toString(),
      final_url: page.url(),
      status: response ? response.status() : null,
      title,
      text: text.slice(0, TEXT_CHARS_MAX),
      ...(text.length > TEXT_CHARS_MAX ? { text_truncated: true } : {}),
      links,
      ...(shot ? { screenshot: shot } : {}),
      ...(blocked.length ? { blocked_requests: blocked } : {}),
      ...(signIn ? { needs_sign_in: true, note: 'This page wants a sign-in. Amy does not sign in from the cloud; the owner can open it himself.' } : {}),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = {
  BROWSE_LAUNCH_OPTIONS,
  MAX_FILE_BYTES,
  PublicWebRefusal,
  assertPublicUrl,
  browsePage,
  contentFileName,
  decodeBody,
  download,
  guardedLookup,
  openSharedLink,
  privateAddress,
  sharedLinkDownload,
};
