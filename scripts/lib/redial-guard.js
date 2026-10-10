// Outbound-call redial guard. External-contact permanent ban edition.
//
// Rule: a prior failed outside-world human interaction blocks permanently.
// A finalized no-human outcome may be retried only after the route is fixed
// and ExampleCo gives a fresh, recorded instruction for that no-human retry. There
// is no time-based cooldown or environment override. Verified principal
// numbers in the private canonical owner_phones registry remain behind the
// global stop state, current release proof, fresh owner instruction, and every
// call gate.
//
// Why this exists: 2026-05-15 dealership service-call incident. Amy's first call
// reached a human rep, the interaction failed (phone-readback doom loop), and
// a redial fired 60 seconds later with a tweaked prompt. The dealer experienced
// two awkward AI calls 60 seconds apart, which is indistinguishable from a
// scam dialer pattern. ExampleCo's correction: "no redial at all when you fail a
// human interaction. Just leave a note for ExampleCo to do the damage control."
//
// Full rule: secondbrain/memory/feedback_no_redial_after_failed_call.md

const fs = require('node:fs');
const path = require('node:path');
const {
  assertOperatorOutboundCallsAllowed,
  assertOutboundCallsAllowed,
} = require('./outbound-call-control.js');

function callsDir(opts = {}) {
  return opts.callsDir || path.join(process.env.APPDATA || '', 'secondbrain', 'data', 'calls');
}

function contactsPath(opts = {}) {
  return opts.contactsPath || path.join(path.dirname(callsDir(opts)), 'agent', 'contacts.json');
}

function normalizePhone(p) {
  if (!p) return '';
  return String(p).replace(/[^\d+]/g, '');
}

function listAllCalls(opts = {}) {
  const dir = callsDir(opts);
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

function listPrincipalPhones(opts = {}) {
  try {
    const store = JSON.parse(fs.readFileSync(contactsPath(opts), 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(store?.owner_phones)) return [];
    return [...new Set(store.owner_phones.map(normalizePhone).filter(Boolean))];
  } catch {
    return [];
  }
}

function assertNoRecentCall(phone, opts = {}) {
  const target = normalizePhone(phone);
  const controlOpts = {
    dataDir: opts.dataDir || path.dirname(callsDir(opts)),
    ...(opts.controlPath ? { controlPath: opts.controlPath } : {}),
  };
  if (process.platform === 'win32' && opts.canonicalRemoteChecked === true) {
    // The broker has already received canonical EC2 admission for the current
    // deployed release proof. Re-check only the laptop operator stop here;
    // requiring a second local proof would reject a valid cross-host receipt.
    if (opts.purpose === 'principal-test') {
      assertOutboundCallsAllowed({
        ...controlOpts,
        purpose: 'principal-test',
        phoneNumber: target,
        invocationKey: opts.invocationKey,
      });
    } else {
      assertOperatorOutboundCallsAllowed(controlOpts);
    }
  } else {
    assertOutboundCallsAllowed(controlOpts);
  }
  if (process.platform === 'win32' && opts.canonicalRemoteChecked !== true) {
    const error = new Error(
      '[redial-guard] Windows provider contact requires a successful canonical EC2 stop-state preflight through the outbound-call broker.',
    );
    error.code = 'OUTBOUND_CANONICAL_CHECK_REQUIRED';
    throw error;
  }
  if (!target) throw new Error('[redial-guard] phone is required');
  const principalContact = listPrincipalPhones(opts).includes(target);

  const prior = listAllCalls(opts).filter((r) => normalizePhone(r.phoneNumber) === target);
  if (prior.length === 0) {
    return { allowed: true, priorCallIds: [], damageControlCleared: false, principalContact };
  }

  const unresolved = prior.filter((r) => r.ExampleCo_handled_damage_control !== true);
  if (unresolved.length === 0) {
    return {
      allowed: true,
      priorCallIds: prior.map((r) => r.id || '(unknown id)'),
      damageControlCleared: true,
      principalContact,
    };
  }

  if (principalContact) {
    return {
      allowed: true,
      priorCallIds: prior.map((r) => r.id || '(unknown id)'),
      damageControlCleared: false,
      principalContact: true,
      principalRedialExemption: true,
    };
  }

  const ownerRequestText = String(opts.ownerRequestText || '').trim();
  const finalizedNoHumanOnly = unresolved.every(
    (record) =>
      String(record.status || '').toLowerCase() === 'ended' &&
      String(record.outcome_classification || '').toLowerCase() === 'no_human_reached',
  );
  if (
    unresolved.length > 0 &&
    opts.allowNoHumanRedial === true &&
    ownerRequestText &&
    finalizedNoHumanOnly
  ) {
    return {
      allowed: true,
      priorCallIds: prior.map((r) => r.id || '(unknown id)'),
      damageControlCleared: false,
      principalContact: false,
      ownerAuthorizedNoHumanRetry: true,
    };
  }

  const lines = unresolved.map((r) => {
    const created = r.createdAt || '(unknown ts)';
    const ended = r.endedReason || '(unknown end)';
    return `  - ${r.id || '(unknown id)'} (${created}, endedReason=${ended})`;
  });

  throw new Error(
    `[redial-guard] BLOCKED: ${unresolved.length} prior outside-world call(s) to ${target} on record without damage-control clearance.\n` +
      lines.join('\n') +
      `\n\nA second outbound call is allowed only when every unresolved prior is finalized as no_human_reached and ExampleCo gives a fresh, recorded no-human retry instruction. A pending call or failed human interaction remains blocked.\n` +
      `Human-interaction recovery path: ExampleCo does damage control himself (email, in-person, second human). After repair, edit the prior call's JSON to set "ExampleCo_handled_damage_control": true and the guard clears.\n` +
      `Full rule: secondbrain/memory/feedback_no_redial_after_failed_call.md`,
  );
}

module.exports = {
  assertNoRecentCall,
  callsDir,
  contactsPath,
  listAllCalls,
  listPrincipalPhones,
  normalizePhone,
};
