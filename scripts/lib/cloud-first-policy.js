'use strict';
//
// cloud-first-policy.js -- the ONE definition of "this proposes making ExampleCo's
// PC a required step in a production path", shared by the design-time hook
// (scripts/claude-hooks/cloud-first-guard.mjs) and the land-time drift lint
// (scripts/verify-cloud-first-drift.js).
//
// WHY THIS EXISTS (2026-08-24 incident, ExampleCo: "you're creating a new PC
// dependency. That shouldn't be something you do so willy nilly. Check
// canonical docs. Why didn't the laws of amy gravity prevent this?"):
//
// Amy briefed a subagent to build a PRODUCTION video-clip pipeline step on
// ExampleCo's PC through scripts/desktop-capability-worker.js, justified by a
// claimed cloud blocker (YouTube refusing EC2 data-center addresses) that had
// never been tested. Tested live the same evening, the cloud handled it fine;
// the blocker had already been solved on 2026-05-25 with a durable cookies
// file plus a PO token provider. So the failure was two-layered:
//
//   1. an UNVERIFIED blocker was asserted as fact (law g13, never fabricate),
//   2. and used to justify routing production work onto the desktop.
//
// Every canonical rule against this already existed:
//   dev-plans/core/self-heal.md invariant 11
//   dev-plans/core/devops-release.md invariant 12
//   dev-plans/core/briefing.md rules of the road (PC-off must pass)
//   memory/feedback_cloud_first_never_assume_desktop.md
//
// None of them reached the model at the moment the brief was written.
// AMY_GRAVITY.md carried no cloud-first row, so gravity-router.mjs injected
// nothing; the devops-release registry keywords were deploy/release/parity/
// land/public-mirror, none of which appear in a video-clip brief, so
// core-component-router.mjs injected nothing either. The rule lived only at
// the lowest rung, a memory file. That is law g0 verbatim: a rule that is not
// mechanically enforced AND DELIVERED to the actor does not exist.
//
// WHAT IS NOT BANNED. The desktop relay is a SANCTIONED cross-host capability
// (devops-release.md invariant 12 and its Key files list). The rule is not
// "never touch the desktop", it is "no production producer may be PC-ONLY, and
// cross-host use requires both hosts plus authenticated receipts". The hook
// therefore WARNS and injects rather than blocking; the lint blocks at land
// time, where an allowlist entry can carry the owner's approval.

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Signals. CATEGORY, never the literal incident (feedback_frugal_regression_
// tests.md): nothing here mentions video, yt-dlp, or YouTube, because the next
// PC dependency will be in a different subsystem.
// ---------------------------------------------------------------------------

/**
 * Unambiguous "the PC is a required step" signals. These fire ALONE, because
 * naming the relay or worker in an outbound brief, or declaring something
 * PC-only, is never incidental.
 */
const HARD_DESKTOP_SIGNALS = [
  ['desktop-capability relay/worker', /desktop[-_ ]capability[-_ ](relay|worker)/i],
  ['PC-only / desktop-only declaration', /\b(pc|desktop|laptop|windows)[-\s]only\b/i],
  ['residential IP framing', /\bresidential\s+(ip|address|proxy|connection)\b/i],
  // Codex review 2e070e3c1b13 defeated the first cut with "the home
  // workstation" and a bare "Windows worker", neither of which used the word
  // desktop, PC, or laptop at all. The category is "a machine of ExampleCo's that
  // a person logs into", not the three nouns the incident happened to use.
  ['home workstation / home machine', /\bhome\s+(workstation|machine|host|box|server|pc)\b/i],
];

/** "Execution happens on ExampleCo's machine" signals. Need a second signal. */
const DESKTOP_SIGNALS = [
  [
    'run it on the PC',
    /\b(run|build|execute|do|host|schedule)\b[^.\n]{0,40}\b(on|from)\b[^.\n]{0,20}\b(the\s+)?(pc|desktop|laptop|workstation)\b/i,
  ],
  ['on ExampleCo’s PC/desktop/laptop', /\bon\s+ExampleCo'?’?s?\s+(pc|desktop|laptop|machine|box)\b/i],
  [
    'desktop relay / worker / machine',
    /\bdesktop\s+(relay|worker|capability|capabilities|machine|host|box|fallback|side)\b/i,
  ],
  [
    'the desktop/laptop as the executor',
    /\b(the\s+)?(desktop|laptop|workstation)\s+(will|should|can|must|has to|needs to)\b/i,
  ],
  ['Windows scheduled task on the PC', /\b(windows\s+scheduled\s+task|task\s+scheduler)\b/i],
  // Bare "workstation" is SOFT, not hard (Codex review caaa8e9cad31): as a
  // hard signal it fired on "Compare Dell workstations for a local development
  // upgrade", which is ordinary work. Paired with a production or blocker
  // signal it still catches the real case.
  ['bare workstation as the executor', /\bworkstations?\b/i],
  // Codex: "Build the scheduled Windows worker for the dashboard" passed. A
  // Windows-native worker or executor IS the PC, whatever it is called.
  [
    'Windows worker / executor / service',
    /\bwindows\s+(worker|executor|service|agent|host|box|node)\b/i,
  ],
  ['local executor / home executor', /\b(local|home)[-\s](executor|worker|runner|agent|relay)\b/i],
  // A logged-in browser or GUI session is the single most common REAL reason
  // to want the desktop, and it is exactly the case that needs the cross-host
  // contract rather than a quiet dependency.
  [
    'logged-in session / GUI / browser profile',
    /\b(logged[-\s]in|signed[-\s]in)\s+(session|browser|profile|account)\b|\bbrowser\s+profile\b|\bgui\s+(session|app|automation)\b/i,
  ],
  ['named desktop host', /\bExampleCoYPC\b/i],
  ['hardcoded Windows user path', /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}/],
  ['APPDATA literal', /%APPDATA%/i],
];

/**
 * "This is a production producer path" signals. Deliberately narrow: generic
 * nouns like "card" alone would fire on half of all work and train the reader
 * to skip the injection.
 */
const PRODUCTION_SIGNALS = [
  ['production / producer', /\bproducti(on|onise|onize)\b|\bproducers?\b/i],
  ['briefing or dashboard', /\bbriefings?\b|\bdashboard\b|\bbriefing card\b/i],
  ['System Health metric', /\bsystem[-\s]health\b|\bhealth\s+metric\b/i],
  ['pipeline / publish', /\bpipelines?\b|\bpublish(es|ing|ed)?\b/i],
  [
    'scheduled or overnight run',
    /\bnightly\b|\bovernight\b|\bscheduled\s+(task|runner|job|skill)\b|\bcron\b/i,
  ],
  ['cloud runtime / EC2 route', /\bec2\b|\bserver route\b|\bcloud (runner|producer|job)\b/i],
  ['self-heal', /\bself[-\s]heal\w*\b|\bhealers?\b/i],
];

/**
 * "A cloud blocker is being asserted" signals. This is the actual mechanism of
 * the 2026-08-24 failure: an untested blocker used to justify the PC. Paired
 * with any desktop signal it is enough on its own, because "the cloud can't do
 * it, so use the PC" IS the forbidden move.
 */
const BLOCKER_CLAIM_SIGNALS = [
  [
    'claimed cloud/EC2 blocker',
    /\b(ec2|cloud|data[-\s]?cent(er|re)|server)\b[^.\n]{0,60}\b(blocks?|blocked|banned|bans|refus\w+|rejects?|forbidden|cannot|can'?t|unable|not allowed)\b/i,
  ],
  [
    'claimed cloud incapacity',
    /\b(cloud|ec2)\b[^.\n]{0,30}\b(does\s?n[o']t|doesn't|won'?t|can'?t)\b/i,
  ],
  [
    'because the cloud is blocked',
    /\bbecause\b[^.\n]{0,50}\b(ec2|cloud|data[-\s]?cent(er|re))\b[^.\n]{0,40}\b(block\w*|ban\w*|refus\w*)\b/i,
  ],
];

function hits(text, signals) {
  const out = [];
  for (const [label, re] of signals) {
    if (re.test(text)) out.push(label);
  }
  return out;
}

/**
 * Does this outbound subagent brief propose making ExampleCo's PC a required step in
 * a production path?
 *
 * @param {{prompt?:string, description?:string}} input
 * @returns {{flagged:boolean, desktopHits:string[], productionHits:string[],
 *            blockerHits:string[], hardHits:string[]}}
 */
function evaluateCloudFirstRisk({ prompt = '', description = '' } = {}) {
  const text = `${String(prompt || '')}\n${String(description || '')}`;
  if (!text.trim()) {
    return { flagged: false, desktopHits: [], productionHits: [], blockerHits: [], hardHits: [] };
  }

  const hardHits = hits(text, HARD_DESKTOP_SIGNALS);
  const softHits = hits(text, DESKTOP_SIGNALS);
  const productionHits = hits(text, PRODUCTION_SIGNALS);
  const blockerHits = hits(text, BLOCKER_CLAIM_SIGNALS);
  const desktopHits = [...hardHits, ...softHits];

  // Fire when the PC is named unambiguously, or when a desktop-execution
  // signal meets either a production-path signal or a claimed cloud blocker.
  const flagged =
    hardHits.length > 0 ||
    (softHits.length > 0 && (productionHits.length > 0 || blockerHits.length > 0));

  return { flagged, desktopHits, productionHits, blockerHits, hardHits };
}

// ---------------------------------------------------------------------------
// SOURCE-SCAN patterns. These live here, not in the lint, so the design-time
// guard and the land-time lint share ONE definition of "a PC dependency".
//
// Codex review 2e070e3c1b13: the first cut kept these in the lint and asserted
// single-sourcing with a test that only checked both files MENTIONED this
// module. That is a vacuous assertion of a false claim. Now the lint imports
// them, and scripts/__tests__/cloud-first-policy.test.js proves behaviorally
// that neutering a pattern here changes the LINT's verdict.
// ---------------------------------------------------------------------------

/** The desktop execution modules. Requiring one is a cross-host dependency. */
const DESKTOP_MODULE_RE = /desktop-capability-(relay|worker|http-auth)/;

/**
 * Environment and config names that resolve to ExampleCo's machine. Codex named the
 * concrete bypass: a deployed producer reads an env-configured desktop URL and
 * lands green because no module name appears anywhere in the source.
 */
const DESKTOP_ENV_RE =
  /\b(AMY_DESKTOP_RELAY_URL|AMY_DESKTOP_RELAY_SECRET|DESKTOP_RELAY_URL|HOME_EXECUTOR_URL|DESKTOP_EXECUTOR_URL)\b|desktop-capability-worker\.env/;

const WINDOWS_PATH_RE = /['"`][^'"`\n]{0,80}[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)/;
const APPDATA_RE = /['"`][^'"`\n]{0,80}%APPDATA%/i;
const DESKTOP_SSH_RE = /\bssh\b[^\n]{0,120}(ExampleCoYPC|ExampleCo@|--desktop-host|\bdesktop\b)/i;

/**
 * A Windows path literal only creates a dependency when it reaches the
 * filesystem or a spawned process. The same literal inside an operator-facing
 * message is the honest cloud-blocker surface that
 * memory/feedback_cloud_first_never_assume_desktop.md explicitly permits
 * ("surface it as an honest cloud blocker"), so it must not be flagged.
 */
const PATH_OPERAND_RE =
  /\b(path\.(join|resolve|normalize|dirname|relative)|fs\.[a-zA-Z]+|readFileSync|writeFileSync|appendFileSync|existsSync|mkdirSync|readdirSync|statSync|createReadStream|createWriteStream|spawnSync|spawn|execSync|execFileSync|exec|subprocess\.[a-zA-Z_]+|os\.(path|makedirs|listdir)|open|require)\s*\(|\b[A-Za-z_]*(DIR|PATH|ROOT|FILE|HOME)\s*[:=]\s*$/;

/**
 * The OPENING of a path/fs/exec call. Global, so the scanner can find the
 * column where the argument region begins and decide whether a literal is
 * genuinely an ARGUMENT rather than merely on the same line. Shared with
 * scripts/verify-cloud-first-drift.js so there is one definition.
 */
// Deliberately NARROW. `open(` and a bare `exec(` were in the first cut and
// matched ordinary JavaScript (`re.exec(`, `.open(`), which opened a bogus
// operand region that then carried down the file and flagged operator messages
// in ec2-server.js and cloud-morning-briefing.js. A call name only belongs here
// when its argument really is a filesystem path.
const PATH_OPERAND_CALL_RE =
  /(?:^|[^.\w$])(?:path\.(?:join|resolve|normalize|dirname|relative)|fs\.[a-zA-Z]+|fsp\.[a-zA-Z]+|readFileSync|writeFileSync|appendFileSync|existsSync|mkdirSync|readdirSync|statSync|unlinkSync|rmSync|createReadStream|createWriteStream|spawnSync|spawn|execSync|execFileSync|require|os\.(?:makedirs|listdir)|os\.path\.join|subprocess\.[a-zA-Z_]+)\s*\(/g;

/** Identifier bound to a Windows-path literal: `const x = 'C:\\Users\\...'`. */
const WINDOWS_PATH_BINDING_RE =
  /(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*['"`][^'"`\n]{0,80}(?:[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)|%APPDATA%)/;

// ---------------------------------------------------------------------------
// The canonical text. Quoted VERBATIM from the core docs rather than
// paraphrased, so design equals code (law g22) and the injected rule cannot
// drift away from the authority that owns it. verify-cloud-first-drift.js
// asserts every anchor still resolves.
// ---------------------------------------------------------------------------

const CORE_ANCHORS = [
  {
    doc: 'dev-plans/core/self-heal.md',
    label: 'invariant 11 (no producer is PC-only)',
    capture: /Receipt-backed cards require Windows\/cloud parity; no producer is PC-only\./,
  },
  {
    doc: 'dev-plans/core/devops-release.md',
    label: 'invariant 12 (cross-host needs both hosts and receipts)',
    capture: /Cross-host capabilities require both hosts present and authenticated receipts\./,
  },
  {
    doc: 'dev-plans/core/briefing.md',
    label: 'rules of the road (PC-off is the gate)',
    capture: /PC-off [^.\n]*\./,
  },
  {
    doc: 'dev-plans/core/briefing.md',
    label: 'rules of the road (cloud owns generation through delivery)',
    capture: /Cloud owns generation through delivery[^.\n]*\./,
  },
  {
    doc: 'memory/feedback_cloud_first_never_assume_desktop.md',
    label: 'the rule itself',
    capture: /never reach for the desktop as a fallback[^.\n]*\./i,
  },
];

/**
 * Resolve every anchor against a repo tree.
 * @param {string} repoRoot
 * @returns {Array<{doc:string,label:string,text:string|null}>}
 */
function readAnchoredInvariants(repoRoot) {
  return CORE_ANCHORS.map((anchor) => {
    let src = '';
    try {
      src = fs.readFileSync(path.join(repoRoot, anchor.doc), 'utf8');
    } catch {
      return { ...anchor, text: null };
    }
    const m = anchor.capture.exec(src);
    return { doc: anchor.doc, label: anchor.label, text: m ? m[0].trim() : null };
  });
}

// The rule stated in Amy's own words. Used as the spine of the message and as
// the FALLBACK when a core doc cannot be read: a guard that goes silent because
// a file moved reproduces the exact hole it was built to close, so it degrades
// to the stated rule instead of to nothing.
const RULE_STATEMENT =
  'CLOUD-FIRST: production producers are cloud-resident. No receipt-backed ' +
  'producer may be PC-only, and ExampleCo’s PC is never a fallback for a cloud ' +
  'capability unless ExampleCo explicitly says so. The desktop relay IS sanctioned ' +
  'for genuine cross-host work, but only with both hosts present and ' +
  'authenticated receipts, never as a way to route around a cloud limitation.';

/**
 * Build the text delivered into model context.
 * @param {string} repoRoot
 * @param {ReturnType<typeof evaluateCloudFirstRisk>} verdict
 * @returns {string}
 */
function buildCloudFirstBriefing(repoRoot, verdict) {
  const parts = [];
  parts.push('CLOUD-FIRST GUARD: this subagent brief looks like it makes ExampleCo’s PC a');
  parts.push('required step in a production path. Read this BEFORE sending it.');
  parts.push('');
  parts.push(`Matched: desktop [${verdict.desktopHits.join('; ') || 'none'}]`);
  if (verdict.productionHits && verdict.productionHits.length) {
    parts.push(`         production [${verdict.productionHits.join('; ')}]`);
  }
  if (verdict.blockerHits && verdict.blockerHits.length) {
    parts.push(`         claimed cloud blocker [${verdict.blockerHits.join('; ')}]`);
  }
  parts.push('');
  parts.push(RULE_STATEMENT);
  parts.push('');
  parts.push('CANONICAL AUTHORITY, verbatim (the core docs own method):');

  // Fail loud, never silent (g14), PER ANCHOR. An earlier version only spoke
  // up when ZERO anchors resolved, so a single stale doc made one invariant
  // vanish from the injection without a word. Caught 2026-08-24 by a real
  // invocation: the shared checkout was behind master and lacked
  // devops-release invariant 12, so the cross-host rule, the exact half that
  // keeps sanctioned relay use legal, silently disappeared. A guard that
  // quietly drops a rule is the disease it exists to cure.
  for (const anchor of readAnchoredInvariants(repoRoot)) {
    parts.push(`  ${anchor.doc} -- ${anchor.label}:`);
    if (anchor.text) {
      parts.push(`    "${anchor.text}"`);
    } else {
      parts.push(
        `    UNRESOLVED: could not read this invariant from ${repoRoot}. The doc may be ` +
          'stale or moved. Open it directly and do not treat its absence as permission.',
      );
    }
  }

  if (verdict.blockerHits && verdict.blockerHits.length) {
    parts.push('');
    parts.push('YOU ARE ASSERTING A CLOUD BLOCKER. On 2026-08-24 that assertion was the');
    parts.push('actual defect: the claimed blocker had never been tested, and the cloud');
    parts.push('handled the work fine. Law g13 forbids the fabrication half. PROVE the');
    parts.push('blocker on EC2 with a live run, and paste the output, before any brief');
    parts.push('may cite it as a reason to use the desktop.');
  }

  parts.push('');
  parts.push('BEFORE YOU SEND THIS BRIEF:');
  parts.push('  1. Prove the cloud genuinely cannot do it, with a live EC2 run, not a');
  parts.push('     recollection. Fetch + LLM, S3, OAuth, and scans all run on EC2.');
  parts.push('  2. If the desktop is genuinely required, it is a CROSS-HOST capability:');
  parts.push('     both hosts must be present and the receipts authenticated, and the');
  parts.push('     cloud path must fail closed and visible when the PC is off, never');
  parts.push('     silently degrade. PC-off rehearsal is the gate.');
  parts.push('  3. Add the file to config/cloud-first-allowlist.json with path, reason,');
  parts.push('     approvedBy, date, and cloudFallback, or the land gate refuses it:');
  parts.push('     npm run verify:cloud-first-drift');
  parts.push('  4. Owner approval is required for a NEW PC dependency. ExampleCo, 2026-08-24:');
  parts.push('     "you’re creating a new PC dependency. That shouldn’t be something you');
  parts.push('     do so willy nilly."');
  return parts.join('\n');
}

module.exports = {
  evaluateCloudFirstRisk,
  buildCloudFirstBriefing,
  readAnchoredInvariants,
  CORE_ANCHORS,
  HARD_DESKTOP_SIGNALS,
  DESKTOP_SIGNALS,
  PRODUCTION_SIGNALS,
  BLOCKER_CLAIM_SIGNALS,
  RULE_STATEMENT,
  // Source-scan patterns, shared with scripts/verify-cloud-first-drift.js.
  DESKTOP_MODULE_RE,
  DESKTOP_ENV_RE,
  WINDOWS_PATH_RE,
  APPDATA_RE,
  DESKTOP_SSH_RE,
  PATH_OPERAND_RE,
  PATH_OPERAND_CALL_RE,
  WINDOWS_PATH_BINDING_RE,
};
