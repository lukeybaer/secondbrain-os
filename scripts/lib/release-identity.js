'use strict';

const path = require('node:path');

const SHA_RE = /^[0-9a-f]{40}$/;
const RELEASE_DIRECTORY_RE = /^([0-9a-f]{40})(?:\.reland-[a-z0-9-]+)?$/;

function normalizePath(value) {
  return path.resolve(String(value || '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function releaseShaFromPhysicalRoot(releaseRoot, { releasesRoot = '' } = {}) {
  const root = String(releaseRoot || '');
  const match = path.basename(root).toLowerCase().match(RELEASE_DIRECTORY_RE);
  if (!match || !SHA_RE.test(match[1])) return '';
  if (releasesRoot && normalizePath(path.dirname(root)) !== normalizePath(releasesRoot)) return '';
  return match[1];
}

function isLoopbackAddress(address) {
  const value = String(address || '').trim().toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function isDirectLocalHealthRequest(req) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false;
  const headers = req?.headers || {};
  if (Object.keys(headers).some((name) => /^(forwarded|x-forwarded-|x-real-ip)/i.test(name))) return false;
  return /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(String(headers.host || ''));
}

module.exports = {
  SHA_RE,
  RELEASE_DIRECTORY_RE,
  releaseShaFromPhysicalRoot,
  isLoopbackAddress,
  isDirectLocalHealthRequest,
};
