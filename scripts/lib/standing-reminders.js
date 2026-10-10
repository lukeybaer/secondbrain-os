// Standing reminders: persistent manual entries that survive the nightly
// regenerate-action-items.js rebuild and surface on the briefing's OPEN
// COMMITMENTS card every day until ExampleCo marks them resolved.
//
// File format: data/standing-reminders.json
//   {
//     "reminders": [
//       {
//         "id": "stable-slug",
//         "person": "IRS",
//         "commitment": "Short imperative sentence ExampleCo will see on the card",
//         "summary": "Optional one-line context for the drilldown",
//         "addedAt": "2026-05-23T18:00:00Z",
//         "addedBy": "ExampleCo-dispatch",
//         "expiresAt": null,
//         "resolvedAt": null
//       }
//     ]
//   }
//
// Resolving a reminder: set resolvedAt to an ISO timestamp; do not delete the
// entry (kept for audit trail). loadStandingReminders filters it out.
//
// Expiring a reminder: set expiresAt; once now > expiresAt, it stops surfacing.

const fs = require('node:fs');
const path = require('node:path');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..');
const DEFAULT_PATH = path.join(REPO, 'data', 'standing-reminders.json');

function loadStandingReminders(filePath = DEFAULT_PATH, now = new Date()) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed?.reminders) ? parsed.reminders : [];
  const nowMs = now.getTime();
  return list.filter((r) => {
    if (r.resolvedAt) return false;
    if (r.expiresAt) {
      const exp = Date.parse(r.expiresAt);
      if (Number.isFinite(exp) && exp < nowMs) return false;
    }
    return true;
  });
}

function mergeStandingIntoCommitments(autoCommitments = [], standing = [], now = new Date()) {
  const nowMs = now.getTime();
  const seen = new Set();
  const out = [];
  for (const r of standing) {
    const id = r.id || `${r.person || ''}::${r.commitment || ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const addedMs = Date.parse(r.addedAt || '');
    const daysOld = Number.isFinite(addedMs)
      ? Math.max(0, Math.round((nowMs - addedMs) / 86400000))
      : 0;
    out.push({
      id: r.id,
      person: r.person,
      commitment: r.commitment,
      summary: r.summary || '',
      committedAt: r.addedAt || null,
      // 2026-05-23: standing reminders are dispatched by ExampleCo directly, they
      // do not come from an email thread that could supersede them. The
      // openCommitment supersession guard in manual-briefing-v3.js drops
      // any commitment missing lastThreadMessageAt unless stillOpen:true.
      // Tag standing reminders accordingly so the guard does not drop
      // them silently. Without this, the regression test
      // "every openCommitment has committedAt + lastThreadMessageAt"
      // fails with "IRS missing lastThreadMessageAt (use stillOpen:true
      // to override)".
      stillOpen: true,
      daysOld,
      source: 'standing-reminder',
    });
  }
  for (const c of autoCommitments) {
    const id = c.id || `${c.person || ''}::${c.commitment || ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(c);
  }
  return out;
}

module.exports = {
  DEFAULT_PATH,
  loadStandingReminders,
  mergeStandingIntoCommitments,
};
