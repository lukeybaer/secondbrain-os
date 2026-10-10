'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readReportEvents, latestReportEventsBySubject } = require('./overnight-report-event-ledger.js');
const { SCALE_UP, TRANSITION_GRACE_MINUTES } = require('./nightly-resize-schedule.js');
const { briefingRunWindow, nextDateKey } = require('./briefing-run-window.js');
const { readDayManifest } = require('./briefing-day-manifest.js');
const { TOKEN_SPEND_PARETO_SCHEMA } = require('./token-spend-pareto.js');

const SCHEMA = 'amy.nightly-resize-measurement.v1';
const TIME_ZONE = 'America/Chicago';

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function ctParts(value = new Date()) {
  const fields = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const get = (type) => fields.find((part) => part.type === type)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

function inputPath(dataDir, nightId, phase) {
  return path.join(dataDir, 'agent', 'nightly-resize-measurements', 'inputs', `${nightId}-${phase}.json`);
}
function previousDate(date) {
  const [year, month, day] = String(date).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function compactCapacitySample(sample) {
  return {
    sampled_at: sample.sampled_at,
    instance_id: sample.instance_id || null,
    instance_type: sample.instance_type || null,
    load1: Number.isFinite(Number(sample.load1)) ? Number(sample.load1) : null,
    mem_available_mib: Number.isFinite(Number(sample.mem_available_mib)) ? Number(sample.mem_available_mib) : null,
    cloudwatch: sample.cloudwatch && typeof sample.cloudwatch === 'object' ? {
      ok: sample.cloudwatch.ok === true,
      cpu_credit_balance: sample.cloudwatch.cpu_credit_balance ?? null,
      cpu_utilization_percent: sample.cloudwatch.cpu_utilization_percent ?? null,
    } : null,
  };
}

// The capacity sampler runs throughout the day. Capture only two actual
// samples around the known resize boundary; never manufacture a historical
// before/after point from an arbitrary later sample.
function captureResizeBoundarySample({ dataDir, sample, now = new Date() } = {}) {
  if (!dataDir || !sample?.sampled_at) return null;
  const ct = ctParts(now);
  const minute = ct.hour * 60 + Number(new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, minute: '2-digit' }).format(now));
  const scaleUp = SCALE_UP.hour * 60 + SCALE_UP.minute;
  const transitionEnd = scaleUp + TRANSITION_GRACE_MINUTES;
  // Bind the evidence to the actual AWS-ResizeInstance schedule, rather than
  // a guessed hour. Before is sampled before 22:15; after starts only when
  // the scheduler's 15-minute transition grace has elapsed.
  const phase = minute >= scaleUp - 15 && minute < scaleUp ? 'before' : (minute >= transitionEnd && minute < transitionEnd + 30 ? 'after' : '');
  if (!phase) return null;
  // The normal capacity sampler's nightId begins at 22:35, but the required
  // pre-resize sample is deliberately earlier at 21:xx. Both boundary inputs
  // belong to that evening's overnight id.
  const nightId = ct.date;
  const file = inputPath(dataDir, nightId, phase);
  if (fs.existsSync(file)) return { captured: false, reason: 'already-captured', file, phase, nightId };
  const value = { schema: SCHEMA, phase, night_id: nightId, captured_at: now.toISOString(), sample: compactCapacitySample(sample) };
  writeJsonAtomic(file, value);
  return { captured: true, file, phase, nightId, value };
}

function measurementPath(dataDir, date) {
  return path.join(dataDir, 'agent', 'nightly-resize-measurements', `${date}.json`);
}

function deliveryEvidence(dataDir, date) {
  const markerFile = path.join(dataDir, 'agent', `briefing-notify-${date}.json`);
  const marker = readJson(markerFile);
  // A send attempt or one channel's timestamp is not delivery proof. The
  // notify writer emits fullyDeliveredAt only after its terminal channel proof.
  const at = typeof marker?.fullyDeliveredAt === 'string' && Number.isFinite(Date.parse(marker.fullyDeliveredAt))
    ? marker.fullyDeliveredAt
    : null;
  return { status: at ? 'observed' : 'not-yet-observed', at, marker_path: markerFile };
}

function qcEvidence(dataDir, date) {
  const file = path.join(dataDir, 'agent', 'briefing-cards', date, 'day-manifest.json');
  // Keep this reader aligned with the writer's actual schema. A JSON object
  // that merely happens to have a cards key is not a dated QC receipt.
  const manifest = readDayManifest({ dataDir, date });
  return {
    status: manifest?.cards && typeof manifest.cards === 'object' ? 'observed' : 'unavailable',
    manifest_path: file,
    cards: manifest?.cards ? Object.keys(manifest.cards).length : 0,
    generated_at: manifest?.generatedAt || null,
  };
}

function greenEvidence(dataDir, date, expectedCardIds = []) {
  const events = readReportEvents({ dataDir, date });
  const latest = latestReportEventsBySubject(events.rows, 'card-lifecycle');
  const rows = [...latest.values()];
  const green = rows.filter((row) => row.outcome === 'cleared');
  const first = green.map((row) => Date.parse(row.ts)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const expected = [...new Set(expectedCardIds.map(String).filter(Boolean))];
  const latestById = new Map(rows.map((row) => [row.subjectId, row]));
  const all = expected.length > 0 && expected.every((id) => {
    const row = latestById.get(id);
    return row?.outcome === 'cleared' && row.terminal;
  });
  const allAt = all ? Math.max(...rows.map((row) => Date.parse(row.ts)).filter(Number.isFinite)) : null;
  return {
    scope: expected.length ? 'day-manifest-card-set' : 'observed-card-lifecycle-subjects',
    status: expected.length > 0 && expected.every((id) => latestById.has(id)) ? 'observed' : 'unavailable',
    event_path: events.file, subjects: rows.length, expected_subjects: expected.length,
    first_green_at: Number.isFinite(first) ? new Date(first).toISOString() : null,
    all_green_at: Number.isFinite(allAt) ? new Date(allAt).toISOString() : null,
    all_green: all,
    malformed_events: events.malformed,
    missing_subject_ids: expected.filter((id) => !latestById.has(id)),
  };
}

function currentProductionNight(date, now = new Date()) {
  const day = String(date || '').slice(0, 10);
  const window = briefingRunWindow(day);
  const nextInputStartMs = briefingRunWindow(nextDateKey(day)).inputStartMs;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  // A dated run begins at the canonical previous-evening input boundary and
  // remains the only collectable night until the next night's input opens.
  // This admits an early terminal delivery before midnight and safe
  // post-delivery re-entry, while refusing arbitrary historical backfills.
  return Number.isFinite(nowMs) && nowMs >= window.inputStartMs && nowMs < nextInputStartMs;
}

function productionBriefingDate(now = new Date()) {
  const today = ctParts(now).date;
  const next = nextDateKey(today);
  return currentProductionNight(next, now) ? next : today;
}

function tokenEvidence(dataDir, date) {
  const sourcePath = path.join(dataDir, 'agent', `token-spend-pareto-overnight-${date}.json`);
  const receipt = readJson(sourcePath);
  const combined = Number(receipt?.combinedTokens);
  if (receipt?.schema !== TOKEN_SPEND_PARETO_SCHEMA || !Number.isFinite(combined) || combined < 0) {
    return { status: 'unavailable', combined_tokens: null, source_path: sourcePath };
  }
  return { status: 'observed', combined_tokens: combined, source_path: sourcePath };
}

function collectNightlyResizeMeasurement({ dataDir, date, now = new Date(), enforceCurrentDate = true, reconcileExisting = false } = {}) {
  const briefingDate = String(date || ctParts(now).date).slice(0, 10);
  const existing = reconcileExisting ? readJson(measurementPath(dataDir, briefingDate)) : null;
  if (reconcileExisting && !(existing?.schema === SCHEMA && existing.actual_production_night === true && existing.briefing_date === briefingDate && existing.night_id === previousDate(briefingDate))) {
    throw new Error('reconciliation requires an existing actual production measurement for this date');
  }
  if (enforceCurrentDate && !reconcileExisting && !currentProductionNight(briefingDate, now)) {
    throw new Error('historical backfill is refused; collect only the current production night');
  }
  // A briefing date always follows its overnight. Date arithmetic avoids a
  // fixed -05 offset, which would misclassify DST transition nights.
  const nightId = previousDate(briefingDate);
  // Reconciliation only reads later terminal receipts. It cannot add a missing
  // historical boundary or turn a newly supplied sample into a real old night.
  const before = reconcileExisting ? (existing.resize?.before ? { sample: existing.resize.before } : null) : readJson(inputPath(dataDir, nightId, 'before'));
  const after = reconcileExisting ? (existing.resize?.after ? { sample: existing.resize.after } : null) : readJson(inputPath(dataDir, nightId, 'after'));
  const tokens = tokenEvidence(dataDir, briefingDate);
  const qc = qcEvidence(dataDir, briefingDate);
  const green = greenEvidence(dataDir, briefingDate, qc.status === 'observed' ? Object.keys(readJson(qc.manifest_path)?.cards || {}) : []);
  const delivery = deliveryEvidence(dataDir, briefingDate);
  // Measurement completeness proves inputs and observed terminal artifacts.
  // A red night is still a complete, useful measurement; readiness must never
  // quietly turn red into green or discard it from the three-night sample.
  const complete = Boolean(before && after && tokens.status === 'observed' && delivery.status === 'observed' && qc.status === 'observed' && green.status === 'observed');
  const missing = [!before && 'resize.before', !after && 'resize.after', tokens.status !== 'observed' && 'token_usage', delivery.status !== 'observed' && 'delivery', qc.status !== 'observed' && 'qc', green.status !== 'observed' && 'duration'].filter(Boolean);
  const value = {
    schema: SCHEMA, actual_production_night: true, captured_at: now.toISOString(), briefing_date: briefingDate, night_id: nightId,
    resize: { before: before?.sample || null, after: after?.sample || null, observed: Boolean(before && after) },
    duration: green,
    token_usage: tokens,
    delivery, qc,
    evidence: { complete, missing_inputs: missing, incomplete_reason: complete ? null : `missing production receipts: ${missing.join(', ')}; no result inferred` },
    ...(reconcileExisting ? { captured_at: existing.captured_at, reconciled_at: now.toISOString() } : {}),
  };
  const file = measurementPath(dataDir, briefingDate);
  writeJsonAtomic(file, value);
  return { file, value };
}

function threeNightReadiness({ dataDir } = {}) {
  const dir = path.join(dataDir, 'agent', 'nightly-resize-measurements');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { names = []; }
  const rows = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).map((name) => readJson(path.join(dir, name))).filter(Boolean);
  const distinct = [...new Set(rows.filter((row) => row.actual_production_night === true && row.evidence?.complete === true).map((row) => row.night_id))].sort();
  return { schema: SCHEMA, complete_actual_nights: distinct, three_distinct_actual_nights: distinct.length, ready: distinct.length >= 3 };
}

module.exports = { SCHEMA, ctParts, inputPath, captureResizeBoundarySample, collectNightlyResizeMeasurement, threeNightReadiness, previousDate, currentProductionNight, productionBriefingDate, tokenEvidence };
