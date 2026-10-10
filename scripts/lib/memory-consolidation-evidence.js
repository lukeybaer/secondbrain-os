#!/usr/bin/env node
'use strict';

// Evidence layer for the weekly memory-consolidation pass. A review manifest
// proves only that files existed. This module performs bounded, reproducible
// checks over that exact hash-bound population so the report cannot accept a
// bare "reviewed N files" assertion as proof.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isActiveMemoryContent } = require('./memory-active-filter.js');
const { auditMemoryDir } = require('./memory-hygiene-audit.js');

const REPO = path.resolve(__dirname, '..', '..');
const DIMENSIONS = Object.freeze([
  'duplicate_overlap',
  'contradiction',
  'supersession',
  'staleness',
  'retrieval_utility',
  'contacts',
  'skills',
  'archive',
  'provenance',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function stableManifestRows(reviewManifest) {
  return (reviewManifest?.files || [])
    .map((row) => ({
      path: normalizePath(row.path),
      scope: String(row.scope || ''),
      status: String(row.status || ''),
      superseded_by: row.superseded_by || null,
      content_sha256: String(row.content_sha256 || ''),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function reviewManifestSha256(reviewManifest) {
  return sha256(JSON.stringify(stableManifestRows(reviewManifest)));
}

function frontmatter(raw) {
  const match = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { block: '', body: String(raw || ''), scalars: {} };
  const scalars = {};
  for (const line of match[1].split(/\r?\n/)) {
    const scalar = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (scalar) scalars[scalar[1]] = scalar[2].replace(/^['"]|['"]$/g, '');
  }
  return { block: match[1], body: match[2], scalars };
}

function listMarkdown(root) {
  const out = [];
  const visit = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(full);
    }
  };
  visit(root);
  return out.sort();
}

function readRows(repoRoot, reviewManifest) {
  return stableManifestRows(reviewManifest).map((manifestRow) => {
    const file = path.join(repoRoot, manifestRow.path);
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      raw = '';
    }
    const parsed = frontmatter(raw);
    return {
      ...manifestRow,
      file,
      raw,
      body: parsed.body,
      meta: parsed.scalars,
      active:
        manifestRow.scope !== 'archive' &&
        (!manifestRow.path.startsWith('memory/') || isActiveMemoryContent(raw)),
    };
  });
}

function normalizeBody(body) {
  return String(body || '')
    .toLowerCase()
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedPersonName(value) {
  const cleaned = String(value || '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\s+\(last name captured.*$/i, '')
    .trim();
  const terms = cleaned.toLowerCase().match(/[a-z0-9]+/g) || [];
  if (terms.length < 2) return '';
  return terms.join('');
}

function contactNames(raw) {
  const names = [];
  const heading = String(raw || '').match(/^#\s+(.+?)\s*$/m);
  if (heading) names.push(heading[1]);
  const contact = String(raw || '').match(/^-\s+\*\*Name\*\*:\s*(.+?)\s*$/m);
  if (contact) names.push(contact[1]);
  return [...new Set(names.map(normalizedPersonName).filter(Boolean))];
}

function yamlList(block, key) {
  const lines = String(block || '').split(/\r?\n/);
  const out = [];
  let collecting = false;
  for (const line of lines) {
    if (new RegExp(`^${key}:\\s*$`).test(line)) {
      collecting = true;
      continue;
    }
    if (!collecting) continue;
    const item = line.match(/^\s+-\s+(.+?)\s*$/);
    if (item) out.push(item[1].replace(/^['"]|['"]$/g, ''));
    else if (/^[A-Za-z0-9_-]+:/.test(line)) break;
  }
  return out;
}

function titleTerms(row) {
  const source = `${path.basename(row.path, '.md')} ${row.meta.name || ''}`
    .toLowerCase()
    .replace(/^(feedback|reference|project|user)[_-]/, '')
    .match(/[a-z0-9]+/g) || [];
  const stop = new Set(['feedback', 'reference', 'project', 'user', 'memory', 'amy', 'the', 'and']);
  return [...new Set(source.filter((term) => term.length > 2 && !stop.has(term)))].slice(0, 8);
}

function titleFindability(activeTopLevel) {
  const misses = [];
  for (const target of activeTopLevel) {
    const terms = titleTerms(target);
    if (!terms.length) continue;
    const scored = activeTopLevel
      .map((candidate) => {
        const haystack = `${path.basename(candidate.path, '.md')} ${candidate.meta.name || ''} ${candidate.meta.description || ''}`.toLowerCase();
        const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
        return { path: candidate.path, score };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const rank = scored.findIndex((row) => row.path === target.path) + 1;
    if (rank === 0 || rank > 8) misses.push({ path: target.path, rank: rank || null, terms });
  }
  return misses;
}

function finding(id, dimension, severity, title, files, summary, recommendedAction) {
  const uniqueFiles = [...new Set(files)].sort();
  return {
    id,
    dimension,
    severity,
    status: 'open',
    title,
    count: uniqueFiles.length,
    files: uniqueFiles,
    summary,
    recommended_action: recommendedAction,
  };
}

function check(id, dimension, population, failures, findingIds, limitation = '') {
  return {
    id,
    dimension,
    coverage_mode: 'exhaustive_mechanical',
    population,
    examined: population,
    failures,
    finding_ids: findingIds,
    limitation,
  };
}

function buildMemoryConsolidationEvidence(opts = {}) {
  const repoRoot = path.resolve(opts.repoRoot || REPO);
  const reviewManifest = opts.reviewManifest || { files: [] };
  const now = opts.now ? opts.now() : new Date();
  const rows = readRows(repoRoot, reviewManifest);
  const topLevel = rows.filter(
    (row) => row.scope === 'top_level_memory' && !/\/(?:MEMORY|RULES_INDEX)\.md$/i.test(row.path),
  );
  const activeTopLevel = topLevel.filter((row) => row.active);
  const contacts = rows.filter((row) => row.scope === 'contacts' && row.active);
  const skills = rows.filter((row) => row.scope === 'skills');
  const archives = rows.filter((row) => row.scope === 'archive');
  const coreDocs = rows.filter((row) => row.scope === 'core_docs');
  const findings = [];
  const checks = [];

  const redirectRows = activeTopLevel.filter((row) =>
    /this file is a pointer, not an authority/i.test(row.body),
  );
  if (redirectRows.length) {
    findings.push(
      finding(
        'MEM-LIFECYCLE-ACTIVE-REDIRECT',
        'supersession',
        'red',
        'Retired redirect files are still active memory',
        redirectRows.map((row) => row.path),
        'Files that say they are not authoritative still flow through active-memory retrieval.',
        'Archive the retired body and leave a status:superseded, superseded_by, stub:true redirect.',
      ),
    );
  }
  const canonicalRedirects = redirectRows.filter(
    (row) => String(row.meta.canonical || '').toLowerCase() === 'true',
  );
  if (canonicalRedirects.length) {
    findings.push(
      finding(
        'MEM-LIFECYCLE-CANONICAL-REDIRECT',
        'contradiction',
        'red',
        'A non-authoritative redirect is marked canonical',
        canonicalRedirects.map((row) => row.path),
        'The same record declares both canonical authority and non-authoritative pointer status.',
        'Retire the record and keep the real component document as the authority.',
      ),
    );
  }
  checks.push(
    check(
      'check-active-redirect-lifecycle',
      'supersession',
      activeTopLevel.length,
      redirectRows.length,
      redirectRows.length ? ['MEM-LIFECYCLE-ACTIVE-REDIRECT'] : [],
    ),
    check(
      'check-canonical-pointer-conflicts',
      'contradiction',
      activeTopLevel.length,
      canonicalRedirects.length,
      canonicalRedirects.length ? ['MEM-LIFECYCLE-CANONICAL-REDIRECT'] : [],
      'This mechanical check catches explicit authority conflicts. Semantic contradictions still require the hash-bound review sample.',
    ),
  );

  const authorityRows = [...activeTopLevel, ...coreDocs];
  const stalePolicyRows = authorityRows.filter((row) => {
    const first = row.raw.slice(0, 900);
    if (/2026-08-(?:05|16) POLICY UPDATE/i.test(first)) return false;
    const unsafeLines = row.raw
      .split(/\r?\n/)
      .filter(
        (line) =>
          /charged OpenAI(?: API)?(?: answer)? (?:auto-?fallback|floor)|model\.provider:\s*openai|gpt-4o receptionist|dials ExampleCo back with the answer when .* finishes|only paid exception.*briefing|Vapi.*paid.*disabled/i.test(
            line,
          ) &&
          !/revoked|superseded|histor(?:y|ical)/i.test(line) &&
          !/auth-voice-paid-fallback|outside.*(?:live[- ]voice|voice-only)|separately.*(?:live[- ]voice|voice-only)/i.test(
            line,
          ),
      );
    return unsafeLines.length > 0;
  });
  if (stalePolicyRows.length) {
    findings.push(
      finding(
        'MEM-AUTHORITY-STALE-POLICY',
        'contradiction',
        'red',
        'Active memory asserts a superseded paid-model or callback policy',
        stalePolicyRows.map((row) => row.path),
        'The active record conflicts with the current paid-model blood gate or owner callback constitution.',
        'Update the still-valid rule or retire the obsolete architecture record to the current authority.',
      ),
    );
  }
  checks.push(
    check(
      'check-protected-authority-conflicts',
      'contradiction',
      authorityRows.length,
      stalePolicyRows.length,
      stalePolicyRows.length ? ['MEM-AUTHORITY-STALE-POLICY'] : [],
      'This check enforces only high-risk paid-model and callback claims whose current authority is explicit, including canonical core targets.',
    ),
  );

  const bodyGroups = new Map();
  for (const row of activeTopLevel) {
    const body = normalizeBody(row.body);
    if (body.length < 80) continue;
    const key = sha256(body);
    if (!bodyGroups.has(key)) bodyGroups.set(key, []);
    bodyGroups.get(key).push(row.path);
  }
  const duplicateBodies = [...bodyGroups.values()].filter((group) => group.length > 1);
  if (duplicateBodies.length) {
    findings.push(
      finding(
        'MEM-DUPLICATE-EXACT-BODY',
        'duplicate_overlap',
        'yellow',
        'Active memories have identical normalized bodies',
        duplicateBodies.flat(),
        `${duplicateBodies.length} exact-body group(s) remain active.`,
        'Merge or explain each group. Boilerplate redirects must be retired before similarity clustering.',
      ),
    );
  }
  checks.push(
    check(
      'check-exact-active-bodies',
      'duplicate_overlap',
      activeTopLevel.length,
      duplicateBodies.length,
      duplicateBodies.length ? ['MEM-DUPLICATE-EXACT-BODY'] : [],
      'Exact-body comparison is exhaustive; paraphrase detection remains in the semantic cluster adjudication.',
    ),
  );

  const byContactName = new Map();
  for (const row of contacts) {
    if (/\/(?:INDEX|_[^/]+)\.md$/i.test(row.path)) continue;
    for (const name of contactNames(row.raw)) {
      if (!byContactName.has(name)) byContactName.set(name, new Set());
      byContactName.get(name).add(row.path);
    }
  }
  const duplicateContacts = [...byContactName.values()]
    .map((group) => [...group])
    .filter((group) => group.length > 1);
  if (duplicateContacts.length) {
    findings.push(
      finding(
        'MEM-CONTACT-DUPLICATE-NAME',
        'contacts',
        'yellow',
        'The same full contact name appears in multiple active People files',
        duplicateContacts.flat(),
        `${duplicateContacts.length} exact normalized full-name group(s) need one canonical identity or an explicit homonym distinction.`,
        'Merge only with corroborating identity evidence; otherwise ask one discriminator question.',
      ),
    );
  }

  const contactByBasename = new Map(
    contacts.map((row) => [path.basename(row.path, '.md').toLowerCase(), row]),
  );
  const replacedStillActive = [];
  for (const row of contacts) {
    const parsed = frontmatter(row.raw);
    for (const replaced of yamlList(parsed.block, 'replaces')) {
      const old = contactByBasename.get(String(replaced).toLowerCase());
      if (old?.active) replacedStillActive.push(old.path);
    }
  }
  if (replacedStillActive.length) {
    findings.push(
      finding(
        'MEM-CONTACT-REPLACED-STILL-ACTIVE',
        'contacts',
        'red',
        'A contact file explicitly replaced by current files is still active',
        replacedStillActive,
        'The replacement relation exists, but the older combined identity still participates in retrieval.',
        'Archive the replaced record and leave a superseded redirect to the current People files.',
      ),
    );
  }
  checks.push(
    check(
      'check-contact-identity-collisions',
      'contacts',
      contacts.length,
      duplicateContacts.length + replacedStillActive.length,
      [
        ...(duplicateContacts.length ? ['MEM-CONTACT-DUPLICATE-NAME'] : []),
        ...(replacedStillActive.length ? ['MEM-CONTACT-REPLACED-STILL-ACTIVE'] : []),
      ],
      'Exact full-name and explicit replacement checks are exhaustive. First-name-only matches remain human-review candidates.',
    ),
  );

  const skillNameGroups = new Map();
  const skillFiles = skills.filter((row) => /\/SKILL\.md$/i.test(row.path));
  for (const row of skillFiles) {
    const name = String(row.meta.name || '').trim().toLowerCase();
    if (!name) continue;
    if (!skillNameGroups.has(name)) skillNameGroups.set(name, []);
    skillNameGroups.get(name).push(row.path);
  }
  const duplicateSkills = [...skillNameGroups.values()].filter((group) => group.length > 1);
  if (duplicateSkills.length) {
    findings.push(
      finding(
        'MEM-SKILL-DUPLICATE-NAME',
        'skills',
        'yellow',
        'Multiple skills declare the same invocation name',
        duplicateSkills.flat(),
        `${duplicateSkills.length} duplicate skill-name group(s) can make routing ambiguous.`,
        'Give each capability one invocation name or document a deliberate alias.',
      ),
    );
  }
  checks.push(
    check(
      'check-skill-invocation-names',
      'skills',
      skillFiles.length,
      duplicateSkills.length,
      duplicateSkills.length ? ['MEM-SKILL-DUPLICATE-NAME'] : [],
    ),
  );

  const archiveBasenames = new Set(
    archives.map((row) => path.basename(row.path).replace(/^\d{4}-\d{2}-\d{2}_/, '').toLowerCase()),
  );
  const resurrected = activeTopLevel.filter((row) =>
    archiveBasenames.has(path.basename(row.path).toLowerCase()),
  );
  if (resurrected.length) {
    findings.push(
      finding(
        'MEM-ARCHIVE-ACTIVE-COLLISION',
        'archive',
        'yellow',
        'An active file shares an identity with an archived record',
        resurrected.map((row) => row.path),
        'The active and archived copies need an explicit revision or resurrection explanation.',
        'Confirm the active file is a newer revision; otherwise retire it as accidental resurrection.',
      ),
    );
  }
  checks.push(
    check(
      'check-archive-active-collisions',
      'archive',
      archives.length + activeTopLevel.length,
      resurrected.length,
      resurrected.length ? ['MEM-ARCHIVE-ACTIVE-COLLISION'] : [],
    ),
  );

  const staleCandidates = activeTopLevel.filter((row) => {
    const status = String(row.meta.status || '').trim().toLowerCase();
    if (/^(?:retired|historical|stale)$/.test(status)) return true;
    const opening = row.body.slice(0, 500);
    return /(?:^|\n)\s*(?:>\s*)?(?:this (?:file|record) is )?(?:retired|historical only|stale and inactive)\b|this file is a pointer, not an authority/i.test(
      opening,
    );
  });
  if (staleCandidates.length) {
    findings.push(
      finding(
        'MEM-STALENESS-MARKER-ACTIVE',
        'staleness',
        'info',
        'Active memory opens by declaring itself retired, historical, or stale',
        staleCandidates.map((row) => row.path),
        'A current retrieval record should not open by declaring that the whole record is inactive.',
        'Add lifecycle metadata and archive the body, or rewrite the opening to identify the still-current rule.',
      ),
    );
  }
  checks.push(
    check(
      'check-active-staleness-markers',
      'staleness',
      activeTopLevel.length,
      staleCandidates.length,
      staleCandidates.length ? ['MEM-STALENESS-MARKER-ACTIVE'] : [],
      'This check intentionally ignores ordinary discussion of stale data and historical incidents to avoid alert fatigue.',
    ),
  );

  const findabilityMisses = titleFindability(activeTopLevel);
  if (findabilityMisses.length) {
    findings.push(
      finding(
        'MEM-RETRIEVAL-TITLE-MISS',
        'retrieval_utility',
        'yellow',
        'A memory is not in the top eight results for its own title terms',
        findabilityMisses.map((row) => row.path),
        `${findabilityMisses.length} title-derived retrieval probe(s) missed the source record.`,
        'Improve titles, metadata, or indexing, then rerun the probes.',
      ),
    );
  }
  checks.push(
    check(
      'check-title-findability',
      'retrieval_utility',
      activeTopLevel.length,
      findabilityMisses.length,
      findabilityMisses.length ? ['MEM-RETRIEVAL-TITLE-MISS'] : [],
      'Title-derived probes test basic findability. Goal-oriented and temporal retrieval require a separate stratified sample.',
    ),
  );

  const hygiene = auditMemoryDir({
    repoRoot,
    memoryDir: path.join(repoRoot, 'memory'),
  });
  if (hygiene.orphans?.length) {
    findings.push(
      finding(
        'MEM-RETRIEVAL-UNINDEXED-INVENTORY',
        'retrieval_utility',
        'info',
        'Top-level memories are not explicitly routed by Tier 1 indexes',
        hygiene.orphans.map((name) => `memory/${name}`),
        'Tier 1 is intentionally capped, so this is inventory for retrieval sampling, not an automatic defect.',
        'Include high-value current records in the goal-oriented retrieval sample before deciding whether to add routing.',
      ),
    );
  }

  const mismatchedHashes = rows.filter(
    (row) =>
      !/^[0-9a-f]{64}$/i.test(row.content_sha256) || sha256(row.raw) !== row.content_sha256,
  );
  if (mismatchedHashes.length) {
    findings.push(
      finding(
        'MEM-PROVENANCE-CONTENT-MISMATCH',
        'provenance',
        'red',
        'Review manifest content hashes do not match the corpus on disk',
        mismatchedHashes.map((row) => row.path),
        'The evidence run read content that was missing or different from the content declared by the scan manifest.',
        'Regenerate the scan manifest and evidence from the final corpus before publishing a result.',
      ),
    );
  }
  checks.push(
    check(
      'check-provenance-content-hashes',
      'provenance',
      rows.length,
      mismatchedHashes.length,
      mismatchedHashes.length ? ['MEM-PROVENANCE-CONTENT-MISMATCH'] : [],
      'Every manifest hash is recomputed from disk. Source reliability still requires semantic inspection.',
    ),
  );

  for (const dimension of DIMENSIONS) {
    if (!checks.some((row) => row.dimension === dimension)) {
      throw new Error(`evidence builder has no check for ${dimension}`);
    }
  }

  const counts = findings.reduce(
    (acc, row) => {
      acc[`open_${row.severity}`] = (acc[`open_${row.severity}`] || 0) + 1;
      return acc;
    },
    { open_red: 0, open_yellow: 0, open_info: 0 },
  );
  return {
    schema: 'amy.memory_consolidation_evidence.v1',
    status: 'complete',
    generated_at: now.toISOString(),
    manifest_sha256: reviewManifestSha256(reviewManifest),
    population: {
      manifest_files: rows.length,
      active_top_level_memory: activeTopLevel.length,
      contacts: contacts.length,
      skill_documents: skills.length,
      archive: archives.length,
      core_docs: coreDocs.length,
    },
    counts: { checks: checks.length, findings: findings.length, ...counts },
    checks,
    findings,
  };
}

function writeMemoryConsolidationEvidence(opts = {}) {
  const repoRoot = path.resolve(opts.repoRoot || REPO);
  const clustersPath =
    opts.clustersPath || path.join(repoRoot, 'data', 'agent', 'memory-consolidation-clusters.json');
  const outPath =
    opts.outPath || path.join(repoRoot, 'data', 'agent', 'memory-consolidation-evidence.json');
  const clusters = JSON.parse(fs.readFileSync(clustersPath, 'utf8'));
  if (!clusters.review_manifest) throw new Error('clusters input has no review_manifest');
  const evidence = buildMemoryConsolidationEvidence({
    repoRoot,
    reviewManifest: clusters.review_manifest,
    now: opts.now,
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  return { outPath, evidence };
}

module.exports = {
  DIMENSIONS,
  buildMemoryConsolidationEvidence,
  reviewManifestSha256,
  writeMemoryConsolidationEvidence,
};

if (require.main === module) {
  const out = writeMemoryConsolidationEvidence({ outPath: process.argv[2] || undefined });
  process.stdout.write(
    `memory-consolidation-evidence: ${out.evidence.counts.checks} checks, ` +
      `${out.evidence.counts.findings} findings -> ${out.outPath}\n`,
  );
}
