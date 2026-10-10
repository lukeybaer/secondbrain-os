'use strict';
const fs = require('node:fs');
const readline = require('node:readline');
const { usageFromCodexTokenBlock } = require('./token-spend-pareto');

// Never serialize raw payloads: evidence is an allowlist of public fields.
function safe(value, limit = 1200) {
  if (/gAAAA[A-Za-z0-9_=-]{30,}/.test(String(value || ''))) return '[Payload omitted: encrypted coordination body]';
  if (/data:image\/|"(?:type|mimeType|mime_type)"\s*:\s*"(?:image|image\/[^" ]+)"|"encoding"\s*:\s*"base64"/i.test(String(value || ''))) return '[Payload omitted: image or base64 data]';
  if (/encrypted_content|reasoning_content|"type"\s*:\s*"reasoning"/i.test(String(value || ''))) return '[Payload omitted: private model fields]';
  return String(value || '').replace(/(?:encrypted_content|reasoning_content)\s*[:=]\s*[^\n]+/gi, '[omitted]')
    .replace(/([?&](?:k|token|key|secret|signature|api_key)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/((?:Bearer|api[_-]?key|password|secret)\s*[:=]?\s*["']?)[A-Za-z0-9_./+\-=]+/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, limit);
}
function review(annotation, input) {
  const valid = annotation && ['optimal', 'suboptimal', 'uncertain'].includes(annotation.judgment);
  const judgment = valid ? annotation.judgment : 'uncertain';
  const estimate = annotation?.estimatedInput;
  const supported = judgment === 'suboptimal' && Number.isFinite(estimate) && estimate >= 0 && estimate <= input && annotation.evidence && annotation.category;
  return { judgment, purpose: safe(annotation?.purpose), explanation: safe(annotation?.explanation), evidence: safe(annotation?.evidence),
    estimatedInput: supported ? estimate : null, savings: supported ? input - estimate : null,
    category: supported ? safe(annotation.category, 120) : null };
}
async function collect(manifest, annotations = {}) {
  const start = Date.parse(manifest.window?.start), end = Date.parse(manifest.window?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw Error('Explicit valid start/end required');
  if (!Array.isArray(manifest.sessions) || !manifest.sessions.length) throw Error('Exact sessions required');
  const ids = new Set(), turns = [], missing = [];
  for (const session of manifest.sessions) {
    if (!session.id || ids.has(session.id)) throw Error('Session IDs must be unique');
    ids.add(session.id);
    if (!session.file || !fs.existsSync(session.file)) { missing.push(session.id); continue; }
    let verified = false, previous = 0, index = 0, model = null, effort = null, pending = [], commentary = [];
    const seen = new Set(), selected = [], results = new Map();
    for await (const line of readline.createInterface({ input: fs.createReadStream(session.file), crlfDelay: Infinity })) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      const p = row.payload || {}, at = Date.parse(row.timestamp);
      if (row.type === 'session_meta') { if (p.id !== session.id) throw Error('Session metadata mismatch: ' + session.id); verified = true; }
      if (!Number.isFinite(at) || at >= end) continue;
      if (row.type === 'turn_context') { model = safe(p.model); effort = safe(p.effort || p.reasoning_effort); }
      if (at >= start && row.type === 'response_item') {
        if (['function_call', 'custom_tool_call'].includes(p.type)) pending.push({ name: safe(p.name, 120), callId: safe(p.call_id, 180), code: safe(p.arguments || p.input) });
        if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
          // Structured outputs may contain hidden/model payloads; retain only explicit text output.
          const output = typeof p.output === 'string' ? p.output : '';
          results.set(safe(p.call_id, 180), { chars: output.length, preview: safe(output) });
        }
        if (p.type === 'message' && p.role === 'assistant' && ['final', 'commentary'].includes(p.channel)) commentary.push(safe((p.content || []).filter(c => c.type === 'output_text' || c.type === 'text').map(c => c.text).join(' ')));
      }
      if (row.type !== 'event_msg' || p.type !== 'token_count' || !p.info) continue;
      const raw = p.info.last_token_usage || {}, total = Number(p.info.total_token_usage?.total_tokens) || 0;
      const key = total ? 'total:' + total : row.timestamp + ':' + JSON.stringify(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      const processed = total > previous && previous > 0 ? total - previous : Number(raw.total_tokens) || 0;
      previous = total || previous;
      if (processed && at >= start) {
        const usage = usageFromCodexTokenBlock(raw, processed), id = session.id + ':' + (++index);
        selected.push({ id, session: session.id, role: safe(session.role, 100), at: row.timestamp, model, effort,
          input: usage.input, cached: usage.cachedInput, output: usage.output, processed: usage.processed,
          uncached: Math.max(0, usage.input - usage.cachedInput), adjusted: processed !== Number(raw.total_tokens),
          calls: pending, commentary, review: review(annotations[id], usage.input) });
      }
      pending = []; commentary = [];
    }
    if (!verified) throw Error('Session metadata absent: ' + session.id);
    for (const turn of selected) { turn.results = turn.calls.map(c => results.get(c.callId) || null); turns.push(turn); }
  }
  turns.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const totals = { responses: turns.length, input: 0, cached: 0, output: 0, supportedEstimatedSavings: 0 }, groups = {};
  for (const row of turns) {
    for (const key of ['input', 'cached', 'output']) totals[key] += row[key];
    if (row.review.savings !== null) { totals.supportedEstimatedSavings += row.review.savings; groups[row.review.category] = (groups[row.review.category] || 0) + row.review.savings; }
  }
  return { schema: 'turn-audit.v1', campaign: safe(manifest.campaign), window: { start: manifest.window.start, end: manifest.window.end, convention: '[start,end)' },
    missing, totals, pareto: Object.entries(groups).map(([category, savings]) => ({ category, savings })).sort((a,b) => b.savings-a.savings),
    caveat: 'Raw input includes cached input and is not weekly quota consumption. Cache effects and quota weights are not measured. Savings are annotation-supported estimates, not observed reductions.', turns };
}
module.exports = { collect, safe, review };
