// lib/otter-pc-mirror.js
//
// Pure planning + classification logic for the EC2 -> PC otter mirror.
// Phase 2 (2026-06-01) moved otter processing to Fargate/EFS/EC2 and archived
// the PC voice sweep; that sweep was the only thing keeping the PC copies of
// data/otter/raw + data/otter/enriched fresh. Nothing replaced the mirror leg,
// so the PC archive (life-archive index, S3 durability sync, contact sweeps,
// speaker reports) silently ran on stale data for 13 days while every health
// probe stayed green. These helpers are the mechanical guard against that
// class of rot: divergence between the EC2 canonical dirs and the PC mirror
// must be detectable as a pure function of the two listings.
//
// Identity is the OTID, never the filename: the two sides name raw files
// differently (PC-era `date-title-slug.json`, EC2-era `date-slug-otidSuffix
// .json`, historical `archive-s3-<otid>.json`), so a name-based mirror would
// duplicate hundreds of conversations in the life-archive.
//
// CLI wrapper: scripts/otter-ec2-mirror.js
// Probe + heal: scripts/health-self-heal.js (probeOtterPcMirror)

// A fetchable filename is a single safe path component. Remote listings feed
// tar (-T stdin) and local extraction, so a compromised/MITM'd remote must not
// be able to smuggle separators, traversal, or option-looking junk through the
// plan. Leading '-' is allowed (raw otids are base64url) because the tar legs
// use --verbatim-files-from; everything else stays strict.
function isSafeName(name) {
  const s = String(name || '');
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.json$/.test(s)) return false;
  if (s.includes('..') || s.includes('/') || s.includes('\\')) return false;
  return true;
}

// Parse remote listing lines `name\totid\tsize` into [{ name, otid, size }].
// (Produced by a remote node one-liner that reads each raw file's id field.)
function parseRemoteListing(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 3) continue;
    const [name, otid, sizeStr] = parts;
    const size = Number(sizeStr);
    if (!isSafeName(name) || !Number.isFinite(size)) continue;
    out.push({ name, otid, size });
  }
  return out;
}

// Raw plan: fetch a remote file only when its OTID is absent locally. Additive
// only -- local-only files (historical records EC2 no longer holds) are never
// touched, and a conversation already present under ANY filename is skipped.
// Duplicate remote rows for the same OTID plan a single fetch (first wins).
function planRawFetch({ remote, localOtids }) {
  const have = localOtids instanceof Set ? new Set(localOtids) : new Set(localOtids || []);
  const fetch = [];
  for (const r of remote || []) {
    if (!r.otid || have.has(r.otid) || !isSafeName(r.name)) continue;
    have.add(r.otid);
    fetch.push(r.name);
  }
  return fetch;
}

// Enriched plan: filenames ARE the otid on both sides, so name+size suffices.
// Size mismatch refetches because Fargate reruns rewrite enriched transcripts
// with updated speaker resolution. Never plans deletions.
function planEnrichedFetch({ remote, localSizes }) {
  const fetch = [];
  for (const { name, size } of remote || []) {
    if (!isSafeName(name)) continue;
    const localSize = localSizes ? localSizes[name] : undefined;
    if (localSize === undefined || localSize !== size) fetch.push(name);
  }
  return fetch;
}

// Extract the YYYY-MM-DD prefix from a raw otter filename, or null when the
// name ExampleCos no date (e.g. historical archive-s3-<otid>.json records).
function fileDay(name) {
  const m = /^(\d{4}-\d{2}-\d{2})-/.exec(String(name || ''));
  return m ? m[1] : null;
}

// Classify mirror freshness. `remote` is the otid listing; `localOtids` is the
// set of conversation ids present in the PC raw dir (any filename); `lastRun`
// is the mirror heartbeat (data/agent/otter-pc-mirror-latest.json), so a run
// that failed on ANY leg (e.g. enriched only) stays red until a clean run --
// the raw-otid diff alone cannot certify the whole mirror.
//   red    -- the last mirror run failed, or EC2 has at least one conversation
//             missing locally whose file is a day or more old (or undated,
//             i.e. historical). Divergence the 2-minute ingest cadence cannot
//             explain.
//   yellow -- only same-day conversations are missing (normal lag window), or
//             the remote listing was unavailable/empty/unparseable (cannot
//             prove health, must not claim it).
//   green  -- every remote conversation exists locally and the last run (if
//             any) was clean.
function classifyMirror({ remote, localOtids, today, lastRun }) {
  if (lastRun && lastRun.ok === false) {
    const legs = Object.entries(lastRun.dirs || {})
      .filter(([, r]) => r && r.ok === false)
      .map(([k, r]) => `${k}: ${r.reason || 'failed'}`)
      .join('; ');
    return {
      status: 'red',
      detail: `last otter-ec2-mirror run FAILED (${legs || 'ExampleCo leg'}); PC mirror cannot be trusted until a clean run. Heal reruns otter-ec2-mirror.js.`,
    };
  }
  if (!Array.isArray(remote)) {
    return {
      status: 'yellow',
      detail: 'EC2 raw listing unavailable -- mirror freshness unproven',
    };
  }
  if (remote.length === 0) {
    return {
      status: 'yellow',
      detail:
        'EC2 raw listing came back EMPTY -- either the canonical dir moved or the listing broke; freshness unproven',
    };
  }
  const withOtid = remote.filter((r) => r.otid);
  if (withOtid.length === 0) {
    return {
      status: 'yellow',
      detail: `EC2 raw listing has ${remote.length} files but no parseable otids -- listing or schema broke; freshness unproven`,
    };
  }
  const have = localOtids instanceof Set ? localOtids : new Set(localOtids || []);
  const missingByOtid = new Map();
  for (const r of withOtid) {
    if (!have.has(r.otid) && !missingByOtid.has(r.otid)) missingByOtid.set(r.otid, r);
  }
  const missing = [...missingByOtid.values()];
  if (missing.length === 0) {
    const uniqueOtids = new Set(withOtid.map((r) => r.otid)).size;
    return {
      status: 'green',
      detail: `PC mirror in sync (all ${uniqueOtids} EC2 raw conversations present locally)`,
    };
  }
  const dayOld = missing.filter((r) => {
    const day = fileDay(r.name);
    return day === null || day < today;
  });
  if (dayOld.length > 0) {
    const newest =
      dayOld
        .map((r) => fileDay(r.name))
        .filter(Boolean)
        .sort()
        .pop() || 'undated';
    return {
      status: 'red',
      detail: `PC otter mirror is stale: ${dayOld.length} day-old EC2 conversations missing locally (newest ${newest}); life-archive, S3 sync and contact sweeps are running on stale data. Heal runs otter-ec2-mirror.js.`,
      missing: dayOld.slice(0, 20).map((r) => r.name),
      missingCount: dayOld.length,
    };
  }
  return {
    status: 'yellow',
    detail: `${missing.length} same-day EC2 conversations not yet mirrored (inside normal lag window)`,
    missingCount: missing.length,
  };
}

module.exports = {
  isSafeName,
  parseRemoteListing,
  planRawFetch,
  planEnrichedFetch,
  fileDay,
  classifyMirror,
};
