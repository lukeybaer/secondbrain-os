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
const os = require('os');
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

// Dispatch arrows also carry data-section so they can retain exact card
// identity. Visual QC must inspect the rendered card container, not those
// small buttons.
const CARD_TILE_SELECTOR = 'section.tile[data-section]';

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

function visualCardKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function captureCardViews(page, { scopeCardIds = [], outputDir = screenshotDir() } = {}) {
  // Visual inspection opens cards but must never consume ExampleCo's unread pair.
  // Intercept only this test browser's acknowledgment; the real route remains tested separately.
  const openRoute = '**/briefing/psychology/open';
  const suppressReading = (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, visualInspectionOnly: true }),
  });
  await page.route(openRoute, suppressReading);
  try {
    return await captureCardViewsWithReadingSuppressed(page, { scopeCardIds, outputDir });
  } finally {
    await page.unroute(openRoute, suppressReading);
  }
}

async function captureCardViewsWithReadingSuppressed(page, { scopeCardIds, outputDir }) {
  const wanted = new Set((scopeCardIds || []).map(visualCardKey).filter(Boolean));
  const cards = await page.evaluate((selector) =>
    Array.from(document.querySelectorAll(selector)).map((tile, index) => ({
      index,
      name: tile.getAttribute('data-section') || `card-${index + 1}`,
    })),
    CARD_TILE_SELECTOR,
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = path.join(outputDir, `card-views-${stamp}`);
  fs.mkdirSync(runDir, { recursive: true });
  const captures = [];
  const defects = [];

  for (const card of cards) {
    const key = visualCardKey(card.name);
    if (wanted.size && ![...wanted].some((id) => key === id || key.includes(id) || id.includes(key))) {
      continue;
    }
    const tile = page.locator(CARD_TILE_SELECTOR).nth(card.index);
    const topLevelPath = path.join(runDir, `${key || `card-${card.index + 1}`}-tile.png`);
    await tile.screenshot({ path: topLevelPath });
    let detailPath = null;
    try {
      await tile.click({ position: { x: 24, y: 24 } });
      const overlay = page.locator('#detailOverlay');
      await overlay.waitFor({ state: 'visible', timeout: 3000 });
      detailPath = path.join(runDir, `${key || `card-${card.index + 1}`}-detail.png`);
      await overlay.screenshot({ path: detailPath });
      await page.keyboard.press('Escape');
      try {
        await overlay.waitFor({ state: 'hidden', timeout: 3000 });
      } catch (error) {
        defects.push(
          `DETAIL-VIEW: "${card.name}" did not close after inspection (${error.message})`,
        );
        captures.push({ cardId: key, title: card.name, topLevelPath, detailPath });
        break;
      }
    } catch (error) {
      defects.push(`DETAIL-VIEW: "${card.name}" did not open for visual inspection (${error.message})`);
      await page.keyboard.press('Escape').catch(() => {});
    }
    captures.push({ cardId: key, title: card.name, topLevelPath, detailPath });
  }

  if (wanted.size) {
    for (const id of wanted) {
      if (!captures.some((row) => row.cardId === id || row.cardId.includes(id) || id.includes(row.cardId))) {
        defects.push(`CARD-VIEW-MISSING: no rendered tile matched scoped card ${id}`);
      }
    }
  }
  return { captures, defects, runDir };
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
function domInspect(selector) {
  const results = [];
  const tiles = Array.from(document.querySelectorAll(selector));
  for (const tile of tiles) {
    const rect = tile.getBoundingClientRect();
    const name = tile.getAttribute('data-section') || 'unknown';

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
  let cardViews = [];
  let cardViewDir = null;

  let browser;
  try {
    const token = getToken();
    const url = getUrl(token);
    const vw = cfg('viewportWidth', DEFAULTS.viewportWidth);
    const vh = cfg('viewportHeight', DEFAULTS.viewportHeight);
    const timeout = cfg('pageLoadTimeoutMs', DEFAULTS.pageLoadTimeoutMs);

    browser = await launchBrowser({ viewportWidth: vw, viewportHeight: vh, timeout });
    if (!browser) return { ok: false, defects: ['browser-launch-failed'], screenshotPath: null, diffPercent: null, exitCode: 2 };

    // The briefing page can keep background requests open; wait for DOM, then
    // use the tile selector below as the rendered-ready proof.
    await browser.page.goto(url, { waitUntil: 'domcontentloaded', timeout });

    // Wait for at least one tile to render
    try {
      await browser.page.waitForSelector(CARD_TILE_SELECTOR, { timeout: timeout / 2 });
    } catch {
      await browser.close();
      return { ok: false, defects: ['no-tiles-rendered'], screenshotPath: null, diffPercent: null, exitCode: 2 };
    }

    // DOM structural checks
    const tiles = await browser.page.evaluate(domInspect, CARD_TILE_SELECTOR);

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

    if (opts.captureCardViews) {
      const cardEvidence = await captureCardViews(browser.page, {
        scopeCardIds: opts.scopeCardIds || [],
      });
      cardViews = cardEvidence.captures;
      cardViewDir = cardEvidence.runDir;
      defects.push(...cardEvidence.defects);
    }

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
      defects: [`browser-error: ${redactUrlSecrets(err.message)}`],
      screenshotPath,
      diffPercent,
      exitCode: 2,
    };
  }

  return {
    ok: defects.length === 0,
    defects,
    screenshotPath,
    cardViews,
    cardViewDir,
    diffPercent,
    exitCode: defects.length === 0 ? 0 : 1,
  };
}

function redactUrlSecrets(text) {
  return String(text || '').replace(/([?&]k=)[^&\s"')]+/g, '$1<redacted>');
}

// ---------------------------------------------------------------------------
// Default browser launcher (uses Playwright)
// ---------------------------------------------------------------------------

async function defaultLaunchBrowser(opts = {}) {
  const { chromium } = require('playwright');
  const lowResource = shouldUseLowResourceChromium();
  const browser = await chromium.launch(chromiumLaunchOptions());
  const ctx = await browser.newContext({
    viewport: { width: opts.viewportWidth || 1280, height: opts.viewportHeight || 900 },
  });
  const page = await ctx.newPage();
  return {
    page,
    screenshot: async () => page.screenshot({
      fullPage: !lowResource,
      timeout: opts.timeout || DEFAULTS.pageLoadTimeoutMs,
    }),
    close: async () => browser.close(),
  };
}

function shouldUseLowResourceChromium(env = process.env, platform = process.platform, totalMem = os.totalmem()) {
  if (env.SB_PLAYWRIGHT_LOW_RESOURCE === '0') return false;
  if (env.SB_PLAYWRIGHT_LOW_RESOURCE === '1') return true;
  return platform === 'linux' && totalMem > 0 && totalMem < 6 * 1024 * 1024 * 1024;
}

function chromiumLaunchOptions({
  env = process.env,
  platform = process.platform,
  totalMem = os.totalmem(),
} = {}) {
  const options = { headless: true };
  if (!shouldUseLowResourceChromium(env, platform, totalMem)) return options;
  options.args = [
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-renderer-backgrounding',
    '--no-zygote',
    '--single-process',
  ];
  return options;
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

module.exports = {
  CARD_TILE_SELECTOR,
  runVisualCheck,
  pixelDiff,
  domInspect,
  captureCardViews,
  visualCardKey,
  shouldUseLowResourceChromium,
  chromiumLaunchOptions,
  redactUrlSecrets,
};
