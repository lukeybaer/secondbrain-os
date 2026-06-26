/**
 * transcript-fastpath.js, two-tier reader for query_knowledge.
 *
 * Detects whether an inbound Vapi question is asking about Otter transcripts
 * and answers it from real data before falling through to Graphiti.
 * Foundation for anti-fabrication per
 * feedback_anti_fabrication_is_foundation_not_rules.md.
 *
 * Tier 1 (list inventory): for "summarize today's Otter / how many calls /
 * what did I record" questions. Returns count, durations, start times,
 * speaker counts, IDs. No LLM. Built from otterQuery.listTranscripts.
 *
 * Tier 2 (drill into one transcript): for "details / get the / tell me
 * about / what was discussed" follow-ups. Resolves the target transcript
 * (single-transcript day = obvious; multi = fuzzy match by ID, time, or
 * topic), returns a raw chunk via otterQuery.getTranscriptSnippet. The
 * model summarizes inline from the chunk. No separate Claude call here so
 * the webhook stays under Vapi's 10s timeout.
 *
 * Pure function, no I/O beyond what otterQuery does. Tests stub otterQuery
 * for full token-frugal coverage.
 */

const TZ = 'America/Chicago';

function ymdInTZ(date, tz = TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function looksLikeTranscriptQuestion(q) {
  if (!q || typeof q !== 'string') return false;
  const lower = q.toLowerCase();
  if (/\botter\b/.test(lower)) return true;
  if (/(today|this morning|yesterday|today's).{0,30}(transcri[pb]|conversation|meeting|chat|call|recording)/.test(lower)) return true;
  if (/(transcri[pb]|conversation|meeting|chat|recording).{0,30}(today|this morning|yesterday)/.test(lower)) return true;
  if (/how many.{0,20}(conversation|transcri[pb]|meeting|recording)/.test(lower)) return true;
  if (/(summarize|summary).{0,20}(transcri[pb]|conversation|meeting|chat|recording|call.*today|today)/.test(lower)) return true;
  return false;
}

function looksLikeDrillDownQuestion(q) {
  if (!q || typeof q !== 'string') return false;
  const lower = q.toLowerCase();
  const wantsDetail = /(get the detail|get details|what was (discussed|covered|said)|what (happened|was talked|did .* (say|cover|discuss))|tell me (more|about)|dig (in|deeper)|deep dive|drill in|specifics|the details)/.test(lower);
  if (!wantsDetail) return false;
  const hasTranscriptContext = /\b(otter|transcri[pb]|conversation|meeting|chat|call|recording)\b/.test(lower);
  return hasTranscriptContext;
}

function extractIdFromQuestion(q, candidateIds) {
  if (!q || !candidateIds || !candidateIds.length) return null;
  for (const id of candidateIds) {
    const short = String(id).slice(0, 12);
    if (q.includes(id) || q.includes(short)) return id;
  }
  return null;
}

function pickByDuration(q, items) {
  const m = q.match(/(\d+)\s*(?:hour|hr)\s*(?:and\s*)?(\d+)?\s*min?/i)
    || q.match(/(\d+)\s*hour/i)
    || q.match(/(\d+)\s*(?:minute|min)/i);
  if (!m) return null;
  let targetMin = 0;
  if (m[0].includes('hour') || m[0].includes('hr')) {
    targetMin = parseInt(m[1], 10) * 60 + (parseInt(m[2] || '0', 10) || 0);
  } else {
    targetMin = parseInt(m[1], 10);
  }
  if (!targetMin) return null;
  let best = null;
  let bestDelta = Infinity;
  for (const it of items) {
    const itMin = Math.round((it.duration_sec || 0) / 60);
    const delta = Math.abs(itMin - targetMin);
    if (delta < bestDelta && delta <= Math.max(15, targetMin * 0.25)) {
      bestDelta = delta;
      best = it;
    }
  }
  return best;
}

function pickDate(q, now = new Date()) {
  const lower = (q || '').toLowerCase();
  if (/\byesterday\b/.test(lower)) {
    const d = new Date(now.getTime());
    d.setDate(d.getDate() - 1);
    return ymdInTZ(d);
  }
  return ymdInTZ(now);
}

function startTimeCT(unixSec) {
  if (!unixSec) return 'ExampleCo';
  return new Date(unixSec * 1000).toLocaleTimeString('en-US', {
    timeZone: TZ, hour: 'numeric', minute: '2-digit',
  });
}

function isLikelyHumanTitle(t) {
  if (!t) return false;
  if (/^[A-Za-z0-9_-]{8,}$/.test(t)) return false;
  if (/\s/.test(t) && t.length < 100) return true;
  return false;
}

/**
 * @param {string} question
 * @param {{ otterQuery: { listTranscripts: Function, getTranscriptSnippet?: Function }, now?: Date, snippetMaxChars?: number }} deps
 * @returns {string|null} formatted answer or null if not a transcript question
 */
function tryTranscriptFastPath(question, deps) {
  if (!deps || !deps.otterQuery || typeof deps.otterQuery.listTranscripts !== 'function') {
    return null;
  }
  const isDrillDown = looksLikeDrillDownQuestion(question);
  const isList = looksLikeTranscriptQuestion(question);
  if (!isList && !isDrillDown) return null;
  const date = pickDate(question, deps.now || new Date());
  let result;
  try {
    result = deps.otterQuery.listTranscripts({ date });
  } catch (e) {
    return null;
  }
  if (!result || result.count === 0) {
    return 'No transcripts found for ' + date + '. Either no recordings happened that day, or the Otter ingest has a gap. Do not invent content.';
  }

  if (isDrillDown && typeof deps.otterQuery.getTranscriptSnippet === 'function') {
    let target = extractIdFromQuestion(question, result.items.map((i) => i.id));
    if (!target && result.count === 1) target = result.items[0].id;
    if (!target) {
      const dur = pickByDuration(question, result.items);
      if (dur) target = dur.id;
    }
    if (target) {
      try {
        const snip = deps.otterQuery.getTranscriptSnippet({
          id: target,
          max_chars: deps.snippetMaxChars || 4000,
        });
        const item = result.items.find((i) => i.id === target);
        if (snip && snip.snippet) {
          const min = Math.round(((item && item.duration_sec) || 0) / 60);
          const start = startTimeCT(item && item.started_at);
          return 'Transcript chunk for ' + start + ' CT, ' + min + ' min meeting (id=' + target.slice(0, 12) + '). Total ' + snip.total_chars + ' chars, returning first ' + snip.snippet.length + '. Summarize from this text only, do not invent details:\n\n' + snip.snippet;
        }
      } catch {}
    }
  }

  const totalMin = Math.round(result.items.reduce((s, i) => s + (i.duration_sec || 0), 0) / 60);
  const lines = [
    result.count + ' transcripts on ' + date + ' (CT), total ' + totalMin + ' minutes:',
  ];
  for (const item of result.items) {
    const min = Math.round((item.duration_sec || 0) / 60);
    const start = startTimeCT(item.started_at);
    const speakers = Array.isArray(item.speakers) ? item.speakers.filter(Boolean) : [];
    const speakerStr = speakers.length
      ? ' speakers=' + speakers.length + (speakers.length <= 4 ? ' (' + speakers.join(', ') + ')' : '')
      : ' speakers=ExampleCo';
    const titleStr = isLikelyHumanTitle(item.title) ? ' title="' + item.title + '"' : '';
    const idShort = (item.id || '').slice(0, 12);
    lines.push('- ' + start + ' CT, ' + min + ' min' + speakerStr + titleStr + ' (id=' + idShort + ')');
  }
  lines.push('');
  lines.push('Use these IDs and start times to answer specifically. If asked about a meeting not on this list, say you do not have that transcript.');
  return lines.join('\n');
}

module.exports = {
  tryTranscriptFastPath,
  looksLikeTranscriptQuestion,
  looksLikeDrillDownQuestion,
  pickDate,
  extractIdFromQuestion,
  pickByDuration,
};
