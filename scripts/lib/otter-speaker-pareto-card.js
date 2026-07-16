'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { addDaysToDayKey, CT_TIME_ZONE } = require('./ct-day.js');
const {
  callSummaryKeys,
  readCallSummaryArtifact,
} = require('./otter-exec-summary-artifacts.js');

const VOICEPRINT_DIR = path.join('life-archive', 'voiceprints');
const FAILED_SUMMARY =
  'Summary unavailable: the processed transcript did not yield a coherent exec summary.';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function cleanCell(value, fallback = '-') {
  const text = String(value || '')
    .replace(/[\r\n|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || fallback;
}

function timestampMs(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value))) {
    const number = Number(value);
    if (!Number.isFinite(number)) return NaN;
    return number < 10_000_000_000 ? number * 1000 : number;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function ctWallTimeToUtcMs(dayKey, hour = 5, minute = 30) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  if (!match) return NaN;
  const desired = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour, minute);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(desired));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const displayed = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
  );
  return desired - (displayed - desired);
}

function safeEnrichedPath(dataDir, call, artifact) {
  const candidates = [
    artifact?.result?.sourceFile,
    artifact?.source?.sourceFile,
    call?.sourceFile,
    call?.file,
  ].filter(Boolean);
  const root = path.resolve(dataDir);
  for (const candidate of candidates) {
    const raw = String(candidate);
    const direct = path.resolve(raw);
    const relative = path.relative(root, direct);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && fs.existsSync(direct)) {
      return direct;
    }
    const byName = path.join(root, 'otter', 'enriched', path.basename(raw));
    if (fs.existsSync(byName)) return byName;
  }
  return '';
}

function summaryArtifactForCall(dataDir, call) {
  for (const callId of callSummaryKeys(call)) {
    const artifact = readCallSummaryArtifact({ dataDir, callId });
    if (artifact) return artifact;
  }
  return null;
}

function sourceForCall(dataDir, call, artifact) {
  const file = safeEnrichedPath(dataDir, call, artifact);
  return file ? readJson(file) : null;
}

function callStartMs(call, source) {
  for (const value of [
    call?.start_time,
    call?.startTime,
    call?.started_at,
    call?.created_at,
    source?.start_time,
    source?.startTime,
    source?.started_at,
    source?.created_at,
  ]) {
    const valueMs = timestampMs(value);
    if (Number.isFinite(valueMs)) return valueMs;
  }
  return NaN;
}

function callDay(call, source, artifact) {
  return String(call?.date || artifact?.date || source?.date || '').slice(0, 10);
}

function bucketForCall({ call, source, artifact, recentStartMs, publishMs, priorStartMs, date }) {
  const startMs = callStartMs(call, source);
  if (Number.isFinite(startMs)) {
    if (startMs >= recentStartMs && startMs < publishMs) return 'recent';
    if (startMs >= priorStartMs && startMs < recentStartMs) return 'prior';
    return '';
  }
  const day = callDay(call, source, artifact);
  if (day === addDaysToDayKey(date, -1)) return 'recent';
  if (day === addDaysToDayKey(date, -2)) return 'prior';
  return '';
}

function formatTime(startMs) {
  if (!Number.isFinite(startMs)) return 'Time unavailable';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CT_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(startMs));
}

function formatDuration(call, source) {
  const seconds = Number(
    call?.duration_seconds ||
      call?.duration_sec ||
      source?.duration_seconds ||
      source?.duration_sec ||
      0,
  );
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Length unavailable';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function formatSpeakers(call) {
  const names = [];
  let ExampleCo = 0;
  for (const speaker of Array.isArray(call?.speakers) ? call.speakers : []) {
    const name = cleanCell(speaker?.display_name || speaker?.name || '', '');
    if (!name || /^ExampleCo(?:_|\s)/i.test(name)) {
      ExampleCo += 1;
      continue;
    }
    if (!names.includes(name)) names.push(name);
  }
  if (ExampleCo) names.push(ExampleCo === 1 ? 'PRIVATE_NAME speaker' : `${ExampleCo} ExampleCo speakers`);
  return names.length ? names.join(', ') : 'Speakers unavailable';
}

function renderCallRow({ call, source, artifact }) {
  const result = artifact?.status === 'clean' ? artifact.result || {} : {};
  const summary = artifact?.status === 'clean' && result.summary ? result.summary : FAILED_SUMMARY;
  return {
    startMs: callStartMs(call, source),
    text: [
      formatTime(callStartMs(call, source)),
      cleanCell(result.displayTitle || result.title || call?.title || source?.title || 'Untitled call'),
      formatDuration(call, source),
      formatSpeakers(call),
      cleanCell(summary),
    ].join(' | '),
  };
}

function formatWindow(startMs, endMs) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: CT_TIME_ZONE,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${formatter.format(new Date(startMs))} to ${formatter.format(new Date(endMs))} CT`;
}

function emitGroup(lines, label, rows, startMs, endMs) {
  lines.push(`  ${label} (${formatWindow(startMs, endMs)}):`);
  lines.push('    Columns: Time | Call | Length | Speakers | Executive summary');
  if (!rows.length) {
    lines.push('    - - | No calls | - | - | No calls in this group. This absence is explicit.');
    return;
  }
  rows
    .sort((a, b) => {
      if (Number.isFinite(a.startMs) && Number.isFinite(b.startMs)) return a.startMs - b.startMs;
      if (Number.isFinite(a.startMs)) return -1;
      if (Number.isFinite(b.startMs)) return 1;
      return a.text.localeCompare(b.text);
    })
    .forEach((row) => lines.push(`    - ${row.text}`));
}

function speakerMinutes(row) {
  const seconds = Number(row?.speaking_seconds || row?.duration_seconds || row?.seconds || 0);
  if (Number.isFinite(seconds) && seconds > 0) return seconds / 60;
  const words = Number(row?.words || row?.word_count || 0);
  return Number.isFinite(words) && words > 0 ? words / 150 : 0;
}

function peopleFileCount(known) {
  return known.filter(
    (row) =>
      row?.has_people_file === true ||
      row?.suggested_name_has_people_file === true ||
      row?.name_consistency?.has_people_file === true,
  ).length;
}

function ExampleCoSpeakerCount(pareto) {
  return (
    Number(pareto?.acoustic_ExampleCo_groups_in_report || 0) +
      Number(pareto?.context_or_no_audio_ExampleCo_groups_in_report || 0) ||
    Number(pareto?.ExampleCo_speaker_groups || 0) ||
    (Array.isArray(pareto?.all_unresolved_relationships)
      ? pareto.all_unresolved_relationships.length
      : 0)
  );
}

function renderLifetimeStats(lines, pareto, rosters) {
  const known = Array.isArray(pareto?.known) ? pareto.known : [];
  const top = known
    .map((row) => ({
      name: cleanCell(row?.display_name || row?.name || row?.person_id || 'Known speaker'),
      minutes: speakerMinutes(row),
      calls: Number(row?.calls || row?.call_count || row?.conversation_count || 0),
    }))
    .sort((a, b) => b.minutes - a.minutes || b.calls - a.calls || a.name.localeCompare(b.name))
    .slice(0, 5);
  lines.push('  Lifetime stats:');
  lines.push('    Top 5 speakers by lifetime minutes:');
  if (!top.length) lines.push('      - No known speakers yet.');
  for (const speaker of top) {
    lines.push(
      `      - ${speaker.name}: ${Math.round(speaker.minutes).toLocaleString()} minutes across ${speaker.calls.toLocaleString()} calls`,
    );
  }
  lines.push(`    Total calls: ${Number(rosters?.calls_seen || rosters?.calls?.length || 0).toLocaleString()}`);
  lines.push(
    `    Known speakers: ${Number(pareto?.known_speaker_groups || known.length || 0).toLocaleString()}`,
  );
  lines.push(`    Known speakers with people files: ${peopleFileCount(known).toLocaleString()}`);
  lines.push(`    PRIVATE_NAME speakers: ${ExampleCoSpeakerCount(pareto).toLocaleString()}`);
  lines.push('  Full report: /life-archive/speaker-pareto (filterable detail, all clusters).');
}

function renderOtterSpeakerParetoCard({ dataDir, date } = {}) {
  const paretoPath = path.join(dataDir, VOICEPRINT_DIR, 'speaker-pareto-latest.json');
  const rosterPath = path.join(
    dataDir,
    VOICEPRINT_DIR,
    'otter-call-speaker-rosters-latest.json',
  );
  const pareto = readJson(paretoPath);
  const rosters = readJson(rosterPath);
  if (!pareto) return { blockedReason: 'Otter speaker Pareto proof is missing or invalid.' };
  if (!rosters || !Array.isArray(rosters.calls)) {
    return { blockedReason: 'Otter speaker roster proof is missing or invalid.' };
  }
  const latestArchiveDay = String(pareto?.last_archive_day?.date || '').slice(0, 10);
  const requiredArchiveDay = addDaysToDayKey(date, -1);
  if (!latestArchiveDay || latestArchiveDay < requiredArchiveDay) {
    return {
      blockedReason: `Otter speaker roster is stale: latest processed day ${latestArchiveDay || 'ExampleCo'}; required ${requiredArchiveDay}.`,
    };
  }

  const publishMs = ctWallTimeToUtcMs(date);
  const recentStartMs = publishMs - 24 * 60 * 60 * 1000;
  const priorStartMs = publishMs - 48 * 60 * 60 * 1000;
  const groups = { recent: [], prior: [] };
  const selectedCallIds = [];
  for (const call of rosters.calls) {
    const artifact = summaryArtifactForCall(dataDir, call);
    const source = sourceForCall(dataDir, call, artifact);
    const bucket = bucketForCall({
      call,
      source,
      artifact,
      recentStartMs,
      publishMs,
      priorStartMs,
      date,
    });
    if (!bucket) continue;
    groups[bucket].push(renderCallRow({ call, source, artifact }));
    selectedCallIds.push(callSummaryKeys(call)[0] || 'ExampleCo');
  }

  const lines = [
    'OTTER SPEAKER PARETO / PEOPLE TAGGED:',
    `  As of: ${latestArchiveDay} (latest processed archive day).`,
  ];
  emitGroup(lines, 'Past 24 Hours', groups.recent, recentStartMs, publishMs);
  emitGroup(lines, 'Day Before', groups.prior, priorStartMs, recentStartMs);
  renderLifetimeStats(lines, pareto, rosters);
  return {
    markdown: lines.join('\n'),
    source: {
      pareto: path.relative(dataDir, paretoPath).replace(/\\/g, '/'),
      roster: path.relative(dataDir, rosterPath).replace(/\\/g, '/'),
      selectedCalls: selectedCallIds.length,
      selectedCallIds,
    },
  };
}

module.exports = {
  FAILED_SUMMARY,
  ctWallTimeToUtcMs,
  renderOtterSpeakerParetoCard,
};
