'use strict';

// Pure comparison logic for the C4 deploy-parity probe (Codex amendment 3,
// item W3a). Extracted from scripts/verify-deploy-parity.js so the hashing /
// drift-classification rules are unit-testable against temp files without
// needing a real EC2 host or a real git checkout.
//
// Three kinds of drift this checks for (Codex: file hashes alone are NOT
// enough):
//   1. git HEAD parity  -- build-path checkout HEAD vs origin/master HEAD.
//   2. file-content parity -- CRLF-normalized sha256 of each deployed file
//      (server.js + each LIVE_DEPS module) vs its repo source.
//   3. ACTIVE-PROCESS parity -- the running PM2 process can still be serving
//      old in-memory code even after the file on disk is updated. A live
//      server.js mtime newer than the PM2 process start time means
//      deployed-but-not-restarted; that is reported as its own drift kind so
//      it is never confused with a plain file-content mismatch.

const crypto = require('node:crypto');

/** CRLF-normalize then sha256 hex digest, matching deploy-ec2-server.sh's
 * `tr -d '\r'` normalization so a line-ending-only difference never reads as
 * drift. */
function normalizedSha256(content) {
  const normalized = String(content == null ? '' : content).replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Compare git HEAD of the build-path checkout against origin/master.
 * @returns {{ok:boolean, kind:'git-head', drift?:object}}
 */
function checkGitHeadParity({ originMasterHead, buildPathHead }) {
  if (!originMasterHead || !buildPathHead) {
    return {
      ok: false,
      kind: 'git-head',
      drift: {
        file: 'build-path HEAD',
        kind: 'git-head',
        detail: 'could not resolve one or both HEADs',
        originMasterHead: originMasterHead || null,
        buildPathHead: buildPathHead || null,
      },
    };
  }
  if (originMasterHead === buildPathHead) return { ok: true, kind: 'git-head' };
  return {
    ok: false,
    kind: 'git-head',
    drift: {
      file: 'build-path HEAD',
      kind: 'git-head',
      detail: `build-path is at ${buildPathHead.slice(0, 12)}, origin/master is at ${originMasterHead.slice(0, 12)}`,
      originMasterHead,
      buildPathHead,
    },
  };
}

/**
 * Compare one repo source file's normalized hash against its deployed copy.
 * @param {{file:string, repoContent:string|null, liveContent:string|null}} args
 * @returns {{ok:boolean, kind:'file-content', drift?:object}}
 */
function checkFileParity({ file, repoContent, liveContent }) {
  if (repoContent == null || liveContent == null) {
    return {
      ok: false,
      kind: 'file-content',
      drift: {
        file,
        kind: 'file-content',
        detail:
          repoContent == null && liveContent == null
            ? 'missing on both repo and live host'
            : repoContent == null
              ? 'missing in repo source'
              : 'missing on live host (/opt)',
      },
    };
  }
  const repoHash = normalizedSha256(repoContent);
  const liveHash = normalizedSha256(liveContent);
  if (repoHash === liveHash) return { ok: true, kind: 'file-content' };
  return {
    ok: false,
    kind: 'file-content',
    drift: { file, kind: 'file-content', detail: 'sha256 mismatch after CRLF normalization' },
  };
}

/**
 * ACTIVE-PROCESS parity: a live deployed file mtime newer than the PM2
 * process start time means that file was deployed but the process was never
 * restarted, so PM2 is still serving stale in-memory code even though the
 * on-disk file now matches the repo. This is reported as its own drift kind
 * (never merged into file-content) because a clean file-hash match can still
 * be paired with a stale running process.
 *
 * Codex review 2026-07-02: checking ONLY server.js's mtime missed the case
 * where a LIVE_DEPS module (e.g. a lib file server.js requires) is deployed
 * after PM2 started while server.js itself stays untouched -- hashes would
 * pass while PM2 still served the cached old dependency code. The caller
 * passes the MAX mtime across every deployed file (server.js + every
 * LIVE_DEPS copy), so any one of them being newer than the process start is
 * caught.
 * @param {{newestFileMtimeMs:number|null, newestFile?:string, pm2StartMs:number|null}} args
 * @returns {{ok:boolean, kind:'active-process', drift?:object}}
 */
function checkActiveProcessParity({ newestFileMtimeMs, newestFile, pm2StartMs }) {
  if (!Number.isFinite(newestFileMtimeMs) || !Number.isFinite(pm2StartMs)) {
    return {
      ok: false,
      kind: 'active-process',
      drift: {
        file: 'secondbrain-backend (PM2)',
        kind: 'active-process',
        detail: 'could not read deployed file mtimes or PM2 process start time',
      },
    };
  }
  if (newestFileMtimeMs <= pm2StartMs) return { ok: true, kind: 'active-process' };
  return {
    ok: false,
    kind: 'active-process',
    drift: {
      file: 'secondbrain-backend (PM2)',
      kind: 'active-process',
      detail: `${newestFile || 'a deployed file'} on disk is newer than the running PM2 process start time -- deployed but not restarted`,
      newestFile: newestFile || null,
      newestFileMtimeMs,
      pm2StartMs,
    },
  };
}

/**
 * True when a deploy is actively in progress and drift should be suppressed
 * to avoid a false-red mid-deploy window. deploy-ec2-server.sh creates this
 * lock at the start of a real deploy and removes it at the end.
 */
function deployInProgress({ lockExists }) {
  return Boolean(lockExists);
}

/**
 * Roll up individual checks into the final report shape, applying the
 * false-red mitigations: (a) deploy-lock suppression -- if a deploy is in
 * progress, drift is downgraded to a suppressed/ok report rather than a hard
 * red; (b) double-read -- the caller re-checks drifted files once after a
 * short delay in the SAME run and only the checks that drift on BOTH reads
 * survive into the final report (passed in as `confirmedDrift`).
 *
 * @param {object[]} checks results from checkGitHeadParity / checkFileParity / checkActiveProcessParity
 * @param {{lockExists:boolean}} opts
 * @returns {{ok:boolean, drift:object[], suppressed:boolean}}
 */
function buildParityReport(checks, opts = {}) {
  const drift = checks.filter((c) => !c.ok).map((c) => c.drift);
  if (deployInProgress(opts)) {
    return {
      ok: true,
      drift: [],
      suppressed: true,
      suppressedDrift: drift,
    };
  }
  return { ok: drift.length === 0, drift, suppressed: false };
}

module.exports = {
  normalizedSha256,
  checkGitHeadParity,
  checkFileParity,
  checkActiveProcessParity,
  deployInProgress,
  buildParityReport,
};
