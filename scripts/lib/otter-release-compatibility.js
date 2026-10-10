'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST_REL = 'config/otter-release-compatibility.json';
const MANIFEST_SCHEMA = 'secondbrain.otter-release-compatibility.v1';

// The receipt schema id and the manifest schema id are DERIVED from each
// other in one place (Opus review 2026-08-24, finding 7). Hardcoding the
// manifest id inside receipt validation meant a future schema bump would
// recompute the canonical digest over the wrong id and pin permanent UNKNOWN
// behind the misleading reason "digest does not match its own file rows".
function manifestToReceiptSchema(schema) {
  return String(schema).replace(/(\.v[0-9]+)$/, '-receipt$1');
}
function receiptToManifestSchema(schema) {
  return String(schema).replace(/-receipt(\.v[0-9]+)$/, '$1');
}

function normalizeRel(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function assertSafeRel(value, label) {
  const rel = normalizeRel(value);
  if (!rel || path.posix.isAbsolute(rel) || rel.split('/').includes('..')) {
    throw new Error(`unsafe ${label}: ${value}`);
  }
  return rel;
}

function readManifest(root, fsApi = fs) {
  const manifestPath = path.join(root, ...MANIFEST_REL.split('/'));
  const parsed = JSON.parse(fsApi.readFileSync(manifestPath, 'utf8'));
  if (parsed?.schema !== MANIFEST_SCHEMA) {
    throw new Error('unsupported Otter release compatibility manifest schema');
  }
  if (!Number.isInteger(parsed.compatibility_epoch) || parsed.compatibility_epoch < 1) {
    throw new Error('Otter release compatibility epoch must be a positive integer');
  }
  const roots = (parsed.roots || []).map((entry) => assertSafeRel(entry, 'manifest root'));
  const required = (parsed.required || []).map((entry) => assertSafeRel(entry, 'required path'));
  const excluded = (parsed.excluded || []).map((entry) => assertSafeRel(entry, 'excluded path'));
  const coverageSources = (parsed.coverage_sources || []).map((entry) => assertSafeRel(entry, 'coverage source'));
  const patterns = (parsed.patterns || []).map((entry) => new RegExp(String(entry)));
  if (!roots.length || !required.length || !patterns.length) {
    throw new Error('Otter release compatibility manifest must define roots, required paths, and patterns');
  }
  const requiredSet = new Set(required);
  const overlap = excluded.find((rel) => requiredSet.has(rel));
  if (overlap) throw new Error(`required Otter compatibility path cannot be excluded: ${overlap}`);
  return { parsed, roots, required, excluded, coverageSources, patterns, manifestPath };
}

function walkFiles(root, relRoot, fsApi, out) {
  const absRoot = path.join(root, ...relRoot.split('/'));
  const entries = fsApi.readdirSync(absRoot, { withFileTypes: true });
  for (const entry of entries) {
    const rel = normalizeRel(path.posix.join(relRoot, entry.name));
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walkFiles(root, rel, fsApi, out);
    } else if (entry.isFile()) {
      out.add(rel);
    }
  }
}

// This predicate is deliberately independent of the digest manifest's regex
// list. LIVE_DEPS coverage must fail when a future regex is narrowed, rather
// than using that same narrowed regex to declare its own coverage complete.
// Covers .cjs/.mjs module flavors and speaker-named runtime helpers (Opus
// review 2026-08-24, finding 4): scripts/lib/otter-dispatch-window.cjs and
// scripts/lib/speaker-freshness.js are drain-relevant runtime files that the
// js-only, otter|voice-only expressions silently excluded.
function isOtterVoiceRuntimePath(value) {
  const rel = normalizeRel(value);
  return /^(?:scripts\/|)[a-z0-9-]*(?:otter|voice|speaker)[a-z0-9-]*\.(?:js|cjs|mjs|sh|py)$/i.test(rel) ||
    /^scripts\/lib\/[a-z0-9-]*(?:otter|voice|speaker)[a-z0-9-]*\.(?:js|cjs|mjs|py)$/i.test(rel) ||
    /^scripts\/(?:deploy-ec2-server|speaker-identity-change-hook|sync-otter-speaker-intelligence-to-people-files|sync-voiceprints-to-people-files)\.(?:js|sh|py)$/i.test(rel) ||
    // recluster-publish-lock is required by the manifest but its name contains
    // neither "otter" nor "voice", so no pattern above could ever select it and
    // every EC2 deploy aborted with "required Otter compatibility path not
    // selected". Named explicitly, like the other required files whose names do
    // not carry a topic word.
    /^scripts\/lib\/(?:canonical-speaker-identity|healer-attempt-history|people-name-match|recluster-publish-lock)\.js$/i.test(rel) ||
    /^deploy\/voice-fargate\/(?:Dockerfile|entrypoint\.sh|otter-producer-contract\.json|taskdef\.json)$/i.test(rel) ||
    /^config\/otter-[a-z0-9-]+\.json$/i.test(rel);
}

// deploy-ec2-server.sh coordinates many independent subsystems. Hashing the
// whole file made a Graphiti canary edit, video deploy change, or generic
// release receipt change look like an Otter mutation and wait on both active
// call lanes. Keep the file in the protected surface, but fingerprint only the
// blocks that can alter Otter admission, lock ownership, exact-call cutover,
// ownership, or schedules. Missing anchors fail closed instead of silently
// shrinking the protected surface.
const OTTER_DEPLOY_SURFACE_REGIONS = [
  ['# An attended deploy may wait', 'DEPLOY_DATA_DIR='],
  ['if ! [[ "$OTTER_LOCK_WAIT_SECONDS"', '# A remote caller may carry'],
  ['OTTER_HEALER_LOCK_FILE=', '# DEPLOY-WINDOW MUTEX'],
  ['cleanup_deploy_locks() {', 'trap cleanup_deploy_locks EXIT'],
  ['# OTTER PUBLISH-ROUTE-DRAIN COMPATIBILITY GATE', 'if [ "$SWAP_ANYWAY" = "1" ]; then'],
  ['# Fargate publishes immutable exact-call bundles', '# Graphiti extraction crosses'],
  ['# The exact-call healer is part of the release graph', '# Several older cron installers'],
  ['# Bound the paperwork-cohort report', '# Post-release scheduled-skill rescue canary'],
];

function extractOtterDeploySurface(source) {
  const text = String(source || '').replace(/\r\n/g, '\n');
  const chunks = [];
  for (const [startMarker, endMarker] of OTTER_DEPLOY_SURFACE_REGIONS) {
    const start = text.indexOf(startMarker);
    const end = text.indexOf(endMarker, start + startMarker.length);
    if (start < 0 || end < 0) {
      throw new Error(
        `Otter deploy compatibility marker missing: ${startMarker} -> ${endMarker}`,
      );
    }
    chunks.push(text.slice(start, end));
  }

  // Backstop new Otter-shaped LIVE_DEPS or one-line coordination additions
  // outside the bounded blocks. Include immediate context so argument or path
  // changes beside a topic-bearing line cannot disappear from the digest.
  const lines = text.split('\n');
  const contextualIndexes = new Set();
  const topic = /(?:otter|exact-call|exact_call|voice[-_ ](?:efs|reference|cluster|print|embedding)|speaker[-_ ]identity)/i;
  lines.forEach((line, index) => {
    if (!topic.test(line)) return;
    for (let at = Math.max(0, index - 1); at <= Math.min(lines.length - 1, index + 1); at += 1) {
      contextualIndexes.add(at);
    }
  });
  chunks.push(
    [...contextualIndexes]
      .sort((left, right) => left - right)
      .map((index) => lines[index])
      .join('\n'),
  );
  return `${chunks.join('\n\n-- otter deploy surface --\n\n')}\n`;
}

function compatibilityBytes(rel, physicalRoot, fsApi) {
  const abs = path.join(physicalRoot, ...rel.split('/'));
  if (rel === 'scripts/deploy-ec2-server.sh') {
    return Buffer.from(extractOtterDeploySurface(fsApi.readFileSync(abs, 'utf8')), 'utf8');
  }
  return fsApi.readFileSync(abs);
}

// Transitive RELATIVE require/import closure of the selected entry scripts
// (Codex review 2026-08-24, finding D): filename selection alone left
// helpers with no topic word (host-work-admission.js is the live instance)
// executing inside deployed Otter workers while staying invisible to the
// verdict, so a semantic change there could false-MATCH the drain gate.
// Deterministic and cycle-safe; bare (node_modules) specifiers are
// runtime-shared by design and excluded, and unresolvable specifiers are
// skipped identically on both sides of the comparison.
const RELATIVE_SPECIFIER_PATTERN = /(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s+)['"]([^'"\r\n]+)['"]/g;
function collectRelativeRequireClosure(physicalRoot, fsApi, entryRels) {
  const closure = new Set();
  const queue = entryRels.filter((rel) => /\.(?:js|cjs|mjs)$/i.test(rel));
  const visited = new Set(queue);
  const isFile = (rel) => {
    try {
      return fsApi.statSync(path.join(physicalRoot, ...rel.split('/'))).isFile();
    } catch {
      return false;
    }
  };
  const resolveSpecifier = (fromRel, specifier) => {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
    if (!base || base === '.' || base.startsWith('..')) return null;
    for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}.json`, `${base}/index.js`]) {
      if (candidate.split('/').includes('node_modules')) continue;
      if (isFile(candidate)) return candidate;
    }
    return null;
  };
  while (queue.length) {
    const rel = queue.shift();
    let source;
    try {
      source = fsApi.readFileSync(path.join(physicalRoot, ...rel.split('/')), 'utf8');
    } catch {
      continue;
    }
    for (const match of source.matchAll(RELATIVE_SPECIFIER_PATTERN)) {
      const specifier = match[1];
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
      const resolved = resolveSpecifier(rel, specifier);
      if (!resolved || visited.has(resolved)) continue;
      visited.add(resolved);
      closure.add(resolved);
      if (/\.(?:js|cjs|mjs)$/i.test(resolved)) queue.push(resolved);
    }
  }
  return closure;
}

function buildOtterReleaseCompatibility({ root = DEFAULT_ROOT, fsApi = fs } = {}) {
  const physicalRoot = path.resolve(root);
  const { parsed, roots, required, excluded, coverageSources, patterns } = readManifest(physicalRoot, fsApi);
  const excludedSet = new Set(excluded);
  const discovered = new Set();
  for (const relRoot of roots) walkFiles(physicalRoot, relRoot, fsApi, discovered);
  // Required direct files may live at the release root. Add them explicitly so
  // coverage cannot depend on walking the entire checkout (and its .git tree).
  for (const rel of required) discovered.add(rel);
  const selected = [...discovered]
    // "Voice" spans recorded Otter speaker processing and the independent
    // Vapi phone stack. Exclusions remove only regex seed entries. If selected
    // Otter code imports an excluded path, the transitive closure below adds it
    // back automatically.
    .filter((rel) => !excludedSet.has(rel) && patterns.some((pattern) => pattern.test(rel)))
    .sort();

  for (const rel of required) {
    if (!selected.includes(rel)) throw new Error(`required Otter compatibility path not selected: ${rel}`);
    const abs = path.join(physicalRoot, ...rel.split('/'));
    try {
      if (!fsApi.statSync(abs).isFile()) throw new Error('not a file');
    } catch {
      throw new Error(`required Otter compatibility path is not a file: ${rel}`);
    }
  }

  // LIVE_DEPS is the deployed runtime closure. Every Otter/voice-shaped path
  // it names must be inside the semantic digest; a future manifest omission
  // therefore makes compatibility construction fail, retaining both locks.
  for (const sourceRel of coverageSources) {
    const source = fsApi.readFileSync(path.join(physicalRoot, ...sourceRel.split('/')), 'utf8');
    const start = source.indexOf('LIVE_DEPS=(');
    const end = source.indexOf('\n)', start);
    if (start < 0 || end < 0) throw new Error(`Otter compatibility coverage source has no LIVE_DEPS block: ${sourceRel}`);
    const block = source.slice(start, end);
    const runtimePaths = [...block.matchAll(/"([A-Za-z0-9._/-]+)"/g)].map((match) => normalizeRel(match[1]));
    for (const rel of runtimePaths.filter(isOtterVoiceRuntimePath).filter((rel) => !excludedSet.has(rel))) {
      if (!selected.includes(rel)) {
        throw new Error(`deployed Otter/voice compatibility path not selected: ${rel}`);
      }
    }
  }

  // The compared surface is the manifest selection PLUS the transitive
  // relative require closure of the selected entry scripts (finding D).
  const comparedRels = [
    ...new Set([...selected, ...collectRelativeRequireClosure(physicalRoot, fsApi, selected)]),
  ].sort();
  const files = comparedRels.map((rel) => {
    const bytes = compatibilityBytes(rel, physicalRoot, fsApi);
    return {
      path: rel,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    };
  });
  const canonical = JSON.stringify({
    schema: parsed.schema,
    compatibility_epoch: parsed.compatibility_epoch,
    files: files.map(({ path: rel, sha256 }) => ({ path: rel, sha256 })),
  });
  return {
    schema: manifestToReceiptSchema(parsed.schema),
    compatibility_epoch: parsed.compatibility_epoch,
    digest: crypto.createHash('sha256').update(canonical).digest('hex'),
    file_count: files.length,
    files,
    coverage_sources: coverageSources,
    excluded_seed_paths: excluded,
  };
}

const RECEIPT_SCHEMA = manifestToReceiptSchema(MANIFEST_SCHEMA);
// Version-agnostic MARKER for the SSH line scan only: any receipt-shaped
// line is judged (then rejected by validation with an honest reason when
// its version is unsupported) rather than skipped as transport noise.
const RECEIPT_SCHEMA_MARKER = 'secondbrain.otter-release-compatibility-receipt.';
const DELTA_VERDICT_SCHEMA = 'secondbrain.otter-release-delta-verdict.v1';

// GAP 2A (2026-08-24, production): the deploy gate compared the running and
// target release digests by string IDENTITY, so any probe noise, helper drift,
// or selection-list change read as DIFFERENT_OR_UNKNOWN. A docs-only deploy
// quiesced both healer lanes, and a correctness fix waited 12 minutes on a
// lane lock held by a voice recluster, while the digest could not say WHY it
// mismatched. The verdict is now conclusive from the release DELTA: the two
// receipts' per-path sha256 rows are compared, MATCH means no manifest-selected
// path differs (pinned workers drain across the swap) and carries the
// compared-path list, DIFFERENT names the exact differing selected paths, and
// UNKNOWN is reserved for genuinely unprovable states (missing manifest,
// unreadable release tree, absent or malformed running receipt), still
// quiescing both lanes, fail closed.
function validateReceiptObject(parsed, label) {
  if (parsed?.schema !== RECEIPT_SCHEMA) {
    // Only the KNOWN schema version reaches path comparison (Codex review
    // 2026-08-24, finding B, reversing the permissive half of the earlier
    // finding-7 fix): an unknown version's selection semantics are unproven,
    // so it is UNKNOWN, and the mismatch names ITSELF rather than surfacing
    // as a misleading self-digest complaint.
    return {
      error: `${label} release receipt schema ${JSON.stringify(parsed?.schema ?? null)} is not the supported ${RECEIPT_SCHEMA}`,
    };
  }
  if (!Array.isArray(parsed.files) || !parsed.files.length) {
    return { error: `${label} release receipt lists no compared files` };
  }
  const seen = new Set();
  for (const row of parsed.files) {
    if (!row || typeof row.path !== 'string' || !/^[0-9a-f]{64}$/.test(String(row.sha256 || ''))) {
      return { error: `${label} release receipt has a malformed file row` };
    }
    let rel;
    try {
      rel = assertSafeRel(row.path, 'receipt path');
    } catch {
      return { error: `${label} release receipt has an unsafe path: ${row.path}` };
    }
    // Duplicate rows would make the last-write-wins compare maps silently
    // drop a contradictory row (Codex review 6e7f7868004c, finding 4).
    if (seen.has(rel)) {
      return { error: `${label} release receipt has a duplicate path: ${rel}` };
    }
    seen.add(rel);
  }
  // Receipt integrity is MANDATORY (Codex review 1638328c6402, finding 2):
  // every real receipt carries its epoch and canonical digest, so a receipt
  // missing either was truncated or fabricated and must never MATCH.
  if (!Number.isInteger(parsed.compatibility_epoch) || parsed.compatibility_epoch < 1) {
    return { error: `${label} release receipt is missing a valid compatibility_epoch` };
  }
  if (typeof parsed.digest !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.digest)) {
    return { error: `${label} release receipt is missing a valid canonical digest` };
  }
  {
    const canonical = JSON.stringify({
      // The canonical digest is computed over the MANIFEST schema id derived
      // from this receipt's OWN schema id (see buildOtterReleaseCompatibility),
      // so a schema version bump validates against the digest it wrote.
      schema: receiptToManifestSchema(parsed.schema),
      compatibility_epoch: parsed.compatibility_epoch,
      files: parsed.files.map((row) => ({ path: row.path, sha256: row.sha256 })),
    });
    const recomputed = crypto.createHash('sha256').update(canonical).digest('hex');
    if (recomputed !== parsed.digest) {
      return { error: `${label} release receipt digest does not match its own file rows` };
    }
  }
  return { receipt: parsed };
}

function parseCompatibilityReceipt(raw, label) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: `${label} release receipt is missing or empty (release tree unprovable)` };
  }
  const trimmed = raw.trim();
  if (trimmed === 'missing') {
    return { error: `${label} release has no compatibility helper (probe printed "missing")` };
  }
  try {
    return validateReceiptObject(JSON.parse(trimmed), label);
  } catch {
    // fall through to the line scan below
  }
  // The SSH transport can wrap the single-line receipt JSON in banner or
  // profile noise on either side (Codex review f8233d0db296, finding 4). Scan
  // lines from the end: the NEWEST meaningful line is authoritative (Codex
  // review 045723f49d7c, finding 1). An invalid, tampered, or truncated
  // newest receipt line, or a newest "missing" sentinel, must return UNKNOWN
  // rather than letting an older, stale receipt in the same stream MATCH.
  const lines = trimmed.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (line === 'missing') {
      return { error: `${label} release has no compatibility helper (probe printed "missing")` };
    }
    // Only lines carrying the receipt schema marker can be receipts; anything
    // else is transport noise. A truncated receipt still carries the marker
    // (schema serializes first), so it is judged, not skipped.
    if (!line.includes(RECEIPT_SCHEMA_MARKER)) continue;
    let candidate;
    try {
      candidate = JSON.parse(line);
    } catch (error) {
      return { error: `${label} release newest receipt line is not valid JSON: ${error.message}` };
    }
    return validateReceiptObject(candidate, label);
  }
  return { error: `${label} release receipt contains no schema-valid receipt JSON line` };
}

function compareOtterReleaseReceipts(runningReceipt, targetReceipt) {
  // Key both sides on the NORMALIZED rel (Opus review 2026-08-24, finding 5):
  // validateReceiptObject accepts './scripts/lib/x.js' as safe but used to
  // discard the normalized form, so a cosmetic prefix or separator variant
  // became a two-path false DIFFERENT under raw-string keying.
  const running = new Map(runningReceipt.files.map((row) => [normalizeRel(row.path), row.sha256]));
  const target = new Map(targetReceipt.files.map((row) => [normalizeRel(row.path), row.sha256]));
  const comparedPaths = [...new Set([...running.keys(), ...target.keys()])].sort();
  const differingPaths = comparedPaths.filter((rel) => running.get(rel) !== target.get(rel));
  return { comparedPaths, differingPaths };
}

function unknownDeltaVerdict(reason, extra = {}) {
  return {
    schema: DELTA_VERDICT_SCHEMA,
    generated_at_utc: new Date().toISOString(),
    running_digest: null,
    target_digest: null,
    target_sha: null,
    compared_paths: [],
    differing_paths: [],
    verdict: 'UNKNOWN',
    quiesce_required: true,
    unknown_reason: reason,
    summary: `unprovable: ${reason}`,
    ...extra,
  };
}

// GAP 2A hardening (Codex review 71cad320a4ab, finding 1; Opus review
// 2026-08-24, finding 1): the deploy's atomic release ships `git archive` of
// the provenance-pinned sha, run ON THE DEPLOY MACHINE in $SOURCE_ROOT
// (scripts/lib/atomic-release.sh), never the mutable checkout. A dirty
// selected file in the checkout must not mint a MATCH for content that will
// not actually deploy, so the target receipt is computed from committed git
// BLOBS of the given ref. Blob bytes equal shipped bytes only because
// atomic-release.sh pins that archive with -c core.autocrlf=false -c
// core.eol=lf: unpinned, core.autocrlf=true on a Windows deploy machine
// CRLF-converted selected files lacking an eol attribute, so blob-based
// receipts read permanent false DIFFERENT after a PC deploy and false MATCH
// when a PC deploy followed an EC2 deploy. Blobs rather than a local `git
// archive` extraction also because GNU tar misreads `C:` paths as remote
// hosts on Windows.
function resolveCommitSha(root, ref) {
  return execFileSync('git', ['-C', root, 'rev-parse', `${ref}^{commit}`], {
    encoding: 'utf8',
    timeout: 30000,
  }).trim();
}

function createCommittedTreeFsApi(root, sha) {
  const prefix = path.resolve(root);
  const relOf = (value) => {
    const resolved = path.resolve(String(value));
    if (resolved === prefix) return '';
    const withSep = prefix.endsWith(path.sep) ? prefix : prefix + path.sep;
    if (!resolved.startsWith(withSep)) throw new Error(`path outside committed tree: ${value}`);
    return resolved.slice(withSep.length).split(path.sep).join('/');
  };
  const enoent = (rel) => {
    const error = new Error(`ENOENT: committed tree has no entry: ${rel}`);
    error.code = 'ENOENT';
    return error;
  };
  const listing = execFileSync('git', ['-C', prefix, 'ls-tree', '-r', '-z', '--name-only', sha], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = new Set(listing.split('\0').filter(Boolean));
  const dirs = new Set(['']);
  for (const rel of files) {
    const parts = rel.split('/');
    for (let index = 1; index < parts.length; index += 1) dirs.add(parts.slice(0, index).join('/'));
  }
  return {
    readFileSync(target, encoding) {
      const rel = relOf(target);
      if (!files.has(rel)) throw enoent(rel);
      const bytes = execFileSync('git', ['-C', prefix, 'show', `${sha}:${rel}`], {
        timeout: 120000,
        maxBuffer: 256 * 1024 * 1024,
      });
      return encoding ? bytes.toString(encoding) : bytes;
    },
    readdirSync(target) {
      const rel = relOf(target);
      if (!dirs.has(rel)) throw enoent(rel);
      const base = rel ? `${rel}/` : '';
      const children = new Map();
      for (const file of files) {
        if (!file.startsWith(base)) continue;
        const rest = file.slice(base.length);
        const slash = rest.indexOf('/');
        if (slash < 0) children.set(rest, true);
        else if (!children.has(rest.slice(0, slash))) children.set(rest.slice(0, slash), false);
      }
      return [...children.entries()].map(([name, isFile]) => ({
        name,
        isFile: () => isFile,
        isDirectory: () => !isFile,
      }));
    },
    statSync(target) {
      const rel = relOf(target);
      if (files.has(rel)) return { isFile: () => true, isDirectory: () => false };
      if (dirs.has(rel)) return { isFile: () => false, isDirectory: () => true };
      throw enoent(rel);
    },
  };
}

function buildOtterReleaseDeltaVerdict({ root = DEFAULT_ROOT, runningReceiptRaw, fsApi = fs } = {}) {
  let targetReceipt;
  try {
    targetReceipt = buildOtterReleaseCompatibility({ root, fsApi });
  } catch (error) {
    return unknownDeltaVerdict(`target release unprovable: ${error.message}`);
  }
  const parsedRunning = parseCompatibilityReceipt(runningReceiptRaw, 'running');
  if (parsedRunning.error) {
    return unknownDeltaVerdict(parsedRunning.error, { target_digest: targetReceipt.digest });
  }
  const runningDigest =
    typeof parsedRunning.receipt.digest === 'string' ? parsedRunning.receipt.digest : null;
  // Epoch equality precedes any path comparison (Codex review 2026-08-24,
  // finding B): compatibility_epoch versions the SELECTION SEMANTICS, so
  // receipts from different epochs describe incomparable surfaces and a
  // row-by-row MATCH between them proves nothing about drain safety.
  if (parsedRunning.receipt.compatibility_epoch !== targetReceipt.compatibility_epoch) {
    return unknownDeltaVerdict(
      `running compatibility_epoch ${parsedRunning.receipt.compatibility_epoch} does not equal target compatibility_epoch ${targetReceipt.compatibility_epoch}`,
      { target_digest: targetReceipt.digest, running_digest: runningDigest },
    );
  }
  const { comparedPaths, differingPaths } = compareOtterReleaseReceipts(parsedRunning.receipt, targetReceipt);
  const common = {
    schema: DELTA_VERDICT_SCHEMA,
    generated_at_utc: new Date().toISOString(),
    running_digest: runningDigest,
    target_digest: targetReceipt.digest,
    target_sha: null,
    compared_paths: comparedPaths,
    differing_paths: differingPaths,
    unknown_reason: null,
  };
  if (differingPaths.length) {
    return {
      ...common,
      verdict: 'DIFFERENT',
      quiesce_required: true,
      summary: `differing selected paths: ${differingPaths.join(', ')}`,
    };
  }
  return {
    ...common,
    verdict: 'MATCH',
    quiesce_required: false,
    summary: `compared ${comparedPaths.length} selected paths across running and target releases; none differ`,
  };
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, mode: 'json' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = path.resolve(argv[++index]);
    else if (arg === '--digest') options.mode = 'digest';
    else if (arg === '--json') options.mode = 'json';
    else if (arg === '--verdict') options.mode = 'verdict';
    else if (arg === '--running-receipt') options.runningReceiptPath = path.resolve(argv[++index]);
    else if (arg === '--receipt-out') options.receiptOutPath = path.resolve(argv[++index]);
    else if (arg === '--target-git-ref') options.targetGitRef = String(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.mode === 'verdict') {
      if (!options.runningReceiptPath) throw new Error('--verdict requires --running-receipt <file>');
      let runningReceiptRaw = null;
      try {
        runningReceiptRaw = fs.readFileSync(options.runningReceiptPath, 'utf8');
      } catch {
        // An unreadable running receipt is an unprovable running side; the
        // verdict below stays UNKNOWN and the deploy quiesces, fail closed.
        runningReceiptRaw = null;
      }
      let verdictReceipt = null;
      if (options.targetGitRef) {
        try {
          const sha = resolveCommitSha(options.root, options.targetGitRef);
          verdictReceipt = buildOtterReleaseDeltaVerdict({
            root: options.root,
            runningReceiptRaw,
            fsApi: createCommittedTreeFsApi(options.root, sha),
          });
          verdictReceipt.target_sha = sha;
        } catch (error) {
          verdictReceipt = unknownDeltaVerdict(
            `target release unprovable: committed tree ${options.targetGitRef} could not be read: ${error.message}`,
          );
        }
      } else {
        verdictReceipt = buildOtterReleaseDeltaVerdict({ root: options.root, runningReceiptRaw });
      }
      if (options.receiptOutPath) {
        fs.mkdirSync(path.dirname(options.receiptOutPath), { recursive: true });
        fs.appendFileSync(options.receiptOutPath, `${JSON.stringify(verdictReceipt)}\n`);
      }
      process.stdout.write(`${JSON.stringify(verdictReceipt)}\n`);
      return;
    }
    const receipt = buildOtterReleaseCompatibility({ root: options.root });
    process.stdout.write(options.mode === 'digest' ? `${receipt.digest}\n` : `${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`[otter-release-compatibility] ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  DELTA_VERDICT_SCHEMA,
  MANIFEST_REL,
  RECEIPT_SCHEMA,
  assertSafeRel,
  buildOtterReleaseCompatibility,
  buildOtterReleaseDeltaVerdict,
  compareOtterReleaseReceipts,
  createCommittedTreeFsApi,
  extractOtterDeploySurface,
  isOtterVoiceRuntimePath,
  parseCompatibilityReceipt,
  readManifest,
  unknownDeltaVerdict,
};
