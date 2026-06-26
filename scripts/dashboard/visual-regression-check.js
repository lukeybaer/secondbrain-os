#!/usr/bin/env node
'use strict';

/**
 * scripts/dashboard/visual-regression-check.js
 *
 * Visual QC for the live briefing dashboard. Catches layout failures that the
 * content-based QC (verify-dashboard-cards-live.js) cannot: excessive whitespace,
 * collapsed tiles, and pixel-level regressions vs a stored baseline.
 *
 * Triggered: after every deploy in the visual-iteration-loop. Also callable
 * standalone for manual verification.
 *
 * Checks (all configurable in config/dashboard-qa.json):
 *   1. TILE HEIGHT -- every data-section tile must be >= minTileHeightPx.
 *      A collapsed tile (height 0 or very small) is a hard fail.
 *   2. EMPTY VERTICAL SPACE -- for each tile, the ratio of whitespace height
 *      inside the tile to total tile height must not exceed maxEmptyVerticalRatio.
 *      Catches the "so much white space" class of defects.
 *   3. PIXEL DIFF -- if a baseline screenshot exists, compare the new screenshot
 *      against it. Differences above maxDiffPercent are a hard fail.
 *      If no baseline exists, the current screenshot IS saved as the new baseline
 *      (so the first run always passes the pixel check and establishes ground truth).
 *
 * Auth: same token chain as verify-dashboard-cards-live.js:
 *   1. env SB_BRIEFING_TOKEN
 *   2. SSH to EC2 at EC2_HOST, read /opt/secondbrain/.env
 *
 * Returns (when required as a module):
 *   { ok: boolean, defects: string[], screenshotPath: string|null, diffPercent: number|null }
 *
 * Exit codes (CLI):
 *   0  pass
 *   1  visual defect(s) found
 *   2  dashboard unreachable / browser launch failed (retry condition)
 *
 * Usage:
 *   node scripts/dashboard/visual-regression-check.js [--url URL] [--save-baseline]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'config', 'dashboard-qa.json');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function cfg(key, def) {
  const c = loadConfig();
  return key in c ? c[key] : def;
}

const DEFAULTS = {
  maxDiffPercent: 5,
  minTileHeightPx: 80,
  maxEmptyVerticalRatio: 0.40,
  screenshotDir: 'data/dashboard/screenshots',
  baselinePath: 'data/dashboard/baseline-screenshot.png',
  viewportWidth: 1280,
  viewportHeight: 900,
  pageLoadTimeoutMs: 30000,
};

// ---------------------------------------------------------------------------
// Token + URL resolution (mirrors verify-dashboard-cards-live.js)
// ---------------------------------------------------------------------------

function resolveToken() {
  if (process.env.SB_BRIEFING_TOKEN) return process.env.SB_BRIEFING_TOKEN.trim();
  try {
    const host = process.env.EC2_HOST || 'ec2-user@ExampleCo';
    const keyArg = process.env.EC2_SSH_KEY
      ? ['-i', process.env.EC2_SSH_KEY]
      : ['-i', path.join(process.env.HOME || '', '.ssh', 'sb-key.pem')];
    const out = execFileSync(
      'ssh',
      [...keyArg, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10',
        host, 'grep SB_BRIEFING_TOKEN /opt/secondbrain/.env'],
      { encoding: 'utf8', timeout: 15000 },
    );
    const m = String(out).match(/SB_BRIEFING_TOKEN\s*=\s*["']?([^"'\r\n]+)/);
    if (m) return m[1].trim();
  } catch {
    // fall through
  }
  return null;
}

function resolveDashboardUrl(token) {
  const base = process.env.EC2_HOST_HTTP || 'http://ExampleCo:3001';
  const tok = token || '';
  return `${base}/briefing${tok ? `?k=${encodeURIComponent(tok)}` : ''}`;
}

// ---------------------------------------------------------------------------
// Screenshot path helpers
// ---------------------------------------------------------------------------

function screenshotDir() {
  const rel = cfg('screenshotDir', DEFAULTS.screenshotDir);
  const dir = path.isAbsolute(rel) ? rel : path.join(REPO_ROOT, rel);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function baselinePath() {
  const rel = cfg('baselinePath', DEFAULTS.baselinePath);
  return path.isAbsolute(rel) ? rel : path.join(REPO_ROOT, rel);
}

function timestampedScreenshotPath() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(screenshotDir(), `dashboard-${ts}.png`);
}

// ---------------------------------------------------------------------------
// Pixel diff (lightweight, no external deps)
//
// PNG files are binary. A true pixel-level diff needs a PNG decoder. Without
// pixelmatch/pngjs installed we use a cryptographic hash comparison as a proxy:
//   - identical PNG bytes  -> 0% diff (pass)
//   - any difference       -> non-zero diff (we report it but cannot compute %)
//
// When pixelmatch IS available in the future, swap pixelDiff() to use it.
// The threshold check below handles both cases: exact-match hash is always <=
// maxDiffPercent, and "hash mismatch" is treated as maxDiffPercent+1 (fail).
// This is intentionally conservative: hash mismatch triggers a rerun, but the
// baseline is NEVER auto-updated during the iteration loop -- only when
// --save-baseline is passed explicitly.
// ---------------------------------------------------------------------------

function pixelDiff(newPng, baselinePngPath) {
  if (!fs.existsSync(baselinePngPath)) return null; // no baseline yet -> skip

  const baselineBuf = fs.readFileSync(baselinePngPath);
  const newHash = crypto.createHash('sha256').update(newPng).digest('hex');
  const baseHash = crypto.createHash('sha256').update(baselineBuf).digest('hex');

  if (newHash === baseHash) return 0; // pixel-perfect match

  // Hashes differ. Try to use pixelmatch if available.
  try {
    const pixelmatch = require('pixelmatch'); // optional; not in current package.json
    const pngjs = require('pngjs');
    const img1 = pngjs.PNG.sync.read(baselineBuf);
    const img2 = pngjs.PNG.sync.read(newPng);
    if (img1.width === img2.width && img1.height === img2.height) {
      const diffPixels = pixelmatch(img1.data, img2.data, null, img1.width, img1.height, {
        threshold: 0.1,
      });
      return (diffPixels / (img1.width * img1.height)) * 100;
    }
  } catch {
    // pixelmatch not available: hash mismatch = conservative fail flag
    return cfg('maxDiffPercent', DEFAULTS.maxDiffPercent) + 1;
  }

  return cfg('maxDiffPercent', DEFAULTS.maxDiffPercent) + 1;
}

// ---------------------------------------------------------------------------
// DOM structural checks (run inside page.evaluate)
// ---------------------------------------------------------------------------

// Injected into the browser page; no require() allowed.
function domInspect() {
  const results = [];
  const tiles = Array.from(document.querySelectorAll('[data-section]'));
  for (const tile of tiles) {
    const rect = tile.getBoundingClientRect();
    const name = tile.getAttribute('data-section') || 'ExampleCo';

    // Measure whitespace: sum up the height of all direct children, compare
    // to total tile height. The gap between children-total and tile height is
    // the empty/padding space.
    const children = Array.from(tile.children);
    const childrenTotalHeight = children.reduce((sum, c) => {
      const cr = c.getBoundingClientRect();
      return sum + cr.height;
    }, 0);
    const tileHeight = rect.height;
    const emptyHeight = Math.max(0, tileHeight - childrenTotalHeight);
    const emptyRatio = tileHeight > 0 ? emptyHeight / tileHeight : 0;

    results.push({
      name,
      height: tileHeight,
      width: rect.width,
      emptyRatio: Math.round(emptyRatio * 100) / 100,
      top: rect.top,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Core check function (injectable deps for unit tests)
// ---------------------------------------------------------------------------

/**
 * deps.launchBrowser()          -> Promise<{ page, screenshot, close }>
 *   page: Playwright Page object
 *   screenshot: async () -> Buffer
 *   close: async () -> void
 * deps.resolveToken()           -> string|null
 * deps.resolveDashboardUrl(tok) -> string
 * deps.pixelDiff(buf, path)     -> number|null
 * deps.saveBaseline             -> boolean (write screenshot as new baseline)
 */
async function runVisualCheck(opts = {}, deps = {}) {
  const minH = opts.minTileHeightPx || cfg('minTileHeightPx', DEFAULTS.minTileHeightPx);
  const maxEV = opts.maxEmptyVerticalRatio || cfg('maxEmptyVerticalRatio', DEFAULTS.maxEmptyVerticalRatio);
  const maxDP = opts.maxDiffPercent != null ? opts.maxDiffPercent : cfg('maxDiffPercent', DEFAULTS.maxDiffPercent);
  const checks = opts.checks || cfg('checks', {});

  const tileHeightEnabled = checks.tileHeight !== false;
  const emptySpaceEnabled = checks.emptyVerticalSpace !== false;
  const pixelEnabled = checks.pixelDiff !== false;

  const getToken = deps.resolveToken || resolveToken;
  const getUrl = deps.resolveDashboardUrl || resolveDashboardUrl;
  const doDiff = deps.pixelDiff || pixelDiff;
  const launchBrowser = deps.launchBrowser || defaultLaunchBrowser;
  const saveBaseline = !!(opts.saveBaseline || deps.saveBaseline);

  const defects = [];
  let screenshotPath = null;
  let diffPercent = null;

  let browser;
  try {
    const token = getToken();
    const url = getUrl(token);
    const vw = cfg('viewportWidth', DEFAULTS.viewportWidth);
    const vh = cfg('viewportHeight', DEFAULTS.viewportHeight);
    const timeout = cfg('pageLoadTimeoutMs', DEFAULTS.pageLoadTimeoutMs);

    browser = await launchBrowser({ viewportWidth: vw, viewportHeight: vh, timeout });
    if (!browser) return { ok: false, defects: ['browser-launch-failed'], screenshotPath: null, diffPercent: null, exitCode: 2 };

    // Navigate to the dashboard
    await browser.page.goto(url, { waitUntil: 'networkidle', timeout });

    // Wait for at least one tile to render
    try {
      await browser.page.waitForSelector('[data-section]', { timeout: timeout / 2 });
    } catch {
      await browser.close();
      return { ok: false, defects: ['no-tiles-rendered'], screenshotPath: null, diffPercent: null, exitCode: 2 };
    }

    // DOM structural checks
    const tiles = await browser.page.evaluate(domInspect);

    if (tiles.length === 0) {
      await browser.close();
      return { ok: false, defects: ['no-tiles-found'], screenshotPath: null, diffPercent: null, exitCode: 2 };
    }

    for (const tile of tiles) {
      if (tileHeightEnabled && tile.height < minH) {
        defects.push(`TILE-HEIGHT: "${tile.name}" is ${tile.height}px (min ${minH}px)`);
      }
      if (emptySpaceEnabled && tile.emptyRatio > maxEV) {
        const pct = Math.round(tile.emptyRatio * 100);
        defects.push(`EMPTY-SPACE: "${tile.name}" has ${pct}% empty vertical space (max ${Math.round(maxEV * 100)}%)`);
      }
    }

    // Screenshot
    const screenshotBuf = await browser.screenshot();
    screenshotPath = timestampedScreenshotPath();
    fs.writeFileSync(screenshotPath, screenshotBuf);

    // Pixel diff vs baseline
    if (pixelEnabled) {
      const bp = baselinePath();
      if (saveBaseline || !fs.existsSync(bp)) {
        // Save as new baseline (first run or explicit --save-baseline)
        fs.mkdirSync(path.dirname(bp), { recursive: true });
        fs.writeFileSync(bp, screenshotBuf);
        diffPercent = 0;
      } else {
        diffPercent = doDiff(screenshotBuf, bp);
        if (diffPercent !== null && diffPercent > maxDP) {
          defects.push(`PIXEL-DIFF: ${diffPercent.toFixed(1)}% pixel difference vs baseline (max ${maxDP}%)`);
        }
      }
    }

    await browser.close();
  } catch (err) {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
    return {
      ok: false,
      defects: [`browser-error: ${err.message}`],
      screenshotPath,
      diffPercent,
      exitCode: 2,
    };
  }

  return {
    ok: defects.length === 0,
    defects,
    screenshotPath,
    diffPercent,
    exitCode: defects.length === 0 ? 0 : 1,
  };
}

// ---------------------------------------------------------------------------
// Default browser launcher (uses Playwright)
// ---------------------------------------------------------------------------

async function defaultLaunchBrowser(opts = {}) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: opts.viewportWidth || 1280, height: opts.viewportHeight || 900 },
  });
  const page = await ctx.newPage();
  return {
    page,
    screenshot: async () => page.screenshot({ fullPage: true }),
    close: async () => browser.close(),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const saveBaseline = args.includes('--save-baseline');
  const urlArg = (() => { const i = args.indexOf('--url'); return i !== -1 ? args[i + 1] : null; })();

  const opts = { saveBaseline };
  const deps = {};
  if (urlArg) deps.resolveDashboardUrl = () => urlArg;

  (async () => {
    const result = await runVisualCheck(opts, deps);

    if (result.defects.length === 0) {
      console.log('[visual-check] PASS - dashboard looks good');
      if (result.diffPercent !== null) console.log(`  pixel diff: ${result.diffPercent.toFixed(2)}%`);
    } else {
      console.error('[visual-check] FAIL');
      for (const d of result.defects) console.error(`  DEFECT: ${d}`);
    }
    if (result.screenshotPath) console.log(`  screenshot: ${result.screenshotPath}`);
    process.exit(result.exitCode || (result.ok ? 0 : 1));
  })();
}

module.exports = { runVisualCheck, pixelDiff, domInspect };
