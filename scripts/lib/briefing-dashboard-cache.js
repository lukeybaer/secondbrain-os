"use strict";

const fs = require('node:fs');
const path = require('node:path');
const briefingManifest = require("./briefing-card-manifest.js");

const NEWS_PREVIEW_CARD_IDS = Object.freeze(
  briefingManifest.CARDS.filter(briefingManifest.isNewsCard).map((card) => card.id),
);

// Server-side publication cache for the briefing dashboard page (2026-09-02).
//
// The rendered page is about 4 MB and a cold render takes seconds on an idle
// m7i.xlarge and did not finish within 30 s on a CPU-starved t3.medium. Rules:
//
// 1. In production snapshot mode, a changed signature serves the last completed
//    page and schedules replacement work outside the HTTP process. A reader
//    never pays for full-board rendering.
// 2. The legacy in-memory mode remains available to bounded tests and tools.
// 3. In snapshot mode, the boot/read/interval checks only schedule a child
//    renderer. One child runs at a time and atomically replaces the incumbent.
// 4. Exact-generation QC previews bypass this shared cache in both directions:
//    they neither consume an accepted-page entry nor replace one.
//
// The cache holds one entry at a time (clear on set), as before.

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

function createBriefingDashboardCache({
  render,
  renderPreview = render,
  context,
  load = null,
  schedule = null,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now,
  log = () => {},
  defaultUrl = "/briefing",
  canRender = () => true,
  bypass = () => false,
} = {}) {
  if (
    typeof render !== "function" ||
    typeof renderPreview !== "function" ||
    typeof context !== "function"
  ) {
    throw new Error(
      "briefing dashboard cache requires render(url), renderPreview(url), and context(url)",
    );
  }
  const cache = new Map();
  let refreshDue = false;

  function store(key, signature, html, at) {
    cache.clear();
    cache.set(key, { signature, renderedAt: at, html });
  }

  function loadIntoCache(ctx) {
    if (typeof load !== 'function') return null;
    try {
      const value = load(ctx);
      if (!value || typeof value.html !== 'string' || !value.html) return null;
      const entry = {
        signature: String(value.signature || 'persisted-unknown'),
        renderedAt: Number(value.renderedAt) || now(),
        html: value.html,
      };
      cache.clear();
      cache.set(ctx.key, entry);
      return entry;
    } catch (error) {
      log(`[briefing-dashboard] persisted snapshot load failed: ${String((error && error.message) || error)}`);
      return null;
    }
  }

  function requestRefresh(reason, url) {
    refreshDue = true;
    if (typeof schedule !== 'function') return false;
    if (!canRender()) return false;
    try {
      return schedule(reason, url) !== false;
    } catch (error) {
      log(`[briefing-dashboard] snapshot refresh scheduling failed: ${String((error && error.message) || error)}`);
      return false;
    }
  }

  function get(url) {
    const at = now();
    if (bypass(url)) {
      if (!canRender()) {
        const error = new Error('Dashboard render deferred for active voice traffic');
        error.code = 'VOICE_RENDER_DEFERRED';
        throw error;
      }
      return renderPreview(url);
    }
    const ctx = context(url);
    const cached = cache.get(ctx.key) || loadIntoCache(ctx);
    if (cached && cached.signature === ctx.signature) {
      const aged = at - cached.renderedAt >= maxAgeMs;
      if (!aged) return cached.html;
      if (ctx.defaultPage) {
        if (typeof schedule === 'function') requestRefresh('aged-read', url);
        else refreshDue = true;
        return cached.html;
      }
    }
    if (cached && typeof schedule === 'function') {
      requestRefresh('changed-read', url);
      return cached.html;
    }
    if (!cached && typeof schedule === 'function') {
      requestRefresh('cold-read', url);
      const error = new Error('Briefing dashboard snapshot is being prepared');
      error.code = 'BRIEFING_SNAPSHOT_UNAVAILABLE';
      throw error;
    }
    if (!canRender()) {
      const error = new Error('Dashboard render deferred for active voice traffic');
      error.code = 'VOICE_RENDER_DEFERRED';
      throw error;
    }
    const html = render(url);
    store(ctx.key, ctx.signature, html, at);
    return html;
  }

  function warm(reason = "interval") {
    if (!canRender()) return false;
    try {
      const ctx = context(defaultUrl);
      const cached = cache.get(ctx.key) || loadIntoCache(ctx);
      const fresh =
        cached &&
        cached.signature === ctx.signature &&
        now() - cached.renderedAt < maxAgeMs;
      if (fresh && !refreshDue) return false;
      if (typeof schedule === 'function') {
        return requestRefresh(reason, defaultUrl);
      }
      refreshDue = false;
      const startedAt = now();
      const html = render(defaultUrl);
      store(ctx.key, ctx.signature, html, startedAt);
      log(
        `[briefing-dashboard] cache warmed (${reason}) in ${now() - startedAt} ms for ${ctx.key}`,
      );
      return true;
    } catch (error) {
      log(
        `[briefing-dashboard] cache warm failed: ${String((error && error.message) || error)}`,
      );
      return false;
    }
  }

  function invalidate() {
    if (typeof schedule === 'function') {
      requestRefresh('invalidate', defaultUrl);
      return;
    }
    cache.clear();
    refreshDue = false;
  }

  function reload(url = defaultUrl) {
    try {
      const ctx = context(url);
      const loaded = loadIntoCache(ctx);
      if (loaded && loaded.signature === ctx.signature) refreshDue = false;
      return Boolean(loaded);
    } catch (error) {
      log(`[briefing-dashboard] snapshot reload failed: ${String((error && error.message) || error)}`);
      return false;
    }
  }

  function status(url = defaultUrl) {
    const ctx = context(url);
    const entry = cache.get(ctx.key) || loadIntoCache(ctx);
    return {
      key: ctx.key,
      available: Boolean(entry),
      renderedAt: entry ? entry.renderedAt : null,
      signatureMatchesCurrent: Boolean(entry && entry.signature === ctx.signature),
      refreshDue,
    };
  }

  return {
    get,
    warm,
    invalidate,
    reload,
    status,
    refreshDue: () => refreshDue,
    size: () => cache.size,
  };
}

// Redraw pacing for the owner snapshot (2026-10-03). Each snapshot carries the
// signature taken before its render, so card writes during a night render make
// it stale on arrival and the 60 s warmer spawned the next render at once. A
// warm key now waits a minimum gap measured from the previous render's exit;
// a refused schedule leaves refreshDue set, so the warmer's next tick supplies
// the trailing render. A cold key (rollover, boot), a night phase change, and
// the settling and frozen phases render immediately so delivery never waits.
const SNAPSHOT_MIN_RENDER_GAP_MS = 3 * 60 * 1000;
const GAP_EXEMPT_PHASES = new Set(['settling', 'frozen']);

function snapshotRenderAdmission({
  nowMs,
  lastExitAt = 0,
  lastSpawnPhase = null,
  phase = 'unknown',
  snapshotAvailable,
  minGapMs = SNAPSHOT_MIN_RENDER_GAP_MS,
}) {
  if (!snapshotAvailable) return { admit: true, why: 'cold' };
  if (lastSpawnPhase !== null && phase !== lastSpawnPhase) return { admit: true, why: 'phase-change' };
  if (GAP_EXEMPT_PHASES.has(phase)) return { admit: true, why: 'settled-window' };
  if (!lastExitAt || nowMs >= lastExitAt + minGapMs) return { admit: true, why: 'gap-elapsed' };
  return { admit: false, why: 'min-gap', retryAt: lastExitAt + minGapMs };
}

function briefingDashboardSnapshotPath(dataDir, key) {
  const safeKey = String(key || 'none').replace(/[^a-zA-Z0-9._-]+/g, '_');
  return path.join(dataDir, 'agent', 'briefing-dashboard-snapshots', `${safeKey}.json`);
}

function readBriefingDashboardSnapshot(dataDir, ctx) {
  const file = briefingDashboardSnapshotPath(dataDir, ctx.key);
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    value.schema !== 'secondbrain.briefing-dashboard-snapshot.v1' ||
    value.key !== ctx.key ||
    typeof value.html !== 'string' ||
    !/^<!doctype html>/i.test(value.html.trimStart())
  ) {
    throw new Error(`invalid briefing dashboard snapshot: ${file}`);
  }
  return {
    html: value.html,
    signature: String(value.signature || 'persisted-unknown'),
    renderedAt: Date.parse(value.renderedAt) || fs.statSync(file).mtimeMs,
  };
}

function writeBriefingDashboardSnapshot(dataDir, ctx, html, renderedAt = Date.now()) {
  const file = briefingDashboardSnapshotPath(dataDir, ctx.key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    schema: 'secondbrain.briefing-dashboard-snapshot.v1',
    key: ctx.key,
    signature: ctx.signature,
    renderedAt: new Date(renderedAt).toISOString(),
    html,
  }));
  fs.renameSync(tmp, file);
  try {
    const snapshots = fs.readdirSync(path.dirname(file))
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(path.dirname(file), name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const stale of snapshots.slice(3)) fs.unlinkSync(stale);
    const orphanCutoff = Date.now() - 10 * 60 * 1000;
    for (const name of fs.readdirSync(path.dirname(file)).filter((entry) => entry.endsWith('.tmp'))) {
      const orphan = path.join(path.dirname(file), name);
      if (fs.statSync(orphan).mtimeMs < orphanCutoff) fs.unlinkSync(orphan);
    }
  } catch {
    // Retention is best-effort after the accepted snapshot is already atomic.
  }
  return file;
}

function isBriefingGenerationPreviewUrl(url) {
  const params = new URL(String(url || "/briefing"), "http://localhost")
    .searchParams;
  return Boolean(
    params.get("previewCardId") && params.get("previewGenerationId"),
  );
}

function isBriefingPreviewRequestUrl(url) {
  const params = new URL(String(url || "/briefing"), "http://localhost")
    .searchParams;
  return Boolean(
    params.get("previewCardId") ||
      params.get("previewGenerationId") ||
      params.get("verificationCardId"),
  );
}

// System Health is the largest exact-card Gate-A surface and only depends on
// its own artifact plus the Full-Life rows merged into it at render time. A
// preview must remain generation-pinned and uncached, but it must not render
// every unrelated card on the board: the full cold render can exceed curl's
// 30-second Gate-A deadline on a CPU-starved production instance.
function scopedBriefingPreviewArtifactIds(url) {
  const params = new URL(String(url || "/briefing"), "http://localhost")
    .searchParams;
  const cardId = String(params.get("previewCardId") || "").trim();
  const generationId = String(params.get("previewGenerationId") || "").trim();
  const verificationCardId = String(params.get("verificationCardId") || "").trim();
  if (generationId && cardId === "system_health") {
    return ["system_health", "full_life_backup"];
  }
  if (
    (generationId && NEWS_PREVIEW_CARD_IDS.includes(cardId)) ||
    (!generationId && NEWS_PREVIEW_CARD_IDS.includes(verificationCardId))
  ) {
    // News freshness and cross-card de-duplication require the whole ordered
    // news family, but not the multi-megabyte non-news board. The same bounded
    // accepted-only projection lets Gate A fetch yesterday's rendered article
    // set without weakening the day-over-day comparison.
    return [...NEWS_PREVIEW_CARD_IDS];
  }
  if (generationId && cardId) return [cardId];
  if (!generationId && verificationCardId) return [verificationCardId];
  return null;
}

module.exports = {
  createBriefingDashboardCache,
  isBriefingGenerationPreviewUrl,
  isBriefingPreviewRequestUrl,
  scopedBriefingPreviewArtifactIds,
  NEWS_PREVIEW_CARD_IDS,
  DEFAULT_MAX_AGE_MS,
  SNAPSHOT_MIN_RENDER_GAP_MS,
  snapshotRenderAdmission,
  briefingDashboardSnapshotPath,
  readBriefingDashboardSnapshot,
  writeBriefingDashboardSnapshot,
};
