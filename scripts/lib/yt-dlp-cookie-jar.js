// yt-dlp-cookie-jar.js
//
// One shared answer to "is the YouTube credential actually usable?" and one
// safe way to hand it to yt-dlp.
//
// 2026-08-24, found while chasing why a viral clip could not rebuild. The
// health probe reported GREEN over a credential that failed 17 out of 17
// yt-dlp invocations, because it only measured the file's mtime:
//
//   mtime: 2026-08-25T00:50:37Z   ageDays: 0.0008
//   CURRENT PROBE VERDICT: green (cookies fresh)
//   REALITY: every invocation dies on "Sign in to confirm you're not a bot"
//
// Worse, the probe re-armed itself. yt-dlp REWRITES the cookie jar after every
// run (proven: md5 e34ac55b -> a6f417c6 across one failing run, mtime
// 00:48:02 -> 00:49:37), so the file's age reset to zero on each failure. The
// more the credential failed, the fresher it looked. Freshness is not liveness.
//
// Measured contents of the broken jar: 21 cookies, all on `.youtube.com` except
// one `.x.com` row, and no `#HttpOnly_` rows at all. The non-HttpOnly
// `__Secure-3P*` family survived; LOGIN_INFO, which is a `.youtube.com` cookie
// and is normally HttpOnly, is absent. So the likeliest export mistake is an
// exporter that skipped HttpOnly rows, or a window that was not actually
// signed in. Either way it is an EXPORT defect, not decay: the name set did not
// shrink across runs, only the rotating `__Secure-*SIDTS` values moved.
//
// This module therefore grades the credential by what it CONTAINS and, when
// asked, by a REAL fetch, never by its age; and it stages a per-invocation copy
// so yt-dlp's write-back can never damage the master credential.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_JAR = process.env.YT_DLP_COOKIES || '/opt/secondbrain/.yt-dlp-cookies.txt';

// Codex 2026-08-24 [high]: the first cut invented its own eight-name predicate
// and would have rejected jars yt-dlp uses happily. Mirror yt-dlp's own bar:
// a session counts as authenticated when LOGIN_INFO is present together with at
// least one of the *APISID cookies.
const SESSION_COOKIE = 'LOGIN_INFO';
const API_SID_COOKIES = ['SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID'];
// Informational only, so a message can be precise about which half is missing.
// Never a pass/fail requirement.
const GOOGLE_AUTH_COOKIES = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID'];
const REQUIRED_AUTH_COOKIES = [SESSION_COOKIE, ...API_SID_COOKIES];

/**
 * Parse a Netscape cookie jar into domains and NAMES only.
 *
 * This never returns, logs, or stores a cookie VALUE. Everything downstream
 * (health details, card text, receipts) is built from names, so a diagnostic
 * can be printed anywhere without leaking the credential.
 */
function parseCookieJar(text) {
  const rows = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    // Codex 2026-08-24 [high]: `#HttpOnly_` is a curl/Netscape PREFIX on a real
    // cookie row, not a comment. LOGIN_INFO is normally HttpOnly, so skipping
    // these lines made a CORRECTLY exported jar look like it was missing its
    // auth cookies, a false negative that would have blocked a good credential.
    const httpOnly = rawLine.startsWith('#HttpOnly_');
    const line = httpOnly ? rawLine.slice('#HttpOnly_'.length) : rawLine;
    if (!httpOnly && line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    rows.push({ domain: parts[0], expires: Number(parts[4]) || 0, name: parts[5], httpOnly });
  }
  return rows;
}

/**
 * Describe the credential by content. Age is recorded but never graded on.
 */
function inspectCookieJar(jarPath = DEFAULT_JAR) {
  const result = {
    path: jarPath,
    exists: false,
    cookieCount: 0,
    domains: [],
    names: [],
    missingRequired: [...REQUIRED_AUTH_COOKIES],
    hasGoogleDomain: false,
    hasSessionCookie: false,
    apiSidCookies: [],
    applicableCount: 0,
    expiredCount: 0,
    looksAuthenticated: false,
    googleAuthPresent: [],
    ageDays: null,
  };
  let raw;
  let stat;
  try {
    stat = fs.statSync(jarPath);
    raw = fs.readFileSync(jarPath, 'utf8');
  } catch {
    return result;
  }
  result.exists = true;
  result.ageDays = (Date.now() - stat.mtimeMs) / 864e5;
  const rows = parseCookieJar(raw);
  result.cookieCount = rows.length;
  result.domains = [...new Set(rows.map((r) => r.domain))].sort();
  result.names = [...new Set(rows.map((r) => r.name))].sort();
  // Codex 2026-08-24 v2 [medium]: yt-dlp evaluates the cookies APPLICABLE to
  // https://www.youtube.com, then requires the session cookie plus an SID
  // cookie. Aggregating names across every domain and ignoring expiry would let
  // a wrong-domain or long-expired row satisfy the predicate.
  const nowSec = Date.now() / 1000;
  const applicable = rows.filter((r) => {
    const d = String(r.domain || '').replace(/^\./, '').toLowerCase();
    const domainOk = d === 'youtube.com' || d === 'www.youtube.com' || d === 'google.com';
    // expires 0 means a session cookie, which is still applicable
    const notExpired = !r.expires || r.expires > nowSec;
    return domainOk && notExpired;
  });
  result.applicableCount = applicable.length;
  result.expiredCount = rows.filter((r) => r.expires && r.expires <= nowSec).length;
  const nameSet = new Set(applicable.map((r) => r.name));
  result.hasSessionCookie = nameSet.has(SESSION_COOKIE);
  result.apiSidCookies = API_SID_COOKIES.filter((n) => nameSet.has(n));
  // yt-dlp's bar, not one we invented.
  result.looksAuthenticated = result.hasSessionCookie && result.apiSidCookies.length > 0;
  result.missingRequired = [];
  if (!result.hasSessionCookie) result.missingRequired.push(SESSION_COOKIE);
  if (!result.apiSidCookies.length) result.missingRequired.push(API_SID_COOKIES.join(' or '));
  result.hasGoogleDomain = result.domains.some((d) => d.includes('google.com'));
  result.googleAuthPresent = GOOGLE_AUTH_COOKIES.filter((n) => nameSet.has(n));
  return result;
}

/**
 * Hand yt-dlp a COPY, never the master credential.
 *
 * Codex 2026-08-24 [high]: this must FAIL CLOSED. An earlier version returned
 * the master path when staging failed, which handed yt-dlp the very file the
 * function exists to protect.
 */
function stageCookieJarCopy(jarPath = DEFAULT_JAR, opts = {}) {
  const dir = fs.mkdtempSync(path.join(opts.tmpDir || os.tmpdir(), 'ytdlp-jar-'));
  const copy = path.join(dir, 'cookies.txt');
  try {
    fs.copyFileSync(jarPath, copy);
    try {
      fs.chmodSync(copy, 0o600);
    } catch {
      /* platforms without POSIX modes */
    }
  } catch (e) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* nothing to clean */
    }
    throw new Error(`refusing to hand yt-dlp the master cookie jar: staging failed (${e.message})`);
  }
  return {
    path: copy,
    dir,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the OS reaps the temp dir anyway */
      }
    },
  };
}

/**
 * Codex 2026-08-24 [medium]: stage and clean around EACH invocation. Reusing
 * one copy for a whole build let later subprocesses inherit earlier write-back
 * mutations, and a killed process left a credential copy behind.
 */
function withStagedCookieJar(jarPath, fn, opts = {}) {
  const staged = stageCookieJarCopy(jarPath, opts);
  let deferred = false;
  try {
    const result = fn(staged.path);
    // An async caller (a non-blocking yt-dlp child) still needs the jar until
    // its promise settles, so cleanup waits for it instead of running now.
    if (result && typeof result.then === 'function') {
      deferred = true;
      return Promise.resolve(result).finally(() => staged.cleanup());
    }
    return result;
  } finally {
    if (!deferred) staged.cleanup();
  }
}

// Codex 2026-08-24 [high]: the first cut told ExampleCo to "EXPORT ALL COOKIES",
// which is overbroad and not the documented procedure. The measured gap is
// LOGIN_INFO, a `.youtube.com` HttpOnly cookie, so a youtube.com-scoped export
// is correct as long as HttpOnly rows are included.
function cookieRefreshSteps(jarPath = DEFAULT_JAR) {
  return [
    'Open a NEW incognito/private Chrome window. yt-dlp documents this, because a private session is not rotated as you keep browsing, so the exported cookies stay valid instead of dying within days.',
    'In that private window sign in to https://www.youtube.com with the Google account that owns the upload channel, and confirm your avatar shows you are signed in.',
    'Open a new tab in that SAME private window and go to https://www.youtube.com/robots.txt. This stops YouTube from rotating the session while you export.',
    'With that tab focused, use the "Get cookies.txt LOCALLY" extension (enable "Allow in Incognito" at chrome://extensions if it is greyed out) and export cookies for youtube.com.',
    'Open the saved cookies.txt in Notepad and confirm you can find a LOGIN_INFO line. It may appear with a #HttpOnly_ prefix, which is correct and expected. If LOGIN_INFO is absent, the export skipped HttpOnly cookies or the window was not signed in, so redo from step 2. A missing LOGIN_INFO is exactly what is broken right now.',
    `Copy it to the server with: scp -i ~/.ssh/sb-key.pem cookies.txt ec2-user@ExampleCo:${jarPath}`,
    'Close the private window WITHOUT clicking sign out. Signing out invalidates the session you just exported.',
    'Tell Amy it is uploaded. Amy re-runs the probe, which performs a real authenticated fetch, and reports whether the credential now works.',
  ];
}

/**
 * A REAL fetch, not a name check.
 *
 * Codex 2026-08-24 [high]: names alone cannot prove a credential works. An
 * expired or rotated jar can carry every expected name and still be refused, so
 * grading green from names would recreate the exact false-green defect this
 * module exists to kill. Green requires this probe to succeed.
 *
 * Always runs against a STAGED COPY, so the probe cannot damage the master.
 */
function probeCookieJarLive(jarPath = DEFAULT_JAR, opts = {}) {
  const { spawnSync } = require('child_process');
  const url = opts.url || 'https://www.youtube.com/watch?v=l6USUAIKJls';
  const timeoutMs = opts.timeoutMs || 90000;
  let staged;
  try {
    staged = stageCookieJarCopy(jarPath, opts);
  } catch (e) {
    return { ok: false, code: 'STAGE_FAILED', detail: e.message };
  }
  try {
    const r = spawnSync(
      opts.python || 'python3',
      [
        '-m',
        'yt_dlp',
        '--cookies',
        staged.path,
        '--simulate',
        '--no-warnings',
        '--print',
        'PROBE_OK %(id)s',
        url,
      ],
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    );
    const stdout = String(r.stdout || '');
    const stderr = String(r.stderr || '');
    if (stdout.includes('PROBE_OK') && r.status === 0 && !r.error) {
      return { ok: true, code: 'FETCH_OK', detail: 'live fetch succeeded' };
    }
    // Codex 2026-08-24 v2 [medium]: PROBE_OK alone is not success, and a probe
    // that could not RUN teaches nothing about the credential. Reporting a
    // broken python or a dead network as an auth failure would send ExampleCo to
    // re-export cookies over a problem cookies cannot fix.
    if (r.error) {
      return {
        ok: false,
        code: 'PROBE_INFRA_FAILED',
        detail: `probe could not run: ${r.error.message}`,
      };
    }
    const botCheck = /sign in to confirm you.{0,3}re not a bot/i.test(stderr);
    const firstError = stderr.split(/\r?\n/).find((l) => /^ERROR/i.test(l.trim()));
    if (!botCheck && !firstError) {
      return {
        ok: false,
        code: 'PROBE_INFRA_FAILED',
        detail: `probe exited ${r.status} without a yt-dlp error`,
      };
    }
    return {
      ok: false,
      code: botCheck ? 'FETCH_BOT_CHECK' : 'FETCH_FAILED',
      detail: String(firstError || 'fetch failed').slice(0, 300),
    };
  } finally {
    staged.cleanup();
  }
}

/**
 * The owner-facing verdict.
 *
 * Age is never the grade. Names gate cheaply; a real fetch is what earns green
 * when `live` is requested.
 */
function gradeCookieJar(jarPath = DEFAULT_JAR, opts = {}) {
  const jar = inspectCookieJar(jarPath);
  if (!jar.exists) {
    return {
      ok: false,
      status: 'red',
      code: 'COOKIES_MISSING',
      detail: `cookie jar missing at ${jarPath}; every YouTube fetch will hit the bot check`,
      jar,
      steps: cookieRefreshSteps(jarPath),
    };
  }
  if (!jar.looksAuthenticated) {
    return {
      ok: false,
      status: 'red',
      code: 'COOKIES_NOT_AUTHENTICATED',
      // Age is stated explicitly so nobody re-derives the old wrong conclusion.
      detail:
        `YouTube cookie jar is present and recently written (${jar.ageDays.toFixed(1)}d old) but is NOT a ` +
        `signed-in session: missing ${jar.missingRequired.join(' and ')}. Recency is not liveness; yt-dlp ` +
        `rewrites this file on every run, so its age resets even when every fetch fails. Needs a re-export.`,
      jar,
      steps: cookieRefreshSteps(jarPath),
    };
  }
  if (opts.live) {
    const live = probeCookieJarLive(jarPath, opts);
    if (!live.ok) {
      return {
        ok: false,
        status: 'red',
        code: live.code,
        detail: `cookie jar carries the auth cookies but a real fetch was refused (${live.code}): ${live.detail}`,
        jar,
        live,
        steps: cookieRefreshSteps(jarPath),
      };
    }
    return {
      ok: true,
      status: 'green',
      code: 'COOKIES_VERIFIED_LIVE',
      detail: `cookie jar proven by a live authenticated fetch (${jar.cookieCount} cookies)`,
      jar,
      live,
      steps: [],
    };
  }
  // Names only. This is a CHEAP pre-check and says so, rather than claiming the
  // credential is proven.
  // Codex 2026-08-24 v2 [high]: names-only must NEVER be green. Expired or
  // server-rejected cookies carry every expected name, so an unverified pass is
  // UNKNOWN, not healthy. Only a live fetch earns green.
  return {
    ok: false,
    status: 'yellow',
    code: 'COOKIES_PRESENT_UNVERIFIED',
    detail:
      `cookie jar carries the auth cookies yt-dlp requires (${SESSION_COOKIE} + ` +
      `${jar.apiSidCookies.join(', ')}); not live-verified in this run`,
    jar,
    steps: [],
  };
}

module.exports = {
  DEFAULT_JAR,
  SESSION_COOKIE,
  API_SID_COOKIES,
  GOOGLE_AUTH_COOKIES,
  REQUIRED_AUTH_COOKIES,
  parseCookieJar,
  inspectCookieJar,
  gradeCookieJar,
  probeCookieJarLive,
  cookieRefreshSteps,
  stageCookieJarCopy,
  withStagedCookieJar,
};
