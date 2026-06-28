'use strict';

const path = require('path');
const { speechSafe } = require('./speech-safe');
const { sanitizeLiveStatusSpeech } = require('./vapi-voice-output');

const PROBE_LEVELS = {
  situation: 0,
  status: 0,
  brief: 0,
  detail: 1,
  details: 1,
  why: 2,
  evidence: 2,
  proof: 2,
  artifact: 3,
  artifacts: 3,
  file: 3,
  files: 3,
  test: 3,
  tests: 3,
  log: 3,
  logs: 3,
  raw: 4,
  exact: 4,
  excerpt: 4,
};

function compact(value, max = 1000) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function safeText(value, max = 1000) {
  return speechSafe(compact(value, max + 200))
    .replace(/[A-Z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*([^\\/:*?"<>|\r\n]+)/g, '$1')
    .replace(/\/(?:[^/\s]+\/){2,}([^/\s]+)/g, '$1')
    .replace(/\b[a-f0-9]{16,}\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeProbeLevel(value, fallback = 0) {
  if (Number.isFinite(Number(value))) return Math.max(0, Math.min(4, Number(value)));
  const text = compact(value).toLowerCase();
  if (!text) return fallback;
  for (const [term, level] of Object.entries(PROBE_LEVELS)) {
    if (text === term || text.includes(term)) return level;
  }
  if (/\bhow do you know\b|\bprove\b|\bsource\b|\bevidence\b/.test(text)) return 2;
  if (/\bwhat (?:file|test|log|changed)\b|\bartifact\b/.test(text)) return 3;
  if (/\bread\b|\bexact\b|\bquote\b|\braw\b/.test(text)) return 4;
  if (/\bdeeper\b|\bgo on\b|\bmore\b|\bdrill\b/.test(text)) return Math.min(4, fallback + 1);
  return fallback;
}

function parseMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

function agePhrase(iso, nowMs = Date.now()) {
  const ms = parseMs(iso);
  if (!ms) return '';
  const ageMin = Math.max(0, Math.round((nowMs - ms) / 60000));
  if (ageMin < 2) return 'just now';
  if (ageMin < 90) return `about ${ageMin} minutes ago`;
  const ageHrs = Math.max(1, Math.round(ageMin / 60));
  if (ageHrs < 36) return `about ${ageHrs} hours ago`;
  const ageDays = Math.max(1, Math.round(ageHrs / 24));
  return `about ${ageDays} days ago`;
}

function taskTitle(record) {
  return safeText(record && (record.title || record.prompt || record.id) || 'that item', 120)
    .replace(/^codex thread:\s*/i, '')
    .replace(/^claude(?: code)? session:\s*/i, '')
    .trim();
}

function statusText(record) {
  return safeText(String(record && record.status || record && record.execution && record.execution.status || 'ExampleCo').replace(/[_-]+/g, ' '), 80);
}

function sourceLabel(record) {
  if (record && record._kind === 'command') return 'live command';
  if (record && record._source === 'codex-thread-index') return 'Codex thread mirror';
  const source = record && record.source && typeof record.source === 'object' ? record.source : {};
  if (source.type) return safeText(source.type.replace(/[_-]+/g, ' '), 80);
  if (record && record.origin) return `${safeText(record.origin, 40)} spine item`;
  return 'spine item';
}

function timestampForRecord(record, progress, command) {
  const progressTs = progress && progress.ts;
  return (
    progressTs ||
    (command && (command.lastProgressAt || command.updatedAt || command.createdAt)) ||
    (record && (record.lastProgressAt || record.updatedAt || record.completedAt || record.createdAt || record._sourceMtime)) ||
    ''
  );
}

function latestHistory(record) {
  const history = Array.isArray(record && record.history) ? record.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const row = history[i] || {};
    const note = safeText(row.note || row.message || '', 800);
    if (note) return { ...row, note };
  }
  return null;
}

function artifactName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const cleaned = raw.replace(/^["']|["']$/g, '');
  const base = cleaned.includes('\\') ? path.win32.basename(cleaned) : path.posix.basename(cleaned);
  return safeText(base || cleaned, 120);
}

function normalizeArtifacts(values, max = 8) {
  const out = [];
  for (const value of values || []) {
    const name = artifactName(value);
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

function addPacket(packets, packet) {
  const summary = safeText(packet && packet.summary, 500);
  if (!summary) return;
  packets.push({
    kind: safeText(packet.kind || 'source', 60),
    summary,
    ts: packet.ts || '',
    source: safeText(packet.source || '', 120),
    excerpt: safeText(packet.excerpt || summary, 500),
    artifacts: normalizeArtifacts(packet.artifacts || []),
    limit: safeText(packet.limit || '', 220),
  });
}

function progressRowsForRecord(record, progressByTaskId = {}) {
  const id = record && record.id;
  if (!id) return [];
  const rows = progressByTaskId[id];
  return Array.isArray(rows) ? rows.slice().sort((a, b) => parseMs(a.ts) - parseMs(b.ts)) : [];
}

function buildSourcePackets(record, { progress = [], command = null } = {}) {
  const packets = [];
  if (command && command.progressNote) {
    addPacket(packets, {
      kind: 'command progress',
      summary: command.progressNote,
      ts: command.lastProgressAt || command.updatedAt || command.createdAt,
      source: 'live command queue',
      artifacts: command.files || [],
    });
  }

  for (const row of progress.slice(-5).reverse()) {
    const parts = [
      row.note || row.message || '',
      row.blocker ? `Blocker: ${row.blocker}` : '',
      row.nextAction ? `Next: ${row.nextAction}` : '',
    ].filter(Boolean);
    addPacket(packets, {
      kind: 'progress event',
      summary: parts.join(' '),
      ts: row.ts,
      source: 'voice-agent-progress ledger',
      artifacts: [...(row.files || []), ...(row.commands || []), ...(row.sources || [])],
    });
  }

  const hist = latestHistory(record);
  if (hist) {
    addPacket(packets, {
      kind: 'history note',
      summary: hist.note,
      ts: hist.ts || hist.updatedAt,
      source: sourceLabel(record),
    });
  }

  for (const [kind, value] of [
    ['progress note', record && (record.progressNote || record.lastProgressNote || record.latestStatus || record.detail)],
    ['result summary', record && record.resultSummary],
    ['latest user prompt', record && record.latestUserPrompt],
  ]) {
    addPacket(packets, {
      kind,
      summary: value,
      ts: record && (record.updatedAt || record.completedAt || record.createdAt),
      source: sourceLabel(record),
    });
  }

  const prompts = record && record.meta && Array.isArray(record.meta.prompts) ? record.meta.prompts : [];
  const prompt = prompts.length ? prompts[prompts.length - 1] : record && record.prompt;
  addPacket(packets, {
    kind: 'prompt',
    summary: prompt,
    ts: record && record.createdAt,
    source: sourceLabel(record),
    limit: 'Prompt proves the requested objective, not current progress by itself.',
  });

  const artifacts = normalizeArtifacts([
    ...(record && Array.isArray(record.files) ? record.files : []),
    ...(record && record.execution && record.execution.commandId ? [record.execution.commandId] : []),
  ]);
  if (artifacts.length) {
    addPacket(packets, {
      kind: 'artifact list',
      summary: `Artifacts seen: ${artifacts.join(', ')}`,
      ts: record && (record.updatedAt || record.completedAt || record.createdAt),
      source: sourceLabel(record),
      artifacts,
    });
  }

  return packets;
}

function latestProgressFromPackets(packets) {
  const packet = packets.find((p) => /command progress|progress event|progress note|history note|result summary/i.test(p.kind));
  return packet ? packet.summary : '';
}

function buildLiveStateItem(record, opts = {}) {
  const progress = opts.progress || progressRowsForRecord(record, opts.progressByTaskId || {});
  const lastProgressRow = progress[progress.length - 1] || null;
  const command = opts.command || null;
  const sourcePackets = buildSourcePackets(record, { progress, command });
  const freshnessIso = timestampForRecord(record, lastProgressRow, command);
  const objective = taskTitle(record);
  const lastProgress = safeText(
    (command && command.progressNote) ||
      (lastProgressRow && (lastProgressRow.note || lastProgressRow.message)) ||
      latestProgressFromPackets(sourcePackets),
    240,
  );

  return {
    id: record && record.id || '',
    objective,
    status: statusText(record),
    source: sourceLabel(record),
    freshnessIso,
    freshness: agePhrase(freshnessIso, opts.nowMs),
    lastProgress,
    currentBlocker: safeText((lastProgressRow && lastProgressRow.blocker) || record && record.blocker, 180),
    nextAction: safeText((lastProgressRow && lastProgressRow.nextAction) || record && record.nextAction, 180),
    confidence: sourcePackets.length ? 'source-backed' : 'title-status-only',
    sourcePackets,
    record,
  };
}

function buildLiveStateItems({ records = [], progressByTaskId = {}, commandByTaskId = {}, nowMs = Date.now() } = {}) {
  return (records || [])
    .filter((record) => record && typeof record === 'object')
    .map((record) =>
      buildLiveStateItem(record, {
        progressByTaskId,
        command: commandByTaskId[record.id] || null,
        nowMs,
      }),
    );
}

function packetAge(packet, nowMs) {
  const age = agePhrase(packet.ts, nowMs);
  return age ? ` updated ${age}` : '';
}

function formatSituation(items, opts) {
  const item = items[0];
  if (items.length > 1) {
    const parts = items.slice(0, 4).map((x) => {
      const age = x.freshness ? `, updated ${x.freshness}` : '';
      const progress = x.lastProgress ? `, latest: ${x.lastProgress}` : '';
      return sanitizeLiveStatusSpeech(`${x.objective} is ${x.status}${age}${progress}`);
    });
    const more = items.length > parts.length ? ` Plus ${items.length - parts.length} more.` : '';
    return `${parts.join('. ')}.${more}`;
  }
  const age = item.freshness ? `, updated ${item.freshness}` : '';
  const progress = item.lastProgress
    ? `Latest: ${item.lastProgress}`
    : item.confidence === 'title-status-only'
      ? 'I only have title and status so far, not progress detail'
      : 'I have source-backed context but no progress note';
  const blocker = item.currentBlocker ? `; blocker: ${item.currentBlocker}` : '';
  const next = item.nextAction ? `; next: ${item.nextAction}` : '';
  return sanitizeLiveStatusSpeech(`${item.objective} is ${item.status}${age} from ${item.source}. ${progress}${blocker}${next}.`);
}

function formatDetails(item) {
  const details = item.sourcePackets.slice(0, 3).map((p) => p.summary);
  if (!details.length) {
    return `Details: ${item.objective} has no source packet beyond title/status yet.`;
  }
  return `Details: ${details.join('; ')}.`;
}

function formatEvidence(item, nowMs) {
  const evidence = item.sourcePackets.slice(0, 4).map((p) => `${p.kind}${packetAge(p, nowMs)}${p.source ? ` from ${p.source}` : ''}`);
  if (!evidence.length) {
    return `Evidence: I only have title/status for ${item.objective}. Last proven level is title/status.`;
  }
  return `Evidence: ${evidence.join('; ')}.`;
}

function formatArtifacts(item) {
  const artifacts = [];
  for (const packet of item.sourcePackets) {
    for (const artifact of packet.artifacts || []) {
      if (artifact && !artifacts.includes(artifact)) artifacts.push(artifact);
      if (artifacts.length >= 6) break;
    }
    if (artifacts.length >= 6) break;
  }
  if (!artifacts.length) {
    return `Artifacts: I do not have file, test, command, or log artifacts for ${item.objective}. Last proven level is ${item.sourcePackets.length ? 'evidence' : 'title/status'}.`;
  }
  return `Artifacts: ${artifacts.join(', ')}.`;
}

function formatRawExcerpt(item) {
  const packet = item.sourcePackets.find((p) => p.excerpt);
  if (!packet) {
    return `I do not have a raw visible excerpt for ${item.objective}. Last proven level is title/status.`;
  }
  return `Exact visible excerpt: "${packet.excerpt.slice(0, 320)}"`;
}

function formatLiveStateAnswer(items, opts = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const query = safeText(opts.query || '', 120);
  const level = normalizeProbeLevel(opts.probeLevel ?? opts.detailLevel ?? opts.mode, 0);
  const nowMs = opts.nowMs || Date.now();
  if (!list.length) {
    return query
      ? `I found no matching live state item for ${query}. I only checked the live command queue, task spine, progress ledger, and Codex mirror, so that is scoped no-match, not whole-life proof.`
      : 'I found no active live state items in the live command queue, task spine, progress ledger, or Codex mirror.';
  }
  const item = list[0];
  if (level === 1) return formatDetails(item);
  if (level === 2) return formatEvidence(item, nowMs);
  if (level === 3) return formatArtifacts(item);
  if (level >= 4) return formatRawExcerpt(item);
  return formatSituation(list, { query });
}

module.exports = {
  buildLiveStateItem,
  buildLiveStateItems,
  formatLiveStateAnswer,
  normalizeProbeLevel,
  buildSourcePackets,
  safeText,
};
