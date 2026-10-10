'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { addDaysToDayKey, CT_TIME_ZONE } = require('./ct-day.js');
const { computeSpeakerFreshness } = require('./speaker-freshness.js');
const {
  callSummaryKeys,
  isEmptyNoiseCall,
  readCallSummaryArtifact,
} = require('./otter-exec-summary-artifacts.js');
const {
  evaluateProjectionProvenance,
  hypothesisCoverageGate,
  projectCallsWithHypotheses,
  projectionWindowStats,
  readOtterHypothesisProjectionHealth,
  sha256Bytes,
} = require('./otter-speaker-hypothesis-projection.js');
const {
  applyJevCallReviews,
  jevReviewStatsForCalls,
  loadJevCallReviewIndex,
} = require('./otter-jev-name-review.js');

const VOICEPRINT_DIR = path.join('life-archive', 'voiceprints');
const FAILED_SUMMARY =
  'Summary unavailable: the processed transcript did not yield a coherent exec summary.';

function voiceIdentityInventoryLine(queue) {
  if (!queue || typeof queue !== 'object') return '';
  const knownSpeakers = Number(queue.total_confirmed_canonical_speaker_ids || 0);
  const proposedNameVoices = Number(queue.total_reviewable_voice_hypotheses || 0);
  if (!knownSpeakers && !proposedNameVoices) return '';
  return `Full identity inventory: ${knownSpeakers} confirmed canonical speaker identities; ${proposedNameVoices} playable unresolved voices carry proposed names across the backlog. A zero in the past-24-hour projection below applies only to exact speaker rows in that window, not to Otter's known speakers or name hypotheses.`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function readJsonWithRawSha(file) {
  try {
    const bytes = fs.readFileSync(file);
    return {
      value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')),
      sha256: sha256Bytes(bytes),
    };
  } catch {
    return { value: null, sha256: null };
  }
}

function cleanCell(value, fallback = '-') {
  const text = String(value || '')
    .replace(/[\r\n|]+/g, ' ')
    .replace(/(\d+)\.\s+(\d)/g, '$1.$2')
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
  const text = String(value).trim();
  if (!/(?:T|\s)\d{1,2}:\d{2}/.test(text)) return NaN;
  const parsed = Date.parse(text);
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
    if (
      relative &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      fs.existsSync(direct)
    ) {
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

function rosterCallDate(call) {
  return String(call?.date || '').slice(0, 10);
}

function rosterCompletenessIsProven(dataDir, rosters) {
  const completeness = readJson(
    path.join(dataDir, VOICEPRINT_DIR, 'otter-call-completeness-latest.json'),
  );
  const summary = completeness && completeness.summary;
  const expected = Number(summary && (summary.real_otter_calls || summary.unique_records_total || 0));
  // Use the maximum across the (possibly stale) completeness-report figure and the
  // live roster's own calls_seen count.  When the completeness report was generated
  // before the most recent ingest cycle, call_roster_available can lag behind the
  // live roster by one or more calls; taking the max lets the live roster prove
  // completeness on its own when it has caught up to or exceeded the expected count.
  const summaryRostered = Number((summary && summary.call_roster_available) || 0);
  const liveRostered = Number(rosters?.calls_seen || rosters?.calls?.length || 0);
  const rostered = Math.max(summaryRostered, liveRostered);
  return expected > 0 && rostered >= expected;
}

function requiredArchiveDayForCard({ date, rosters, dataDir }) {
  const calendarRequired = addDaysToDayKey(date, -1);
  const completenessProven = rosterCompletenessIsProven(dataDir, rosters);
  if (!completenessProven) {
    return { day: calendarRequired, completenessProven };
  }
  const latestRosterCallDay = (Array.isArray(rosters?.calls) ? rosters.calls : [])
    .map(rosterCallDate)
    .filter((day) => day && day <= calendarRequired)
    .sort()
    .pop();
  return { day: latestRosterCallDay || calendarRequired, completenessProven };
}

function bucketForCall({ call, source, artifact, recentStartMs, publishMs, priorStartMs, date }) {
  const startMs = callStartMs(call, source);
  if (Number.isFinite(startMs)) {
    if (startMs >= recentStartMs && startMs < publishMs) return 'recent';
    if (startMs >= priorStartMs && startMs < recentStartMs) return 'prior';
    return '';
  }
  // A calendar day cannot prove membership in a rolling 24-hour interval.
  // Keep date-only records out of exact denominators and surface the exclusion.
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

function possibleSpeakerCluesFromTitle(title) {
  const clean = String(title || '').replace(/\s+/g, ' ').trim();
  const clues = [];
  if (/^ExampleCo\s+/i.test(clean)) clues.push('ExampleCo');
  return clues;
}

function speakerHypothesis(speaker) {
  return cleanCell(
    speaker?.name_hypothesis ||
      speaker?.hypothesis ||
      speaker?.suggested_name ||
      speaker?.possible_name ||
      '',
    '',
  );
}

function speakerIdentityClass(speaker) {
  const tier = String(speaker?.identity_tier || '').toLowerCase();
  if (
    speaker?.person_id &&
    /confirmed|voiceprint|ExampleCo_cluster|reference_voiceprint/.test(tier || 'confirmed')
  ) {
    return 'confirmed';
  }
  if (speakerHypothesis(speaker) || /hypothes|context.*name|name.*clue/.test(tier)) {
    return 'hypothesized';
  }
  if (/durable_(?:unknown|call_track_unknown)|unknown_voice/.test(tier)) return 'unknown';
  return speaker?.person_id ? 'confirmed' : 'unknown';
}

function speakerCoverageForCalls(calls) {
  const totals = { allWords: 0, confirmedWords: 0, hypothesizedWords: 0, unknownWords: 0 };
  const confirmedPeople = new Set();
  const hypothesizedNames = new Set();
  const durableUnknownClusters = new Set();
  for (const call of Array.isArray(calls) ? calls : []) {
    for (const speaker of Array.isArray(call?.speakers) ? call.speakers : []) {
      const words = Math.max(0, Number(speaker?.word_count || 0));
      totals.allWords += words;
      const identityClass = speakerIdentityClass(speaker);
      if (identityClass === 'confirmed') {
        totals.confirmedWords += words;
        confirmedPeople.add(
          String(speaker.person_id || speaker.display_name || speaker.name || '').toLowerCase(),
        );
      } else if (identityClass === 'hypothesized') {
        totals.hypothesizedWords += words;
        hypothesizedNames.add(speakerHypothesis(speaker).toLowerCase());
      } else {
        totals.unknownWords += words;
        const tinyTranscriptFragment =
          speaker?.small_or_late_joiner === true && words > 0 && words <= 12;
        if (!tinyTranscriptFragment) {
          durableUnknownClusters.add(
            String(
              speaker.acoustic_unknown_ids?.[0] ||
                speaker.unknown_speaker_ids?.[0] ||
                speaker.voice_cluster_ids?.[0] ||
                speaker.speaker_id ||
                '',
            ).toLowerCase(),
          );
        }
      }
    }
  }
  confirmedPeople.delete('');
  hypothesizedNames.delete('');
  durableUnknownClusters.delete('');
  const pct = (words) => (totals.allWords > 0 ? (words / totals.allWords) * 100 : 0);
  return {
    ...totals,
    mappedWords: totals.confirmedWords + totals.hypothesizedWords,
    confirmedPercent: pct(totals.confirmedWords),
    hypothesizedPercent: pct(totals.hypothesizedWords),
    mappedPercent: pct(totals.confirmedWords + totals.hypothesizedWords),
    confirmedPeople: confirmedPeople.size,
    hypothesizedNames: hypothesizedNames.size,
    durableUnknownClusters: durableUnknownClusters.size,
  };
}

// ExampleCo 2026-08-16: "When you had unknown voices in a call, you should have the
// samples for each unknown speaker there, so I can play them there. And then you
// say how many calls they've been in ... You don't need the number of words."
//
// The Pareto artifact already carries the representative clip and the lifetime
// call count per durable unknown voice. Index it once per card build, then join
// it to each call's unknown speaker rows by durable id.
function buildUnknownVoiceIndex(pareto) {
  const index = new Map();
  const rows = [
    ...(Array.isArray(pareto?.priority_unknown_relationships)
      ? pareto.priority_unknown_relationships
      : []),
    ...(Array.isArray(pareto?.recurring_unnamed_relationships)
      ? pareto.recurring_unnamed_relationships
      : []),
    ...(Array.isArray(pareto?.all_unresolved_relationships)
      ? pareto.all_unresolved_relationships
      : []),
  ];
  for (const row of rows) {
    const ids = [
      row?.label,
      row?.unknown_speaker_id,
      ...(Array.isArray(row?.voice_cluster_ids) ? row.voice_cluster_ids : []),
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    const entry = {
      calls: unknownRowCallCount(row),
      probeAudioPath: unknownRowProbePath(row),
    };
    for (const id of ids) {
      const existing = index.get(id);
      // Prefer the row that can actually be played, then the richer call count.
      if (
        !existing ||
        (!existing.probeAudioPath && entry.probeAudioPath) ||
        (Boolean(existing.probeAudioPath) === Boolean(entry.probeAudioPath) &&
          entry.calls > existing.calls)
      ) {
        index.set(id, entry);
      }
    }
  }
  return index;
}

function callUnknownVoiceSamples(call, unknownVoiceIndex) {
  if (!(unknownVoiceIndex instanceof Map) || unknownVoiceIndex.size === 0) return [];
  const seen = new Set();
  const samples = [];
  for (const speaker of Array.isArray(call?.speakers) ? call.speakers : []) {
    if (speaker?.person_id) continue;
    const ids = [
      ...(Array.isArray(speaker?.acoustic_unknown_ids) ? speaker.acoustic_unknown_ids : []),
      ...(Array.isArray(speaker?.unknown_speaker_ids) ? speaker.unknown_speaker_ids : []),
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    const matchedId = ids.find((id) => unknownVoiceIndex.has(id));
    if (!matchedId || seen.has(matchedId)) continue;
    seen.add(matchedId);
    const entry = unknownVoiceIndex.get(matchedId);
    samples.push({
      voiceClusterId: matchedId,
      calls: Number(entry.calls || 0),
      probeAudioPath: entry.probeAudioPath || '',
    });
  }
  return samples;
}

function formatSpeakers(call, options = {}) {
  const legacyProjectionUnavailable =
    options?.hypothesisProjection?.status === 'unavailable' ||
    options?.hypothesisProjection?.coverageStatus === 'unavailable';
  const jevChecked =
    call?.jevNameReview?.coverageStatus === 'available' &&
    Number(call?.jevNameReview?.eligibleSpeakerRows || 0) > 0;
  const matched = [];
  const possible = [];
  let unidentified = 0;
  let tinyFragments = 0;
  for (const speaker of Array.isArray(call?.speakers) ? call.speakers : []) {
    const name = cleanCell(speaker?.display_name || speaker?.name || '', '');
    if (speaker?.person_id && name && !matched.includes(name)) {
      matched.push(name);
    } else {
      const words = Number(speaker?.word_count || 0);
      const tinyTranscriptFragment =
        speaker?.small_or_late_joiner === true &&
        Number.isFinite(words) &&
        words > 0 &&
        words <= 12;
      if (tinyTranscriptFragment) {
        tinyFragments += 1;
        continue;
      }
      const hypothesis = legacyProjectionUnavailable && speaker?.jev_name_reviewed !== true
        ? ''
        : cleanCell(
            speaker?.name_hypothesis ||
              speaker?.hypothesis ||
              speaker?.suggested_name ||
              speaker?.possible_name ||
              '',
            '',
          );
      if (hypothesis) {
        if (!possible.includes(hypothesis)) possible.push(hypothesis);
      } else {
        unidentified += 1;
      }
    }
  }
  for (const clue of possibleSpeakerCluesFromTitle(options?.title || call?.displayTitle || call?.title)) {
    if (clue && !possible.includes(clue)) possible.push(clue);
  }
  const possibleNames = possible.filter(
    (name) => !matched.some((matchedName) => matchedName.toLowerCase() === name.toLowerCase()),
  );
  const projectionUnavailable =
    legacyProjectionUnavailable && unidentified > 0 && !jevChecked;
  const evidence = [
    `Voice-matched: ${matched.length ? matched.join(', ') : 'none'}`,
    jevChecked
      ? `Jev name suggestions (checked at >=0.70): ${possibleNames.length ? possibleNames.join(', ') : 'none'}`
      : `Possible from name clues: ${
          possibleNames.length
            ? possibleNames.join(', ')
            : projectionUnavailable
              ? 'not fully checked'
              : options?.hypothesisProjection?.resolverAdvisory && unidentified > 0
                ? 'name check in process'
                : 'none'
        }`,
    `Unidentified voices: ${unidentified}`,
  ];
  const coverage = speakerCoverageForCalls([call]);
  evidence.push(
    projectionUnavailable
      ? `Mapped words: unavailable of ${coverage.allWords.toLocaleString()} (${coverage.confirmedPercent.toFixed(1)}% confirmed; hypothesized-name coverage unavailable; ${(coverage.allWords - coverage.confirmedWords).toLocaleString()} words not confirmed)`
      : `Mapped words: ${coverage.mappedPercent.toFixed(1)}% of ${coverage.allWords.toLocaleString()} (${coverage.confirmedPercent.toFixed(1)}% confirmed, ${coverage.hypothesizedPercent.toFixed(1)}% hypothesized; ${coverage.unknownWords.toLocaleString()} unknown words)`,
  );
  if (tinyFragments) evidence.push(`Tiny transcript fragments excluded: ${tinyFragments}`);
  // The unknown voices that were IN THIS CALL, each with its playable sample and
  // how many calls that voice has appeared in. A voice with no mirrored clip
  // says so instead of publishing a marker the player cannot resolve.
  const unknownSamples = callUnknownVoiceSamples(call, options?.unknownVoiceIndex);
  if (unknownSamples.length) {
    evidence.push(
      `Unknown voice samples: ${unknownSamples
        .map((sample, index) => {
          const calls = Number(sample.calls || 0);
          const callLabel = `${calls.toLocaleString()} call${calls === 1 ? '' : 's'}`;
          return sample.probeAudioPath
            ? `Unknown speaker ${index + 1} (${callLabel}) [audio: ${sample.probeAudioPath}]`
            : `Unknown speaker ${index + 1} (${callLabel}, no playable sample yet)`;
        })
        .join(', ')}`,
    );
  }
  return evidence.join('; ');
}

function renderCallRow({ call, source, artifact, hypothesisProjection, unknownVoiceIndex }) {
  const result = artifact?.status === 'clean' ? artifact.result || {} : {};
  const summary = artifact?.status === 'clean' && result.summary ? result.summary : FAILED_SUMMARY;
  const title = cleanCell(
    result.displayTitle || result.title || call?.title || source?.title || 'Untitled call',
  );
  return {
    startMs: callStartMs(call, source),
    text: [
      formatTime(callStartMs(call, source)),
      title,
      formatDuration(call, source),
      formatSpeakers(call, { title, hypothesisProjection, unknownVoiceIndex }),
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
  lines.push('    Columns: Time | Call | Length | Speaker evidence | Executive summary');
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

function cleanSampleTitle(value) {
  return cleanCell(value, '')
    .replace(/\b(?:powershell|pwsh)(?:\.exe)?\b/gi, 'operational note')
    .replace(
      /\boperational note(?:\s+(?:popup|audit|launcher|process|window|task|command|script|ran|run))*\b/gi,
      'operational note',
    )
    .trim();
}

function unknownSpeakerCount(pareto) {
  return (
    Number(pareto?.acoustic_unknown_groups_in_report || 0) +
      Number(pareto?.context_or_no_audio_unknown_groups_in_report || 0) ||
    Number(pareto?.unknown_speaker_groups || 0) ||
    (Array.isArray(pareto?.all_unresolved_relationships)
      ? pareto.all_unresolved_relationships.length
      : 0)
  );
}

function repoRelativeOtterAudioPath(value) {
  const normalized = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!normalized) return '';
  if (normalized.startsWith('data/otter/audio/')) return normalized;
  const marker = '/secondbrain/data/otter/audio/';
  const idx = normalized.toLowerCase().lastIndexOf(marker);
  if (idx >= 0) return `data/otter/audio/${normalized.slice(idx + marker.length)}`;
  return '';
}

function unknownRowCallCount(row) {
  const explicit = Number(row?.calls || row?.call_count || row?.conversation_count || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (Array.isArray(row?.call_ids)) return row.call_ids.length;
  if (Array.isArray(row?.top_titles)) return row.top_titles.length;
  return 0;
}

function unknownRowProbePath(row) {
  return repoRelativeOtterAudioPath(
    row?.probe_audio_path ||
      row?.representative_probe_audio_path ||
      row?.source_probe_audio_path ||
      row?.review_clip_path ||
      row?.audio_path ||
      row?.relationship_dossier?.probe_audio_path ||
      row?.relationship_dossier?.representative_probe_audio_path ||
      row?.relationship_dossier?.source_probe_audio_path ||
      row?.relationship_dossier?.review_clip_path ||
      row?.relationship_dossier?.audio_path,
  );
}

function unknownSpeakerSamples(pareto, limit = 5) {
  const rows = [
    ...(Array.isArray(pareto?.priority_unknown_relationships)
      ? pareto.priority_unknown_relationships
      : []),
    ...(Array.isArray(pareto?.recurring_unnamed_relationships)
      ? pareto.recurring_unnamed_relationships
      : []),
    ...(Array.isArray(pareto?.all_unresolved_relationships)
      ? pareto.all_unresolved_relationships
      : []),
  ];
  const seen = new Set();
  return rows
    .slice()
    .sort(
      (a, b) =>
        unknownRowCallCount(b) - unknownRowCallCount(a) ||
        Number(b?.words || b?.word_count || 0) - Number(a?.words || a?.word_count || 0),
    )
    .flatMap((row) => {
      const audio = unknownRowProbePath(row);
      if (!audio) return [];
      const key = String(row?.speaker_key || row?.label || row?.unknown_speaker_id || audio);
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          calls: unknownRowCallCount(row),
          sampleTitle: cleanSampleTitle(
            row?.sample_title || (Array.isArray(row?.top_titles) ? row.top_titles[0] : ''),
          ),
          probeAudioPath: audio,
        },
      ];
    })
    .slice(0, limit);
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
  lines.push(
    `    Total calls: ${Number(rosters?.calls_seen || rosters?.calls?.length || 0).toLocaleString()}`,
  );
  lines.push(
    `    Known speakers: ${Number(pareto?.known_speaker_groups || known.length || 0).toLocaleString()}`,
  );
  lines.push(`    Known speakers with people files: ${peopleFileCount(known).toLocaleString()}`);
  lines.push(`    Unknown speakers: ${unknownSpeakerCount(pareto).toLocaleString()}`);
  const samples = unknownSpeakerSamples(pareto);
  if (samples.length) {
    lines.push('    Unknown speaker samples:');
    samples.forEach((sample, index) => {
      const calls = Number(sample.calls || 0).toLocaleString();
      const title = sample.sampleTitle ? `; sample from ${sample.sampleTitle}` : '';
      // No word count (ExampleCo 2026-08-16: "You don't need the number of words
      // actually."). The per-call lane above is now the primary surface.
      lines.push(
        `      - Unknown speaker ${index + 1}: current-generation lower bound ${calls} call${Number(sample.calls || 0) === 1 ? '' : 's'}${title} [audio: ${sample.probeAudioPath}]`,
      );
    });
  }
  lines.push('  Full report: /life-archive/speaker-pareto (filterable detail, all clusters).');
}

function renderBlockedWithStats({ reason, pareto, rosters }) {
  const lines = ['OTTER SPEAKER PARETO / PEOPLE TAGGED:', `  Blocked: ${reason}`];
  renderLifetimeStats(lines, pareto, rosters || {});
  return { blockedReason: reason, markdown: lines.join('\n') };
}

function renderOtterSpeakerParetoCard({ dataDir, date } = {}) {
  const paretoPath = path.join(dataDir, VOICEPRINT_DIR, 'speaker-pareto-latest.json');
  const rosterPath = path.join(dataDir, VOICEPRINT_DIR, 'otter-call-speaker-rosters-latest.json');
  const pareto = readJson(paretoPath);
  const rosterSource = readJsonWithRawSha(rosterPath);
  const rosters = rosterSource.value;
  if (!pareto) return { blockedReason: 'Otter speaker Pareto proof is missing or invalid.' };
  if (!rosters || !Array.isArray(rosters.calls)) {
    return { blockedReason: 'Otter speaker roster proof is missing or invalid.' };
  }
  const hypothesisProjection = evaluateProjectionProvenance({
    rosterSha256: rosterSource.sha256,
    pareto,
  });
  const hypothesisHealth = readOtterHypothesisProjectionHealth({ dataDir });
  const hypothesisCoverage = hypothesisCoverageGate({
    provenance: hypothesisProjection,
    health: hypothesisHealth,
  });
  const legacyProjected =
    hypothesisProjection.status === 'available'
      ? projectCallsWithHypotheses(rosters.calls, pareto)
      : { calls: rosters.calls, stats: null, index: null };
  const jevReviewIndex = loadJevCallReviewIndex({ dataDir });
  const jevReviewed = applyJevCallReviews(legacyProjected.calls, jevReviewIndex);
  const projected = { ...legacyProjected, calls: jevReviewed.calls };
  const callsForCard = jevReviewed.calls;
  const latestArchiveDay = String(pareto?.last_archive_day?.date || '').slice(0, 10);
  const required = requiredArchiveDayForCard({ date, rosters, dataDir });
  const requiredArchiveDay = required.day;
  const freshness = computeSpeakerFreshness({
    pareto,
    today: date,
    requiredArchiveDay,
  });
  const unprovenCalendarLag =
    !required.completenessProven && latestArchiveDay && latestArchiveDay < requiredArchiveDay;
  if (!latestArchiveDay || unprovenCalendarLag || freshness.status === 'blocker') {
    return renderBlockedWithStats({
      reason:
        freshness.reason === 'empty_or_missing'
          ? 'Otter speaker roster is empty or missing.'
          : `Otter speaker roster is stale: latest processed day ${latestArchiveDay || 'unknown'}; required ${requiredArchiveDay}.`,
      pareto,
      rosters,
    });
  }

  // One index for the whole card build: durable unknown voice id -> its
  // representative clip and lifetime call count (ExampleCo 2026-08-16).
  const unknownVoiceIndex = buildUnknownVoiceIndex(pareto);
  const publishMs = ctWallTimeToUtcMs(date);
  const recentStartMs = publishMs - 24 * 60 * 60 * 1000;
  const priorStartMs = publishMs - 48 * 60 * 60 * 1000;
  const groups = { recent: [], prior: [] };
  const groupedCalls = { recent: [], prior: [] };
  let timestampExcluded = 0;
  const selectedCallIds = [];
  for (const call of callsForCard) {
    const artifact = summaryArtifactForCall(dataDir, call);
    const source = sourceForCall(dataDir, call, artifact);
    if (isEmptyNoiseCall(call, source || {})) continue;
    const bucket = bucketForCall({
      call,
      source,
      artifact,
      recentStartMs,
      publishMs,
      priorStartMs,
      date,
    });
    if (!bucket) {
      const day = callDay(call, source, artifact);
      if (
        !Number.isFinite(callStartMs(call, source)) &&
        [date, addDaysToDayKey(date, -1), addDaysToDayKey(date, -2)].includes(day)
      ) {
        timestampExcluded += 1;
      }
      continue;
    }
    groups[bucket].push(
      renderCallRow({
        call,
        source,
        artifact,
        hypothesisProjection: hypothesisCoverage,
        unknownVoiceIndex,
      }),
    );
    groupedCalls[bucket].push(call);
    selectedCallIds.push(callSummaryKeys(call)[0] || 'unknown');
  }

  const lines = [
    'OTTER SPEAKER PARETO / PEOPLE TAGGED:',
    `  As of: ${latestArchiveDay} (latest processed archive day).`,
  ];
  if (freshness.freshnessLine) lines.push(`  Freshness: ${freshness.freshnessLine}`);
  const identityInventory = readJson(
    path.join(dataDir, 'life-archive', 'people', 'briefing-voice-queue-latest.json'),
  );
  const inventoryLine = voiceIdentityInventoryLine(identityInventory);
  if (inventoryLine) lines.push(`  ${inventoryLine}`);
  const recentCoverage = speakerCoverageForCalls(groupedCalls.recent);
  const recentJevStats = jevReviewStatsForCalls(groupedCalls.recent);
  const recentCoverageAvailable =
    hypothesisCoverage.status === 'available' || recentJevStats.coverageStatus === 'available';
  const recentProjectionStats =
    hypothesisProjection.status === 'available'
      ? projectionWindowStats(groupedCalls.recent, projected.index)
      : null;
  if (!recentCoverageAvailable) {
    lines.push(
      `  Past 24h words mapped: unavailable of ${recentCoverage.allWords.toLocaleString()} total (${recentCoverage.confirmedPercent.toFixed(1)}% confirmed voice matches; Hypothesized-name coverage unavailable: ${hypothesisCoverage.reason}; ${(recentCoverage.allWords - recentCoverage.confirmedWords).toLocaleString()} words not confirmed).`,
    );
    lines.push(
      `  Past 24h identity counts: ${recentCoverage.confirmedPeople} confirmed voice-matched people; hypothesized-name count unavailable; ${recentCoverage.durableUnknownClusters} durable unknown voice clusters before provisional projection.`,
    );
    lines.push(`  Past 24h hypothesis status: unavailable - ${hypothesisCoverage.reason}`);
  } else {
    lines.push(
      `  Past 24h words mapped: ${recentCoverage.mappedPercent.toFixed(1)}% of ${recentCoverage.allWords.toLocaleString()} total (${recentCoverage.confirmedPercent.toFixed(1)}% confirmed voice matches; ${recentCoverage.hypothesizedPercent.toFixed(1)}% hypothesized names; ${recentCoverage.unknownWords.toLocaleString()} unknown words).`,
    );
    lines.push(
      `  Past 24h identity counts: ${recentCoverage.confirmedPeople} confirmed voice-matched people; ${recentCoverage.hypothesizedNames} hypothesized names; ${recentCoverage.durableUnknownClusters} durable unknown voice clusters.`,
    );
    if (hypothesisCoverage.status === 'available') {
      const eligibleRows = Number(recentProjectionStats?.eligibleSpeakerRows || 0);
      const projectedRows = Number(recentProjectionStats?.projectedSpeakerRows || 0);
      const ambiguousRows = Number(recentProjectionStats?.ambiguousSpeakerRows || 0);
      lines.push(
        eligibleRows === 0 && Number(recentCoverage.durableUnknownClusters || 0) === 0
          ? '  Past 24h hypothesis status: no substantive unresolved speaker rows required Jev review.'
          : `  Past 24h hypothesis status: ${eligibleRows} eligible exact speaker row${eligibleRows === 1 ? '' : 's'} in this window; ${projectedRows} projected; ${ambiguousRows} ambiguous. ${hypothesisCoverage.resolverAdvisory ? 'Name checks still in process; name-resolver health is tracked on System Health, not this card' : 'Resolver completed cleanly'}; ${Number(projected.stats?.projectedNames || 0)} distinct provisional name${Number(projected.stats?.projectedNames || 0) === 1 ? '' : 's'} reached ${Number(projected.stats?.projectedSpeakerRows || 0)} exact roster speaker row${Number(projected.stats?.projectedSpeakerRows || 0) === 1 ? '' : 's'} overall.`,
      );
    } else {
      lines.push(
        recentJevStats.eligibleSpeakerRows > 0
          ? `  Past 24h hypothesis status: Jev check complete for ${recentJevStats.reviewedSpeakerRows}/${recentJevStats.eligibleSpeakerRows} substantive unresolved speaker row${recentJevStats.eligibleSpeakerRows === 1 ? '' : 's'}; ${recentJevStats.acceptedSpeakerRows} accepted suggestion${recentJevStats.acceptedSpeakerRows === 1 ? '' : 's'} and ${recentJevStats.abstainedSpeakerRows} abstention${recentJevStats.abstainedSpeakerRows === 1 ? '' : 's'}.`
          : '  Past 24h hypothesis status: no substantive unresolved speaker rows required Jev review.',
      );
    }
  }
  if (timestampExcluded > 0) {
    lines.push(
      `  Rolling-window timestamp status: unavailable - ${timestampExcluded} date-only call${timestampExcluded === 1 ? '' : 's'} excluded from exact Past 24h and Previous 24h metrics.`,
    );
  }
  emitGroup(lines, 'Past 24 Hours', groups.recent, recentStartMs, publishMs);
  emitGroup(lines, 'Previous 24 Hours', groups.prior, priorStartMs, recentStartMs);
  renderLifetimeStats(lines, pareto, rosters);
  return {
    markdown: lines.join('\n'),
    source: {
      pareto: path.relative(dataDir, paretoPath).replace(/\\/g, '/'),
      roster: path.relative(dataDir, rosterPath).replace(/\\/g, '/'),
      selectedCalls: selectedCallIds.length,
      selectedCallIds,
      hypothesisProjection: {
        ...hypothesisProjection,
        stats: projected.stats,
        coverageStatus: recentCoverageAvailable ? 'available' : 'unavailable',
        coverageReason: recentCoverageAvailable ? '' : hypothesisCoverage.reason,
        recentWindowStats: recentProjectionStats,
        jevReview: recentJevStats,
        resolver: hypothesisHealth?.resolver || null,
      },
    },
  };
}

module.exports = {
  voiceIdentityInventoryLine,
  FAILED_SUMMARY,
  buildUnknownVoiceIndex,
  callUnknownVoiceSamples,
  ctWallTimeToUtcMs,
  formatSpeakers,
  speakerCoverageForCalls,
  requiredArchiveDayForCard,
  renderOtterSpeakerParetoCard,
};
