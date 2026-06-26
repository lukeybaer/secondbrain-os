#!/usr/bin/env node
/**
 * Serves local voice-review HTML and Otter audio from the repo root so the
 * EC2 Daily Briefing page can open local review pages without Chrome blocking
 * file:// links from an http:// origin.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.LOCAL_VOICE_REVIEW_PORT || 3177);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(body);
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0] || '/').replace(/\\/g, '/');
  const rel = decoded.replace(/^\/+/, '') || 'reports/life-archive-voiceprint-review.html';
  if (!/^(reports|data\/otter\/audio|data\/life-archive\/voiceprints)\//.test(rel)) return '';
  const abs = path.resolve(ROOT, rel);
  return abs.startsWith(ROOT + path.sep) ? abs : '';
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    send(res, 204, '');
    return;
  }
  if (req.url === '/health') {
    send(res, 200, JSON.stringify({ ok: true, root: ROOT, port: PORT }), { 'Content-Type': 'application/json' });
    return;
  }
  const file = safePath(req.url || '/');
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  const stat = fs.statSync(file);
  const ext = path.extname(file).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = String(range).match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : stat.size - 1;
      if (start >= 0 && end >= start && end < stat.size) {
        res.writeHead(206, {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': contentType,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
        });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
    }
  }
  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`local voice review server listening on http://127.0.0.1:${PORT}`);
});
