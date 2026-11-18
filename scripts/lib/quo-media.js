'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

function fsyncDirectory(dir) {
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); }
  catch (error) { if (!['EACCES', 'EINVAL', 'EISDIR', 'EPERM'].includes(error.code)) throw error; }
  finally { if (fd != null) fs.closeSync(fd); }
}

function privateAddress(address) {
  address = String(address || '').toLowerCase();
  if (!net.isIP(address)) return true;
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateAddress(mapped[1]);
  const mappedHex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16); const low = Number.parseInt(mappedHex[2], 16);
    return privateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  if (address === '::1' || address === '::' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe8') || address.startsWith('fe9') || address.startsWith('fea') || address.startsWith('feb') || address.startsWith('ff') || address.startsWith('2001:db8:') || address.startsWith('2001:10:')) return true;
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    const text = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && text[2] === 113) || a >= 224;
  }
  return false;
}

async function resolveSafeMediaUrl(value, options = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid Quo media URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('unsafe Quo media URL');
  const allowedHosts = options.allowedHosts || ['media.openphone.com', 'recordings.openphone.com', 'storage.openphone.co', 'cdn.openphone.co', 'storage.googleapis.com', 'cdn.quo.com', 'share.quo.com'];
  if (!allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new Error('unapproved Quo media host');
  const lookup = options.lookup || ((hostname) => dns.lookup(hostname, { all: true }));
  const resolved = await lookup(url.hostname);
  const addresses = Array.isArray(resolved) ? resolved : [resolved];
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address || entry))) throw new Error('Quo media URL resolved to a private address');
  const selected = addresses[0];
  return { url, address: selected.address || selected, family: selected.family || net.isIP(selected.address || selected) };
}
async function assertSafeMediaUrl(value, options = {}) {
  return (await resolveSafeMediaUrl(value, options)).url;
}

async function downloadQuoMedia(value, destination, options = {}) {
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? 3;
  const request = options.request || https.get;
  async function fetchOne(current, redirects) {
    const resolved = await resolveSafeMediaUrl(current, options);
    const url = resolved.url;
    return new Promise((resolve, reject) => {
      const req = request(url, { headers: { 'user-agent': 'SecondBrain-Quo-Archive/1' }, timeout: options.timeoutMs || 30_000, lookup: (_hostname, _lookupOptions, callback) => callback(null, resolved.address, resolved.family) }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          if (redirects >= maxRedirects || !res.headers.location) return reject(new Error('unsafe or excessive Quo media redirect'));
          return resolve(fetchOne(new URL(res.headers.location, url).toString(), redirects + 1));
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Quo media HTTP ${res.statusCode}`)); }
        const declared = Number(res.headers['content-length']);
        if (declared > maxBytes) { res.resume(); return reject(new Error('Quo media exceeds byte limit')); }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const tmp = `${destination}.partial-${process.pid}`;
        const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        const fail = (error) => { out.destroy(); try { fs.rmSync(tmp, { force: true }); } catch {} reject(error); };
        res.on('data', (chunk) => { bytes += chunk.length; if (bytes > maxBytes) { res.destroy(); fail(new Error('Quo media exceeds byte limit')); } else hash.update(chunk); });
        res.on('error', fail); out.on('error', fail);
        out.on('finish', () => {
          try {
            if (Number.isInteger(out.fd)) fs.fsyncSync(out.fd);
            if (fs.existsSync(destination)) return reject(new Error(`Quo media archive conflict; complete candidate retained at ${tmp}`));
            fs.renameSync(tmp, destination);
            fsyncDirectory(path.dirname(destination));
            resolve({ path: destination, bytes, sha256: hash.digest('hex'), contentType: res.headers['content-type'] || null });
          } catch (error) { fail(error); }
        });
        res.pipe(out);
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Quo media download timed out')));
    });
  }
  return fetchOne(value, 0);
}

module.exports = { DEFAULT_MAX_BYTES, assertSafeMediaUrl, downloadQuoMedia, privateAddress, resolveSafeMediaUrl };
