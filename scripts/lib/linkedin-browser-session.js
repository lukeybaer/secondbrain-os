'use strict';

// One place that decides where the LinkedIn Chromium profile lives and how the
// signed-in session reaches the cloud scanner (ExampleCo 2026-09-27: "you need to be
// cloud first, you shouldn't be doing linkedin stuff from pc").
//
// Windows Chromium encrypts cookies with DPAPI, so the PC profile directory
// cannot be copied to Linux. The session travels as Playwright cookie JSON in
// one SSM SecureString instead: the PC exports it after a manual login, EC2
// seeds its own persistent profile from it. After seeding, EC2's profile keeps
// LinkedIn's rotated cookies itself; SSM is re-applied only when a NEWER export
// arrives or the profile has no li_at at all. Cookie values never reach a log,
// a receipt, or a command line.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SESSION_PARAM = 'secondbrain.LINKEDIN_SESSION_COOKIES';
const REGION = 'us-east-1';
const SEED_MARKER = '.amy-session-seed.json';
const SESSION_SCHEMA = 'linkedin-session@1';

function linkedInProfileDir({ env = process.env, platform = process.platform } = {}) {
  if (env.SECONDBRAIN_LINKEDIN_PROFILE_DIR) return env.SECONDBRAIN_LINKEDIN_PROFILE_DIR;
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'secondbrain', 'chrome-profile-linkedin');
  }
  // Local disk, not the shared EFS data dir: Chromium profiles take file locks
  // and do many small writes.
  return path.join(os.homedir(), '.local', 'share', 'secondbrain', 'chrome-profile-linkedin');
}

function linkedInCookies(cookies) {
  return (Array.isArray(cookies) ? cookies : []).filter((cookie) =>
    /(^|\.)linkedin\.com$/i.test(String(cookie && cookie.domain ? cookie.domain : '').replace(/^\./, '')),
  );
}

function hasSessionCookie(cookies) {
  return linkedInCookies(cookies).some((cookie) => cookie.name === 'li_at' && cookie.value);
}

function buildSessionRecord(cookies, { now = () => new Date(), host = os.hostname() } = {}) {
  const kept = linkedInCookies(cookies);
  if (!hasSessionCookie(kept)) throw new Error('profile has no signed-in LinkedIn session (li_at missing)');
  return {
    schema: SESSION_SCHEMA,
    exportedAt: now().toISOString(),
    exportedFrom: host,
    cookies: kept.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: Number.isFinite(c.expires) ? c.expires : -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
    })),
  };
}

function parseSessionRecord(raw) {
  const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!record || record.schema !== SESSION_SCHEMA || !Array.isArray(record.cookies)) {
    throw new Error('LinkedIn session record has the wrong schema');
  }
  if (!Number.isFinite(Date.parse(record.exportedAt))) {
    throw new Error('LinkedIn session record has no exportedAt');
  }
  if (!hasSessionCookie(record.cookies)) throw new Error('LinkedIn session record has no li_at');
  return record;
}

// Safe summary for logs and receipts: counts and timestamps, never values.
function describeSessionRecord(record) {
  const liAt = record.cookies.find((c) => c.name === 'li_at');
  return {
    exportedAt: record.exportedAt,
    exportedFrom: record.exportedFrom || '',
    cookieCount: record.cookies.length,
    liAtExpires:
      liAt && liAt.expires > 0 ? new Date(liAt.expires * 1000).toISOString() : 'session',
  };
}

function awsSsm(args, { exec = execFileSync } = {}) {
  return exec('aws', ['ssm', ...args, '--region', REGION], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    windowsHide: true,
  });
}

function readSessionFromSsm({ exec } = {}) {
  const raw = awsSsm(
    ['get-parameter', '--name', SESSION_PARAM, '--with-decryption', '--query', 'Parameter.Value', '--output', 'text'],
    { exec },
  );
  return parseSessionRecord(String(raw).trim());
}

// The value goes through a 0600 temp file (file://), never argv.
function writeSessionToSsm(record, { exec, tmpDir = os.tmpdir() } = {}) {
  parseSessionRecord(record);
  const file = path.join(tmpDir, `li-session-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  try {
    awsSsm(
      [
        'put-parameter',
        '--name',
        SESSION_PARAM,
        '--type',
        'SecureString',
        '--tier',
        'Advanced',
        '--overwrite',
        '--value',
        `file://${file.replace(/\\/g, '/')}`,
      ],
      { exec },
    );
  } finally {
    fs.rmSync(file, { force: true });
  }
  return describeSessionRecord(record);
}

function readSeedMarker(profileDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(profileDir, SEED_MARKER), 'utf8'));
  } catch {
    return null;
  }
}

function writeSeedMarker(profileDir, record, extra = {}) {
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, SEED_MARKER),
    `${JSON.stringify({ exportedAt: record.exportedAt, seededAt: new Date().toISOString(), ...extra })}\n`,
    'utf8',
  );
}

// Fixed codes only: an error message can quote decrypted text (a JSON.parse
// error on a malformed value does), and scanner stdout lands in receipts.
function seedErrorCode(error) {
  if (error instanceof SyntaxError) return 'session-record-not-json';
  if (error && /schema|exportedAt|li_at/.test(String(error.message || ''))) return 'session-record-invalid';
  return 'ssm-read-failed';
}

// Decide, then apply. Seeds when the profile has no li_at, or when SSM holds an
// export provably newer than the one last applied (a fresh PC login supersedes
// a revoked cloud session). A signed-in profile whose recency cannot be proven
// (no or corrupt marker) keeps its own rotated cookies; the current export is
// recorded as seen so only a later export supersedes it.
async function seedContextFromSsm(context, { profileDir, readSession = readSessionFromSsm } = {}) {
  const hadSession = hasSessionCookie(await context.cookies('https://www.linkedin.com'));
  const marker = readSeedMarker(profileDir);
  let record;
  try {
    record = readSession();
  } catch (error) {
    return {
      seeded: false,
      reason: hadSession ? 'ssm-unreadable-profile-has-session' : 'ssm-unreadable-no-session',
      error: seedErrorCode(error),
    };
  }
  const markerMs = marker ? Date.parse(marker.exportedAt) : NaN;
  if (hadSession && !Number.isFinite(markerMs)) {
    writeSeedMarker(profileDir, record, { adopted: true });
    return { seeded: false, reason: 'profile-session-kept-marker-established', session: describeSessionRecord(record) };
  }
  if (hadSession && !(Date.parse(record.exportedAt) > markerMs)) {
    return { seeded: false, reason: 'profile-session-current', session: describeSessionRecord(record) };
  }
  await context.addCookies(record.cookies);
  writeSeedMarker(profileDir, record);
  return {
    seeded: true,
    reason: hadSession ? 'newer-export' : 'profile-had-no-session',
    session: describeSessionRecord(record),
  };
}

// The PC keeps no Playwright browser download, so Windows drives installed
// Chrome; EC2 uses Playwright's own Chromium.
function browserChannel({ env = process.env, platform = process.platform } = {}) {
  if (env.LINKEDIN_BROWSER_CHANNEL) return env.LINKEDIN_BROWSER_CHANNEL;
  return platform === 'win32' ? 'chrome' : undefined;
}

// Only Linux hosts seed from SSM; the Windows profile is the login source.
function shouldSeedFromSsm({ env = process.env, platform = process.platform } = {}) {
  if (env.LINKEDIN_SESSION_SEED === '0') return false;
  if (env.LINKEDIN_SESSION_SEED === '1') return true;
  return platform !== 'win32';
}

module.exports = {
  SESSION_PARAM,
  browserChannel,
  SESSION_SCHEMA,
  SEED_MARKER,
  buildSessionRecord,
  describeSessionRecord,
  hasSessionCookie,
  linkedInCookies,
  linkedInProfileDir,
  parseSessionRecord,
  readSessionFromSsm,
  seedContextFromSsm,
  shouldSeedFromSsm,
  writeSessionToSsm,
};
