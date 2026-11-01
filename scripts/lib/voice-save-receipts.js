// Voice review Save feedback (owner decision): "When I clicked save for the
// next overnight on the voice review page, please confirm that it actually
// saved." A Save is shown as saved only when the server returned an accepted
// receipt (job id plus accepted time); otherwise the click shows a visible
// error with retry. After a reload the same receipts are read back from the
// durable actions ledger, so the saved state never depends on the browser.
const fs = require('node:fs');

// Accepted job events (job_status accepted) keyed by request id -> accepted_at.
// The save handler writes the action row BEFORE this event, so an action row
// alone never proves the save was accepted (peer review F3).
function readAcceptedJobTimes(jobsPath) {
  const accepted = new Map();
  let text = '';
  try {
    text = fs.readFileSync(jobsPath, 'utf8');
  } catch {
    return accepted;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || row.job_status !== 'accepted' || !row.request_id) continue;
    const at = row.accepted_at || row.event_at;
    if (at && !accepted.has(row.request_id)) accepted.set(row.request_id, at);
  }
  return accepted;
}

// Server side: receipts for one briefing date. Each action row from
// voice-confirmation-actions.jsonl is joined to its accepted job event in
// voice-confirmation-jobs.jsonl by request id. saved is true only with that
// event, and acceptedAt is the acceptance time; otherwise saved is false and
// acceptedAt is empty so the page offers retry.
function readVoiceSaveReceipts(actionsPath, date, jobsPath) {
  let text = '';
  try {
    text = fs.readFileSync(actionsPath, 'utf8');
  } catch {
    return [];
  }
  const acceptedTimes = readAcceptedJobTimes(jobsPath);
  const latestByVoice = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || !row.gitPeopleSyncRequestId || !row.voiceClusterId || !row.ts) continue;
    if (date && row.date !== date) continue;
    const acceptedAt = acceptedTimes.get(row.gitPeopleSyncRequestId) || '';
    latestByVoice.set(row.voiceClusterId, {
      voiceClusterId: row.voiceClusterId,
      action: row.action || '',
      saved: Boolean(acceptedAt),
      acceptedAt,
      recordedAt: row.ts,
      jobId: row.gitPeopleSyncRequestId,
      name: row.correctedName || row.personFileName || row.guessedName || '',
    });
  }
  return [...latestByVoice.values()].sort((a, b) =>
    String(a.acceptedAt || a.recordedAt).localeCompare(String(b.acceptedAt || b.recordedAt)),
  );
}

// Client side. These are real functions so tests call them directly; the
// dashboard embeds their source (VOICE_SAVE_CLIENT). No backticks in bodies.
function voiceSaveTimeLabel(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return (
      d.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/Chicago',
      }) + ' CT'
    );
  } catch (e) {
    return '';
  }
}

// Saved only on an accepted receipt: ok, accepted, a job id and an accept time.
function voiceSaveUiModel(resp, label) {
  const what = label || 'Saved';
  const ok = resp && resp.ok === true && resp.accepted === true && resp.jobId && resp.acceptedAt;
  if (!ok) {
    const detail = (resp && resp.error) || 'the server did not return an accepted receipt';
    return {
      state: 'error',
      button: '',
      message: 'NOT SAVED: ' + detail + '. Nothing was recorded. Click Save to retry.',
    };
  }
  const t = voiceSaveTimeLabel(resp.acceptedAt);
  return {
    state: 'saved',
    button: 'Saved ✓' + (t ? ' ' + t : ''),
    message:
      what +
      " for tonight's overnight" +
      (t ? ' at ' + t : '') +
      '. Receipt ' +
      String(resp.jobId).slice(-8) +
      '.',
  };
}

function voiceSaveBannerText(receipts) {
  const list = (receipts || []).filter((r) => r && r.jobId && r.acceptedAt);
  if (!list.length) return '';
  const last = list[list.length - 1];
  const t = voiceSaveTimeLabel(last.acceptedAt);
  return (
    '✓ ' +
    list.length +
    (list.length === 1 ? ' voice decision' : ' voice decisions') +
    " saved for tonight's overnight. Latest" +
    (t ? ' at ' + t : '') +
    ', receipt ' +
    String(last.jobId).slice(-8) +
    '.'
  );
}

const VOICE_SAVE_CLIENT = [voiceSaveTimeLabel, voiceSaveUiModel, voiceSaveBannerText]
  .map((fn) => fn.toString())
  .join('\n');

module.exports = {
  readVoiceSaveReceipts,
  voiceSaveTimeLabel,
  voiceSaveUiModel,
  voiceSaveBannerText,
  VOICE_SAVE_CLIENT,
};
