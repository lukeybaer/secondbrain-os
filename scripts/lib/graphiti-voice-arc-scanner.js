const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function epochAwareIso(value, fallbackFile) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = value > 100000000000 ? value : value * 1000;
    const d = new Date(n);
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const s = value.trim();
    if (/^\d{10}(?:\.\d+)?$/.test(s)) {
      const d = new Date(Number(s) * 1000);
      if (Number.isFinite(d.getTime())) return d.toISOString();
    }
    if (/^\d{13}$/.test(s)) {
      const d = new Date(Number(s));
      if (Number.isFinite(d.getTime())) return d.toISOString();
    }
    const d = new Date(s);
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  const st = fallbackFile ? safeStat(fallbackFile) : null;
  return (st ? st.mtime : new Date()).toISOString();
}

function inRange(iso, since, until) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return false;
  return ms >= Date.parse(since) && ms <= Date.parse(until);
}

function walkJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort()
    .map((name) => path.join(dir, name));
}

function stableHash(value, len = 12) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, len);
}

function speakerIdentityForLabel(transcript, label) {
  const tracks = transcript.speaker_identity_tracks || {};
  if (tracks[label]) return tracks[label];
  const normalized = label || 'ExampleCo';
  if (tracks[normalized]) return tracks[normalized];
  const assignments =
    transcript.voiceprint_speaker_identity_v2 && Array.isArray(transcript.voiceprint_speaker_identity_v2.assignments)
      ? transcript.voiceprint_speaker_identity_v2.assignments
      : transcript.voiceprint_speaker_identity && Array.isArray(transcript.voiceprint_speaker_identity.assignments)
        ? transcript.voiceprint_speaker_identity.assignments
        : [];
  return assignments.find((a) => String(a.speaker_model_label || 'ExampleCo') === String(label || 'ExampleCo')) || null;
}

function speakerKey(identity, label) {
  const person = identity && (identity.person_id || (identity.resolved_speaker_v2 && identity.resolved_speaker_v2.person_id));
  if (person) return String(person);
  const ExampleCo = identity && (identity.ExampleCo_speaker_id || identity.voice_cluster_id || identity.acoustic_ExampleCo_id);
  if (ExampleCo) return String(ExampleCo);
  return `ExampleCo_voice_track_${stableHash(label || 'ExampleCo')}`;
}

function speakerDisplay(identity, key) {
  return String(
    (identity && (identity.resolved_person || identity.display_name || (identity.resolved_speaker_v2 && identity.resolved_speaker_v2.resolved_person)))
      || key
      || 'PRIVATE_NAME voice',
  );
}

function compactText(text, max = 6500) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 40).trim()} ... [truncated for Graphiti episode]`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function groupSegmentsByVoice(transcript) {
  const groups = new Map();
  const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
  for (const seg of segments) {
    const label = String(seg.speaker_model_label || (seg.resolved_speaker && seg.resolved_speaker.otter_speaker) || 'ExampleCo');
    const identity = seg.resolved_speaker || speakerIdentityForLabel(transcript, label) || {};
    const key = speakerKey(identity, label);
    const existing = groups.get(key) || {
      key,
      display_name: speakerDisplay(identity, key),
      person_id: identity.person_id || null,
      labels: [],
      identity_tiers: [],
      confidence_values: [],
      evidence: [],
      voice_cluster_ids: [],
      ExampleCo_speaker_ids: [],
      segments: [],
      word_count: 0,
    };
    existing.labels.push(label);
    existing.identity_tiers.push(identity.identity_tier || identity.confidence_tier || identity.identity_status || null);
    if (typeof identity.confidence === 'number') existing.confidence_values.push(identity.confidence);
    existing.evidence.push(...(Array.isArray(identity.evidence) ? identity.evidence : []));
    existing.voice_cluster_ids.push(identity.voice_cluster_id || null);
    existing.ExampleCo_speaker_ids.push(identity.ExampleCo_speaker_id || null);
    existing.segments.push(seg);
    existing.word_count += Number(seg.word_count || 0);
    groups.set(key, existing);
  }
  for (const group of groups.values()) {
    group.labels = unique(group.labels);
    group.identity_tiers = unique(group.identity_tiers);
    group.evidence = unique(group.evidence);
    group.voice_cluster_ids = unique(group.voice_cluster_ids);
    group.ExampleCo_speaker_ids = unique(group.ExampleCo_speaker_ids);
    group.segment_count = group.segments.length;
    group.confidence = group.confidence_values.length
      ? Math.round((Math.max(...group.confidence_values) + Number.EPSILON) * 1000) / 1000
      : null;
    delete group.confidence_values;
  }
  return [...groups.values()];
}

function lifeRelevanceFor(group) {
  const projects = {};
  const signals = new Set();
  const interpretations = [];
  for (const seg of group.segments) {
    const lr = seg.life_relevance || {};
    if (Array.isArray(lr.signals)) {
      for (const signal of lr.signals) {
        if (signal && signal.label) signals.add(signal.label);
      }
    }
    if (Array.isArray(lr.projects)) {
      for (const project of lr.projects) {
        if (project && project.id) projects[project.id] = project.label || project.id;
      }
    }
    if (lr.interpretation) interpretations.push(lr.interpretation);
  }
  return {
    projects,
    signals: [...signals],
    interpretations: unique(interpretations).slice(0, 5),
  };
}

function transcriptDate(transcript, file) {
  return epochAwareIso(transcript.created_at || transcript.start_time || transcript.date || transcript.fetched_at, file);
}

function transcriptId(transcript, file) {
  return String(transcript.otid || transcript.otterId || transcript.id || path.basename(file, '.json'));
}

function buildVoiceArcEvent(transcript, group, file, referenceTime) {
  const otid = transcriptId(transcript, file);
  const title = transcript.title || otid;
  const speakerText = compactText(group.segments.map((seg) => seg.text).filter(Boolean).join('\n'), 7000);
  if (!speakerText || group.word_count < 3) return null;
  const conversationContext = compactText(
    (Array.isArray(transcript.segments) ? transcript.segments : [])
      .slice(0, 12)
      .map((seg) => {
        const who = seg.resolved_speaker && (seg.resolved_speaker.resolved_person || seg.resolved_speaker.person_id);
        return `${who || seg.speaker_model_label || 'ExampleCo'}: ${seg.text || ''}`;
      })
      .join('\n'),
    3500,
  );
  const relevance = lifeRelevanceFor(group);
  const sourceRawPath = transcript.source_raw_path || null;
  const body = [
    `Voice arc episode for ${group.display_name}`,
    `Person id: ${group.person_id || group.key}`,
    `Conversation: ${title}`,
    `Otter id: ${otid}`,
    `Conversation time: ${referenceTime}`,
    `Identity tier(s): ${group.identity_tiers.join(', ') || 'unresolved'}`,
    group.confidence != null ? `Identity confidence: ${group.confidence}` : '',
    group.voice_cluster_ids.length ? `Voice cluster(s): ${group.voice_cluster_ids.join(', ')}` : '',
    group.ExampleCo_speaker_ids.length ? `PRIVATE_NAME speaker id(s): ${group.ExampleCo_speaker_ids.join(', ')}` : '',
    group.evidence.length ? `Evidence: ${group.evidence.join(', ')}` : '',
    relevance.signals.length ? `Life signals: ${relevance.signals.join(', ')}` : '',
    Object.keys(relevance.projects).length ? `Projects touched: ${Object.values(relevance.projects).join(', ')}` : '',
    relevance.interpretations.length ? `Relevance interpretation: ${relevance.interpretations.join(' | ')}` : '',
    '',
    'What this person said in this conversation:',
    speakerText,
    conversationContext ? '\nConversation context with ExampleCo and other speakers:' : '',
    conversationContext,
    '',
    `Provenance: enriched=${path.relative(process.cwd(), file).replace(/\\/g, '/')}${sourceRawPath ? ` raw=${sourceRawPath}` : ''}`,
  ].filter((line) => line !== '').join('\n');

  return {
    source: 'voice-arc',
    source_id: `${otid}:${group.key}`,
    source_description: `voice-arc:${otid}:${group.key}`,
    name: `Voice arc: ${group.display_name} - ${title}`,
    body,
    reference_time: referenceTime,
    observed_at: epochAwareIso(transcript.fetched_at || transcript.updated_at || Date.now(), file),
    raw_path: sourceRawPath || file,
    contact_name: group.display_name,
    direction: 'conversation',
    priority: group.person_id && group.person_id !== 'ExampleCo' ? 'high' : 'normal',
    metadata: {
      otid,
      title,
      enriched_path: file,
      source_raw_path: sourceRawPath,
      person_id: group.person_id,
      speaker_key: group.key,
      speaker_labels: group.labels,
      identity_tiers: group.identity_tiers,
      confidence: group.confidence,
      evidence: group.evidence,
      voice_cluster_ids: group.voice_cluster_ids,
      ExampleCo_speaker_ids: group.ExampleCo_speaker_ids,
      segment_count: group.segment_count,
      word_count: group.word_count,
      projects: relevance.projects,
      signals: relevance.signals,
    },
  };
}

function voiceArcEventsFromTranscript(transcript, file = 'otter-enriched.json', opts = {}) {
  const referenceTime = transcriptDate(transcript, file);
  const since = opts.since || '1970-01-01T00:00:00.000Z';
  const until = opts.until || '9999-12-31T23:59:59.999Z';
  if (!inRange(referenceTime, since, until)) return [];
  return groupSegmentsByVoice(transcript)
    .map((group) => buildVoiceArcEvent(transcript, group, file, referenceTime))
    .filter(Boolean);
}

function voiceArcEvents(root, since, until, opts = {}) {
  const dir = path.join(root, 'data', 'otter', 'enriched');
  const out = [];
  const maxFiles = Number.isFinite(opts.maxVoiceFiles) ? opts.maxVoiceFiles : Infinity;
  let scanned = 0;
  for (const file of walkJsonFiles(dir)) {
    if (scanned >= maxFiles) break;
    scanned++;
    const transcript = readJson(file);
    if (!transcript) continue;
    out.push(...voiceArcEventsFromTranscript(transcript, file, { since, until }));
  }
  return out;
}

module.exports = {
  epochAwareIso,
  groupSegmentsByVoice,
  voiceArcEvents,
  voiceArcEventsFromTranscript,
};
