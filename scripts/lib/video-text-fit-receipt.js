const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VIDEO_TEXT_FIT_SCHEMA = 'secondbrain.video-text-fit';
const VIDEO_TEXT_FIT_SCHEMA_VERSION = 1;
const DEFAULT_TOLERANCE_PX = 1;
// Receipt-then-manifest write order can leave the manifest timestamp a few
// milliseconds after verifiedAt; the SHA binding makes that ordering skew harmless.
const RECEIPT_BUILD_WRITE_SKEW_MS = 5000;

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function defaultVideoTextFitReceiptPath(videoPath) {
  return `${path.resolve(String(videoPath))}.text-fit.json`;
}

function resolveVideoTextFitReceiptPath(videoPath, entry = {}) {
  const resolvedVideoPath = path.resolve(String(videoPath));
  const requested = String(
    entry.text_fit_receipt_file || entry.textFitReceiptPath || entry.text_fit_receipt_path || '',
  ).trim();
  if (!requested) return defaultVideoTextFitReceiptPath(resolvedVideoPath);
  const candidate = path.resolve(path.dirname(resolvedVideoPath), requested);
  if (path.dirname(candidate) !== path.dirname(resolvedVideoPath)) {
    throw new Error('text-fit receipt must be beside the final video');
  }
  return candidate;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeRect(rect = {}) {
  const left = finiteNumber(rect.left);
  const top = finiteNumber(rect.top);
  const right = finiteNumber(rect.right);
  const bottom = finiteNumber(rect.bottom);
  const width = finiteNumber(rect.width) ?? (left !== null && right !== null ? right - left : null);
  const height = finiteNumber(rect.height) ?? (top !== null && bottom !== null ? bottom - top : null);
  return { left, top, right, bottom, width, height };
}

function clippingOverflow(value) {
  return ['hidden', 'clip', 'auto', 'scroll'].includes(String(value || '').toLowerCase());
}

function measureTextElement(element = {}, viewport = {}, tolerancePx = DEFAULT_TOLERANCE_PX) {
  const width = finiteNumber(viewport.width);
  const height = finiteNumber(viewport.height);
  const rect = normalizeRect(element.rect || element.bounds);
  const reasons = [];
  if (!(width > 0) || !(height > 0)) reasons.push('delivery viewport is missing or invalid');
  if (
    rect.left === null ||
    rect.top === null ||
    rect.right === null ||
    rect.bottom === null ||
    !(rect.width > 0) ||
    !(rect.height > 0)
  ) {
    reasons.push('text bounds are missing, non-finite, or zero-sized');
  } else if (
    rect.left < -tolerancePx ||
    rect.top < -tolerancePx ||
    rect.right > width + tolerancePx ||
    rect.bottom > height + tolerancePx
  ) {
    reasons.push(
      `viewport bounds ${rect.left},${rect.top}-${rect.right},${rect.bottom} outside ${width}x${height}`,
    );
  }

  const clientWidth = finiteNumber(element.clientWidth);
  const clientHeight = finiteNumber(element.clientHeight);
  const scrollWidth = finiteNumber(element.scrollWidth);
  const scrollHeight = finiteNumber(element.scrollHeight);
  if (
    clippingOverflow(element.overflowX) &&
    clientWidth !== null &&
    scrollWidth !== null &&
    scrollWidth > clientWidth + tolerancePx
  ) {
    reasons.push(`container width ${scrollWidth}>${clientWidth}`);
  }
  if (
    clippingOverflow(element.overflowY) &&
    clientHeight !== null &&
    scrollHeight !== null &&
    scrollHeight > clientHeight + tolerancePx
  ) {
    reasons.push(`container height ${scrollHeight}>${clientHeight}`);
  }

  const clippingAncestors = Array.isArray(element.clippingAncestors)
    ? element.clippingAncestors
    : [];
  for (const ancestor of clippingAncestors) {
    const ancestorRect = normalizeRect(ancestor.rect || ancestor.bounds);
    const ancestorLabel = String(ancestor.key || ancestor.id || 'clipping ancestor');
    if (
      rect.left !== null &&
      ancestorRect.left !== null &&
      (rect.left < ancestorRect.left - tolerancePx || rect.right > ancestorRect.right + tolerancePx)
    ) {
      reasons.push(`${ancestorLabel} clips text horizontally`);
    }
    if (
      rect.top !== null &&
      ancestorRect.top !== null &&
      (rect.top < ancestorRect.top - tolerancePx || rect.bottom > ancestorRect.bottom + tolerancePx)
    ) {
      reasons.push(`${ancestorLabel} clips text vertically`);
    }
    const ancestorClientWidth = finiteNumber(ancestor.clientWidth);
    const ancestorScrollWidth = finiteNumber(ancestor.scrollWidth);
    const ancestorClientHeight = finiteNumber(ancestor.clientHeight);
    const ancestorScrollHeight = finiteNumber(ancestor.scrollHeight);
    if (
      clippingOverflow(ancestor.overflowX) &&
      ancestorClientWidth !== null &&
      ancestorScrollWidth !== null &&
      ancestorScrollWidth > ancestorClientWidth + tolerancePx
    ) {
      reasons.push(`${ancestorLabel} hidden width ${ancestorScrollWidth}>${ancestorClientWidth}`);
    }
    if (
      clippingOverflow(ancestor.overflowY) &&
      ancestorClientHeight !== null &&
      ancestorScrollHeight !== null &&
      ancestorScrollHeight > ancestorClientHeight + tolerancePx
    ) {
      reasons.push(`${ancestorLabel} hidden height ${ancestorScrollHeight}>${ancestorClientHeight}`);
    }
  }

  return {
    id: String(element.id || element.key || '').trim(),
    text: String(element.text || element.label || '').trim(),
    textSha256: sha256Buffer(String(element.text || element.label || '').trim()),
    rect,
    clientWidth,
    clientHeight,
    scrollWidth,
    scrollHeight,
    overflowX: String(element.overflowX || ''),
    overflowY: String(element.overflowY || ''),
    clippingAncestors,
    animationIds: Array.isArray(element.animationIds)
      ? [...new Set(element.animationIds.map(String).filter(Boolean))].sort()
      : [],
    reasons: [...new Set(reasons)],
  };
}

function normalizeTextFitSamples(samples, viewport, tolerancePx = DEFAULT_TOLERANCE_PX) {
  return (Array.isArray(samples) ? samples : []).map((sample, index) => ({
    atMs: finiteNumber(sample && sample.atMs) ?? index,
    phase: String((sample && sample.phase) || 'timeline-sample'),
    animationId: String((sample && sample.animationId) || ''),
    elements: (Array.isArray(sample && sample.elements) ? sample.elements : []).map((element) =>
      measureTextElement(element, viewport, tolerancePx),
    ),
  }));
}

function summarizeTextElements(samples) {
  const rows = new Map();
  for (const sample of samples) {
    for (const element of sample.elements) {
      const id = element.id || `text:${element.textSha256}`;
      const current = rows.get(id) || {
        id,
        textSha256: element.textSha256,
        sampleCount: 0,
        minLeft: Infinity,
        minTop: Infinity,
        maxRight: -Infinity,
        maxBottom: -Infinity,
        maxScrollWidth: 0,
        maxScrollHeight: 0,
      };
      current.sampleCount += 1;
      current.minLeft = Math.min(current.minLeft, element.rect.left ?? Infinity);
      current.minTop = Math.min(current.minTop, element.rect.top ?? Infinity);
      current.maxRight = Math.max(current.maxRight, element.rect.right ?? -Infinity);
      current.maxBottom = Math.max(current.maxBottom, element.rect.bottom ?? -Infinity);
      current.maxScrollWidth = Math.max(current.maxScrollWidth, element.scrollWidth || 0);
      current.maxScrollHeight = Math.max(current.maxScrollHeight, element.scrollHeight || 0);
      rows.set(id, current);
    }
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      minLeft: Number.isFinite(row.minLeft) ? row.minLeft : null,
      minTop: Number.isFinite(row.minTop) ? row.minTop : null,
      maxRight: Number.isFinite(row.maxRight) ? row.maxRight : null,
      maxBottom: Number.isFinite(row.maxBottom) ? row.maxBottom : null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function analyzeTextFitSamples(samples, viewport, tolerancePx = DEFAULT_TOLERANCE_PX) {
  const normalized = normalizeTextFitSamples(samples, viewport, tolerancePx);
  const defects = [];
  const elements = summarizeTextElements(normalized);
  if (normalized.length === 0) {
    defects.push({ code: 'ZERO_SAMPLES', reason: 'no text-fit samples were recorded' });
  }
  if (elements.length === 0) {
    defects.push({ code: 'ZERO_ELEMENTS', reason: 'no audience-readable text elements were measured' });
  }
  const phases = new Set(normalized.map((sample) => sample.phase));
  if (!phases.has('timeline-start') || !phases.has('timeline-end')) {
    defects.push({
      code: 'ANIMATION_EXTREMES_UNDECLARED',
      reason: 'timeline-start and timeline-end text-fit extremes must both be declared',
    });
  }
  const animationIds = new Set();
  for (const sample of normalized) {
    for (const element of sample.elements) {
      for (const animationId of element.animationIds) animationIds.add(animationId);
      for (const reason of element.reasons) {
        defects.push({
          code: 'TEXT_OVERFLOW',
          sampleAtMs: sample.atMs,
          phase: sample.phase,
          elementId: element.id || `text:${element.textSha256}`,
          reason,
        });
      }
    }
  }
  for (const animationId of animationIds) {
    const hasStart = normalized.some(
      (sample) =>
        sample.animationId === animationId &&
        sample.phase === 'animation-start' &&
        sample.elements.some((element) => element.animationIds.includes(animationId)),
    );
    const hasEnd = normalized.some(
      (sample) =>
        sample.animationId === animationId &&
        sample.phase === 'animation-end' &&
        sample.elements.some((element) => element.animationIds.includes(animationId)),
    );
    if (!hasStart || !hasEnd) {
      defects.push({
        code: 'ANIMATION_EXTREMES_UNDECLARED',
        animationId,
        reason: `animation ${animationId} is missing a measured start or end extreme`,
      });
    }
  }
  const animationExtremes = normalized
    .filter((sample) =>
      ['timeline-start', 'timeline-end', 'animation-start', 'animation-end'].includes(sample.phase),
    )
    .map((sample) => ({
      phase: sample.phase,
      atMs: sample.atMs,
      animationId: sample.animationId || undefined,
    }));
  return {
    ok: defects.length === 0,
    samples: normalized,
    textElements: elements,
    animationExtremes,
    defects,
  };
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* best-effort cleanup of this helper's own temporary file */
    }
    throw error;
  }
}

function buildVideoTextFitReceipt(options = {}) {
  const videoPath = path.resolve(String(options.videoPath || ''));
  if (!options.videoPath || !fs.existsSync(videoPath)) {
    throw new Error(`final video not found: ${options.videoPath || '(missing)'}`);
  }
  const viewport = {
    width: finiteNumber(options.viewport && options.viewport.width),
    height: finiteNumber(options.viewport && options.viewport.height),
  };
  const analysis = analyzeTextFitSamples(
    options.samples,
    viewport,
    finiteNumber(options.tolerancePx) ?? DEFAULT_TOLERANCE_PX,
  );
  const sourceHtmlPath = options.sourceHtmlPath
    ? path.resolve(String(options.sourceHtmlPath))
    : '';
  const verifiedAt = String(options.verifiedAt || new Date().toISOString());
  const stat = fs.statSync(videoPath);
  return {
    schema: VIDEO_TEXT_FIT_SCHEMA,
    schemaVersion: VIDEO_TEXT_FIT_SCHEMA_VERSION,
    passed: analysis.ok,
    verifiedAt,
    finalVideo: {
      fileName: path.basename(videoPath),
      sha256: sha256File(videoPath),
      bytes: stat.size,
    },
    sourceHtml: sourceHtmlPath && fs.existsSync(sourceHtmlPath)
      ? { fileName: path.basename(sourceHtmlPath), sha256: sha256File(sourceHtmlPath) }
      : null,
    viewport,
    timeline: {
      durationMs: finiteNumber(options.durationMs),
      intervalMs: finiteNumber(options.intervalMs),
      sampleCount: analysis.samples.length,
      animationExtremes: analysis.animationExtremes,
    },
    textElementCount: analysis.textElements.length,
    textElements: analysis.textElements,
    samples: analysis.samples,
    defects: analysis.defects,
  };
}

function createVideoTextFitReceipt(options = {}) {
  const receipt = buildVideoTextFitReceipt(options);
  const receiptPath = options.receiptPath
    ? path.resolve(String(options.receiptPath))
    : defaultVideoTextFitReceiptPath(options.videoPath);
  if (path.dirname(receiptPath) !== path.dirname(path.resolve(String(options.videoPath)))) {
    throw new Error('text-fit receipt must be written beside the final video');
  }
  writeJsonAtomic(receiptPath, receipt);
  return { receipt, receiptPath, receiptSha256: sha256File(receiptPath) };
}

function parseReceipt(receiptPath) {
  try {
    return { receipt: JSON.parse(fs.readFileSync(receiptPath, 'utf8')), error: '' };
  } catch (error) {
    return { receipt: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function manifestVerifiedAtFloor(entry = {}) {
  const valid = [];
  for (const value of [entry.video_built_at, entry.built_at, entry.generated_at]) {
    const time = Date.parse(String(value || ''));
    if (Number.isFinite(time)) valid.push(time);
  }
  return valid.length ? new Date(Math.max(...valid)).toISOString() : '';
}

function verifyVideoTextFitReleaseGate(options = {}) {
  const videoPath = options.videoPath ? path.resolve(String(options.videoPath)) : '';
  if (!videoPath || !fs.existsSync(videoPath)) {
    return { ok: false, code: 'VIDEO_MISSING', reason: 'final video file is missing', videoPath };
  }
  let receiptPath;
  try {
    receiptPath = options.receiptPath
      ? resolveVideoTextFitReceiptPath(videoPath, { textFitReceiptPath: options.receiptPath })
      : resolveVideoTextFitReceiptPath(videoPath, options.manifestEntry || {});
  } catch (error) {
    return {
      ok: false,
      code: 'RECEIPT_PATH_INVALID',
      reason: error instanceof Error ? error.message : String(error),
      videoPath,
    };
  }
  if (!fs.existsSync(receiptPath)) {
    return {
      ok: false,
      code: 'RECEIPT_MISSING',
      reason: `text-fit receipt is missing for ${path.basename(videoPath)}`,
      videoPath,
      receiptPath,
    };
  }
  const parsed = parseReceipt(receiptPath);
  if (!parsed.receipt) {
    return {
      ok: false,
      code: 'RECEIPT_INVALID_JSON',
      reason: `text-fit receipt is unreadable: ${parsed.error}`,
      videoPath,
      receiptPath,
    };
  }
  const receipt = parsed.receipt;
  const fail = (code, reason) => ({
    ok: false,
    code,
    reason,
    videoPath,
    receiptPath,
    receipt,
  });
  if (
    receipt.schema !== VIDEO_TEXT_FIT_SCHEMA ||
    receipt.schemaVersion !== VIDEO_TEXT_FIT_SCHEMA_VERSION
  ) {
    return fail('RECEIPT_STALE_SCHEMA', 'text-fit receipt uses an obsolete or unknown contract');
  }
  if (receipt.passed !== true || (Array.isArray(receipt.defects) && receipt.defects.length > 0)) {
    return fail('RECEIPT_FAILED', 'text-fit receipt records a failing layout');
  }
  if (!(Number(receipt.textElementCount) > 0) || !Array.isArray(receipt.textElements) || !receipt.textElements.length) {
    return fail('ZERO_ELEMENTS', 'text-fit receipt measured zero audience-readable text elements');
  }
  if (!(Number(receipt.timeline && receipt.timeline.sampleCount) > 0) || !Array.isArray(receipt.samples) || !receipt.samples.length) {
    return fail('ZERO_SAMPLES', 'text-fit receipt contains no timeline samples');
  }
  const extremes = receipt.timeline && receipt.timeline.animationExtremes;
  if (
    !Array.isArray(extremes) ||
    !extremes.some((row) => row && row.phase === 'timeline-start') ||
    !extremes.some((row) => row && row.phase === 'timeline-end')
  ) {
    return fail(
      'ANIMATION_EXTREMES_UNDECLARED',
      'text-fit receipt does not declare measured timeline start and end extremes',
    );
  }
  const viewport = receipt.viewport || {};
  if (!(Number(viewport.width) > 0) || !(Number(viewport.height) > 0)) {
    return fail('VIEWPORT_INVALID', 'text-fit receipt has no valid delivery viewport');
  }
  const recomputed = analyzeTextFitSamples(receipt.samples, viewport, DEFAULT_TOLERANCE_PX);
  if (!recomputed.ok) {
    const first = recomputed.defects[0];
    return fail(
      'RECEIPT_RECOMPUTED_FAILED',
      `text-fit receipt samples fail independent recomputation: ${first.code}: ${first.reason}`,
    );
  }
  if (
    recomputed.samples.length !== Number(receipt.timeline.sampleCount) ||
    recomputed.textElements.length !== Number(receipt.textElementCount)
  ) {
    return fail(
      'RECEIPT_COUNT_MISMATCH',
      'text-fit receipt declared counts do not match its measured samples',
    );
  }
  for (const element of receipt.textElements) {
    if (
      !element ||
      !element.id ||
      !(Number(element.sampleCount) > 0) ||
      ![element.minLeft, element.minTop, element.maxRight, element.maxBottom].every((value) =>
        Number.isFinite(Number(value)),
      )
    ) {
      return fail('BOUNDS_INVALID', 'text-fit receipt is missing precise bounds for a declared element');
    }
  }
  const actualSha256 = sha256File(videoPath);
  const actualBytes = fs.statSync(videoPath).size;
  if (!receipt.finalVideo || receipt.finalVideo.sha256 !== actualSha256) {
    return fail('VIDEO_SHA_MISMATCH', 'text-fit receipt is not bound to the current final video bytes');
  }
  if (Number(receipt.finalVideo.bytes) !== actualBytes) {
    return fail('VIDEO_BYTES_MISMATCH', 'text-fit receipt byte count does not match the final video');
  }
  const expectedVideoSha256 = String(
    options.expectedVideoSha256 || (options.manifestEntry && options.manifestEntry.video_sha256) || '',
  ).trim();
  if (expectedVideoSha256 && expectedVideoSha256 !== actualSha256) {
    return fail('MANIFEST_VIDEO_SHA_MISMATCH', 'manifest video SHA does not match the final video');
  }
  const receiptSha256 = sha256File(receiptPath);
  const expectedReceiptSha256 = String(
    options.expectedReceiptSha256 ||
      (options.manifestEntry && options.manifestEntry.text_fit_receipt_sha256) ||
      '',
  ).trim();
  if (expectedReceiptSha256 && expectedReceiptSha256 !== receiptSha256) {
    return fail('RECEIPT_SHA_MISMATCH', 'manifest receipt SHA does not match the text-fit receipt');
  }
  const verifiedAtMs = Date.parse(String(receipt.verifiedAt || ''));
  if (!Number.isFinite(verifiedAtMs)) {
    return fail('VERIFIED_AT_INVALID', 'text-fit receipt has no valid verification timestamp');
  }
  const minimumVerifiedAt =
    options.minimumVerifiedAt || manifestVerifiedAtFloor(options.manifestEntry || {});
  const minimumVerifiedAtMs = Date.parse(String(minimumVerifiedAt || ''));
  // The SHA checks above already bind this receipt to the exact final bytes.
  // The build writes the receipt and then the manifest, so the manifest's
  // generated_at can trail verifiedAt by milliseconds (2026-09-27: 181 ms kept
  // a verified clip red for weeks). Only a receipt older than that write skew is stale.
  if (Number.isFinite(minimumVerifiedAtMs) && verifiedAtMs < minimumVerifiedAtMs - RECEIPT_BUILD_WRITE_SKEW_MS) {
    return fail('RECEIPT_STALE', 'text-fit receipt predates the final video build');
  }
  return {
    ok: true,
    code: 'TEXT_FIT_VERIFIED',
    reason: 'text-fit receipt matches the final video SHA and passed all measured bounds',
    videoPath,
    receiptPath,
    receipt,
    videoSha256: actualSha256,
    receiptSha256,
  };
}

function applyVideoTextFitGate(entry, videoPath, options = {}) {
  const manifestEntry = options.refreshBindings
    ? {
        ...entry,
        video_sha256: '',
        text_fit_receipt_sha256: '',
        video_built_at: '',
        built_at: '',
        generated_at: '',
      }
    : entry;
  const gate = verifyVideoTextFitReleaseGate({
    ...options,
    videoPath,
    manifestEntry,
  });
  entry.text_fit_gate = {
    ok: gate.ok,
    code: gate.code,
    reason: gate.reason,
    checked_at: new Date().toISOString(),
  };
  if (gate.ok) {
    entry.video_sha256 = gate.videoSha256;
    entry.text_fit_receipt_file = path.basename(gate.receiptPath);
    entry.text_fit_receipt_sha256 = gate.receiptSha256;
    entry.text_fit_verified_at = gate.receipt.verifiedAt;
    entry.text_fit_element_count = gate.receipt.textElementCount;
  }
  return gate;
}

module.exports = {
  DEFAULT_TOLERANCE_PX,
  VIDEO_TEXT_FIT_SCHEMA,
  VIDEO_TEXT_FIT_SCHEMA_VERSION,
  analyzeTextFitSamples,
  applyVideoTextFitGate,
  buildVideoTextFitReceipt,
  createVideoTextFitReceipt,
  defaultVideoTextFitReceiptPath,
  manifestVerifiedAtFloor,
  measureTextElement,
  normalizeTextFitSamples,
  resolveVideoTextFitReceiptPath,
  sha256File,
  verifyVideoTextFitReleaseGate,
};
