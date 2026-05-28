// Outbound-call redial guard. ABSOLUTE BAN edition.
//
// Rule: if any prior call record exists for the target number in
// %APPDATA%/secondbrain/data/calls/, the guard throws. There is no time-based
// cooldown that lifts the ban. There is no env-var override that bypasses it.
// The ONLY way to redial a number is for Luke to manually edit the prior call
// record's JSON and set `luke_handled_damage_control: true`, which is the
// affirmative signal that he has personally repaired the relationship.
//
// Why this exists: 2026-05-15 Pat Lobb Toyota incident. Amy's first call
// reached a human rep, the interaction failed (phone-readback doom loop), and
// a redial fired 60 seconds later with a tweaked prompt. The dealer experienced
// two awkward AI calls 60 seconds apart, which is indistinguishable from a
// scam dialer pattern. Luke's correction: "no redial at all when you fail a
// human interaction. Just leave a note for Luke to do the damage control."
//
// Full rule: secondbrain/memory/feedback_no_redial_after_failed_call.md

const fs = require('node:fs');
const path = require('node:path');

function callsDir() {
  return path.join(process.env.APPDATA || '', 'secondbrain', 'data', 'calls');
}

function normalizePhone(p) {
  if (!p) return '';
  return String(p).replace(/[^\d+]/g, '');
}

function listAllCalls() {
  const dir = callsDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    out.push(rec);
  }
  return out;
}

function assertNoRecentCall(phone) {
  const target = normalizePhone(phone);
  if (!target) throw new Error('[redial-guard] phone is required');

  const prior = listAllCalls().filter((r) => normalizePhone(r.phoneNumber) === target);
  if (prior.length === 0) {
    return { allowed: true, priorCallIds: [], damageControlCleared: false };
  }

  const unresolved = prior.filter((r) => r.luke_handled_damage_control !== true);
  if (unresolved.length === 0) {
    return {
      allowed: true,
      priorCallIds: prior.map((r) => r.id || '(unknown id)'),
      damageControlCleared: true,
    };
  }

  const lines = unresolved.map((r) => {
    const created = r.createdAt || '(unknown ts)';
    const ended = r.endedReason || '(unknown end)';
    return `  - ${r.id || '(unknown id)'} (${created}, endedReason=${ended})`;
  });

  throw new Error(
    `[redial-guard] BLOCKED: ${unresolved.length} prior call(s) to ${target} on record without damage-control clearance.\n` +
      lines.join('\n') +
      `\n\nA second outbound call to a number that already has an unresolved prior is reputational damage to Luke, regardless of how the first call ended.\n` +
      `Recovery path: Luke does damage control himself (email, in-person, second human). After repair, edit the prior call's JSON to set "luke_handled_damage_control": true and the guard clears.\n` +
      `Full rule: secondbrain/memory/feedback_no_redial_after_failed_call.md`,
  );
}

module.exports = { assertNoRecentCall, normalizePhone };
