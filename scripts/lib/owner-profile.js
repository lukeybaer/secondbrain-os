'use strict';
/**
 * owner-profile.js
 *
 * The single source of the briefing OWNER's identity (name, owned email
 * addresses, employer name + scan token, reputation-scan targets). The cloud
 * briefing builder used to hardcode these literals -- the maintainer's real
 * name, his work emails, and his employer name -- directly in
 * scripts/cloud-morning-briefing.js. That file ships to the public OSS mirror
 * (secondbrain-os) and so leaked 19 PII hits into the public-sync payload
 * (tests/pii-screen.spec.ts gate).
 *
 * The fix: this loader ships to public but contains ZERO literal PII -- only
 * generic placeholder defaults. The REAL owner values live in a private,
 * git-tracked fixture (data/agent/owner-profile.json) that is NOT in the public
 * ALLOWLIST (scripts/simulate-public-sync.js ships only src/tests/scripts/...,
 * never data/), so the fixture deploys with the private build to EC2 yet never
 * reaches the public mirror. Env vars override the fixture for ad-hoc runs.
 *
 * Resolution order (highest wins): env vars -> private fixture -> generic
 * defaults. So a clone with neither env nor fixture still builds (with generic
 * "Owner" / "Employer" placeholders), and the private deploy ExampleCos the real
 * profile via the fixture.
 */
const fs = require('node:fs');
const path = require('node:path');

// The profile fixture ships WITH this code (data/agent/owner-profile.json in the
// same repo), so the code-relative path -- resolved from __dirname, NOT from any
// SECONDBRAIN_ROOT override -- is the canonical, always-correct location. We put
// it first so a session whose SECONDBRAIN_ROOT points at a DIFFERENT checkout
// (the worktree/test case, where the override would miss the fixture this build
// actually ExampleCos) still finds it.
const CODE_RELATIVE_REPO = path.resolve(__dirname, '..', '..');
const FIXTURE_PATH = path.join(CODE_RELATIVE_REPO, 'data', 'agent', 'owner-profile.json');

// Candidate fixture locations, in priority order:
//   1. code-relative repo (ships with this file -- canonical)
//   2. SECONDBRAIN_ROOT override (when it points at the same tree)
//   3. runtime data-dir (SECONDBRAIN_DATA_DIR / --data-dir) for diverged deploys
function fixtureCandidates({ env = process.env, dataDir } = {}) {
  const out = [FIXTURE_PATH];
  if (env.SECONDBRAIN_ROOT) {
    out.push(path.join(env.SECONDBRAIN_ROOT, 'data', 'agent', 'owner-profile.json'));
  }
  const runtimeDataDir = dataDir || env.SECONDBRAIN_DATA_DIR;
  if (runtimeDataDir) out.push(path.join(runtimeDataDir, 'agent', 'owner-profile.json'));
  return Array.from(new Set(out));
}

// Generic, non-PII placeholders. A public clone with no env + no fixture builds
// against these; the private deploy supplies the real values via the fixture.
const DEFAULTS = Object.freeze({
  name: 'Owner',
  ownedEmails: [],
  employerName: 'Employer',
  // Lowercase scan token used in news-scan queries / regexes; defaults to the
  // lowercased employer name.
  employerToken: 'employer',
  // Extra reputation-scan targets beyond the owner name + employer (ventures,
  // brands). Empty by default.
  reputationExtraTargets: [],
});

function readFixture({ env = process.env, dataDir } = {}) {
  for (const candidate of fixtureCandidates({ env, dataDir })) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (raw && typeof raw === 'object') return raw;
    } catch {
      /* try the next candidate */
    }
  }
  return {};
}

function splitList(s) {
  return String(s || '')
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function dedupe(list) {
  return Array.from(new Set((Array.isArray(list) ? list : []).filter(Boolean)));
}

/**
 * loadOwnerProfile() -> resolved profile. Pure aside from reading env + the
 * fixture file; both are injectable for tests.
 */
function loadOwnerProfile({ env = process.env, fixture, dataDir } = {}) {
  const fx = fixture || readFixture({ env, dataDir });

  const name = env.SECONDBRAIN_OWNER_NAME || fx.name || DEFAULTS.name;

  const ownedEmails = dedupe([
    ...splitList(env.SECONDBRAIN_OWNER_EMAILS),
    ...(Array.isArray(fx.ownedEmails) ? fx.ownedEmails : []),
    ...DEFAULTS.ownedEmails,
  ]).map((e) => String(e).toLowerCase());

  const employerName = env.SECONDBRAIN_OWNER_EMPLOYER || fx.employerName || DEFAULTS.employerName;
  const employerToken = String(
    env.SECONDBRAIN_OWNER_EMPLOYER_TOKEN ||
      fx.employerToken ||
      employerName ||
      DEFAULTS.employerToken,
  ).toLowerCase();

  const reputationExtraTargets = dedupe([
    ...splitList(env.SECONDBRAIN_OWNER_REPUTATION_TARGETS),
    ...(Array.isArray(fx.reputationExtraTargets) ? fx.reputationExtraTargets : []),
    ...DEFAULTS.reputationExtraTargets,
  ]);

  // The reputation-scan target list: owner name + employer (display form) +
  // any extra brands/ventures. De-duped, order-stable.
  const employerDisplay = employerToken
    ? `${employerName.replace(/\s+group$/i, '')} Group`
    : employerName;
  const reputationTargets = dedupe([name, employerDisplay, ...reputationExtraTargets]);

  // The employer news card title + manifest id + markdown contract pattern, all
  // derived from the employer so the card text is owner-specific yet ExampleCos no
  // hardcoded literal. UPPERCASE display for the legacy section heading.
  const employerCardTitle = `${employerName.toUpperCase()} GROUP NEWS`;

  return {
    name,
    ownedEmails,
    employerName,
    employerToken,
    reputationTargets,
    employerCardTitle,
  };
}

module.exports = { loadOwnerProfile, FIXTURE_PATH, DEFAULTS };
