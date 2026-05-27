/**
 * media-protocol-range.test.ts
 *
 * Locks the 2026-04-29 fix for video playback halting at ~3s in the Content
 * Pipeline dashboard. Prior implementation of the media:// protocol handler
 * was a one-liner: `net.fetch(file:///${filePath})` which returned the whole
 * file but did not propagate Range headers and did not advertise
 * `Accept-Ranges: bytes`. HTML5 <video> would buffer the first chunk, then
 * stall when Chromium tried to fetch the next byte range and got a non-Range
 * response back.
 *
 * Fix in src/main/index.ts: parse Range header, fs.createReadStream the
 * requested byte slice, return 206 Partial Content with proper headers,
 * stream the slice as a Web ReadableStream. Non-Range requests get 200 with
 * Accept-Ranges: bytes so the client knows it can seek.
 *
 * This test asserts the source code structure stays intact. A full E2E test
 * that drives an actual <video> element through the protocol would require
 * Electron runtime; we trust the targeted source assertions plus the manual
 * verification in the Content Pipeline dashboard.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const INDEX_PATH = path.join(REPO_ROOT, 'src', 'main', 'index.ts');

describe('media:// protocol handler -- Range support', () => {
  const src = fs.readFileSync(INDEX_PATH, 'utf8');

  it('does not regress to the broken net.fetch one-liner', () => {
    // The old broken handler was a single `return net.fetch(\`file:///${...}\`)`
    // line with no Range parsing. The new handler must parse Range, slice the
    // file, and return 206 -- so a regression to the simple one-liner would
    // remove all of these markers.
    expect(src).not.toMatch(/return\s+net\.fetch\(`file:\/\/\/\$\{filePath\}`\)\s*;/);
  });

  it('parses the Range header and returns 206 with Content-Range', () => {
    // The handler reads request.headers.get('range') and matches bytes=N-M.
    expect(src).toMatch(/request\.headers\.get\(['"]range['"]\)/i);
    expect(src).toMatch(/bytes=\(\\d\+\)-\(\\d\*\)/);
    // It returns status 206 with Content-Range and Content-Length.
    expect(src).toMatch(/status:\s*206/);
    expect(src).toMatch(/['"]Content-Range['"]\s*:\s*`bytes \$\{start\}-\$\{end\}\/\$\{fileSize\}`/);
  });

  it('streams the file via fs.createReadStream rather than buffering', () => {
    // Range path must use createReadStream with start+end so we don't read
    // the whole file into memory for every Range request.
    expect(src).toMatch(/fs\.createReadStream\(filePath,\s*\{\s*start,\s*end\s*\}\)/);
    // And it converts the Node Readable to a Web ReadableStream for Response.
    expect(src).toMatch(/Readable\.toWeb\(nodeStream\)/);
  });

  it('advertises Accept-Ranges: bytes on non-Range responses', () => {
    // Without this header, Chromium does not know it can issue Range
    // requests for seeking, even though our handler now supports them.
    expect(src).toMatch(/['"]Accept-Ranges['"]\s*:\s*['"]bytes['"]/);
  });

  it('returns 416 for malformed or out-of-bounds Range requests', () => {
    expect(src).toMatch(/status:\s*416/);
    expect(src).toMatch(/['"]Content-Range['"]\s*:\s*`bytes \*\/\$\{fileSize\}`/);
  });

  it('returns 404 when the requested file does not exist', () => {
    expect(src).toMatch(/status:\s*404/);
  });

  it('sets a sensible Content-Type for common media extensions', () => {
    // Without Content-Type the <video> element falls back to MIME sniffing
    // which is unreliable for partial-content responses.
    expect(src).toMatch(/['"]video\/mp4['"]/);
    expect(src).toMatch(/['"]image\/jpeg['"]/);
  });
});
