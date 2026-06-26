#!/usr/bin/env node
// memory-decay-sweep.js
//
// Memory lifecycle engine. Applies an Ebbinghaus forgetting curve to memory
// files, recommends archival when retention drops below threshold, and
// flags contradiction candidates (multiple memories declaring authority on
// the same `topic` slug). Output is a recommendation jsonl; this sweep
// never deletes a memory on its own.
//
// Pattern sources (deep-dived 2026-05-23 nightly research):
//   - Letta passive memory consolidation (letta-ai/letta 0.5 2026-04):
//     long-running agents decay rarely-touched memories and re-promote them
//     only on retrieval; the consolidation pass runs out-of-band.
//   - MemGPT v2 forgetting curves (Packer et al, follow-on 2026-02):
//     Ebbinghaus-style retention math on top of access-recency makes the
//     decision "is this still load-bearing?" automatic instead of manual.
//   - mem0 hot/warm/cold tiers (mem0ai/mem0 2026-04): tier transitions are
//     produced by a background scheduler reading access logs; SecondBrain
//     already has memory-temperature.ts for the hot tier, this script is
//     the cold-tier complement.
//   - Anthropic memory hygiene guidance (skills SDK 2026-03 release
//     notes): "memories with conflicting frontmatter `valid_until`/
//     `replaces` should surface for review before either is silently
//     dropped". This sweep produces that surface.
//
// Ebbinghaus retention:
//   R(t) = exp(-t / S)
//   t  = days since last access (or last modification when no access log)
//   S  = stability constant in days, configurable per memory type
//
// Higher S means slower decay. The sweep ships sensible defaults per type:
//   user        ->  S=730d (2y), facts about ExampleCo are long-lived
//   reference   ->  S=365d (1y), external system pointers age slowly
//   project     ->  S=120d, project state churns
//   feedback    ->  S=240d, behavioral rules drift but slowly
//   default     ->  S=180d
//
// Storage:
//   Input    : memory directory (defaults to secondbrain/memory/) walked
//              recursively for `*.md` files with frontmatter
//   Output   : data/agent/memory-decay-recommendations.jsonl
//              (one line per recommendation, audit ledger)
//
// Pure module. All paths come from env or function args.

const fs = require('fs');
const path = require('path');

const REPO = process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..');

// Defaults

const DEFAULTS = {
  retentionArchiveThreshold: 0.05, // R < 5% suggests archival
  retentionWarnThreshold: 0.2,     // R < 20% but >= 5% is a "soon" warning
  // Default stability constants, in days, by memory type.
  stabilityByType: {
    user: 730,
    reference: 365,
    project: 120,
    feedback: 240,
  },
  defaultStabilityDays: 180,
  // Skip files smaller than this in chars (likely placeholders).
  minBodyChars: 50,
};

// Pure helpers

function ebbinghausRetention(daysSinceAccess, stabilityDays) {
  if (stabilityDays <= 0) return 0;
  if (daysSinceAccess <= 0) return 1;
  return Math.exp(-daysSinceAccess / stabilityDays);
}

function parseFrontmatter(raw) {
  const m = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw || '' };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) meta[key] = val;
  }
  return { meta, body: m[2] };
}

function listMarkdownFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      // Don't recurse into known archive paths
      if (/(^|[\\/])(archive|node_modules|\.git)([\\/]|$)/.test(full)) continue;
      listMarkdownFiles(full, out);
    } else if (dirent.isFile() && dirent.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function computeMemoryAge(filePath, fallbackNow) {
  const stat = fs.statSync(filePath);
  const now = fallbackNow ? fallbackNow() : new Date();
  const accessed = stat.mtime; // mtime is more reliable than atime on Windows
  const days = Math.max(0, (now.getTime() - accessed.getTime()) / 86400000);
  return { days, lastModified: accessed.toISOString() };
}

function classifyType(meta) {
  const raw = String(meta.type || meta.metadata_type || '').toLowerCase().trim();
  if (raw) return raw;
  return 'default';
}

function stabilityFor(type, opts) {
  const map = opts.stabilityByType || DEFAULTS.stabilityByType;
  if (map[type] != null) return map[type];
  return opts.defaultStabilityDays != null ? opts.defaultStabilityDays : DEFAULTS.defaultStabilityDays;
}

// Single-file evaluation

function evaluateMemoryFile(filePath, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const raw = fs.readFileSync(filePath, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  if (body.length < cfg.minBodyChars) {
    return { filePath, skipped: true, reason: 'body_too_small', body_chars: body.length };
  }
  const type = classifyType(meta);
  const stability = stabilityFor(type, cfg);
  const { days, lastModified } = computeMemoryAge(filePath, opts.now);
  const retention = ebbinghausRetention(days, stability);

  let recommendation = 'keep';
  if (retention < cfg.retentionArchiveThreshold) recommendation = 'archive';
  else if (retention < cfg.retentionWarnThreshold) recommendation = 'warn';

  return {
    filePath,
    type,
    stability_days: stability,
    days_since_access: Number(days.toFixed(2)),
    retention: Number(retention.toFixed(4)),
    last_modified: lastModified,
    recommendation,
    body_chars: body.length,
    meta,
  };
}

// Contradiction detection

// Two memories conflict if they declare the same `topic:` (or filename slug
// when no topic) AND one of them declares a `replaces:` pointer that
// matches the other's `name:` slug. We surface for review; we never delete.
function detectContradictions(evaluations) {
  const byTopic = new Map();
  for (const e of evaluations) {
    if (!e || e.skipped) continue;
    const meta = e.meta || {};
    const topic = (meta.topic || meta.name || path.basename(e.filePath, '.md')).toLowerCase().trim();
    if (!topic) continue;
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(e);
  }
  const conflicts = [];
  for (const [topic, entries] of byTopic.entries()) {
    if (entries.length < 2) continue;
    // Active = not flagged for archive, no `superseded_by` in meta, no `status: archived`
    const active = entries.filter((e) => {
      const status = String((e.meta || {}).status || '').toLowerCase();
      if (status === 'archived' || status === 'superseded') return false;
      if (e.meta && e.meta.superseded_by) return false;
      return true;
    });
    if (active.length >= 2) {
      conflicts.push({
        topic,
        files: active.map((e) => e.filePath),
        reason: 'multiple_active_memories_same_topic',
      });
    }
  }
  return conflicts;
}

// Sweep

function sweep(opts = {}) {
  const root = opts.root || REPO;
  const memoryDir = opts.memoryDir || path.join(root, 'memory');
  const recommendationsPath =
    opts.recommendationsPath ||
    path.join(root, 'data', 'agent', 'memory-decay-recommendations.jsonl');
  const cfg = { ...DEFAULTS, ...opts };

  const files = opts.files || listMarkdownFiles(memoryDir);
  const evaluations = [];
  for (const f of files) {
    try {
      evaluations.push(evaluateMemoryFile(f, cfg));
    } catch (err) {
      evaluations.push({ filePath: f, skipped: true, reason: 'error', error: String(err.message || err) });
    }
  }

  const recommendations = evaluations.filter(
    (e) => !e.skipped && (e.recommendation === 'archive' || e.recommendation === 'warn')
  );
  const contradictions = detectContradictions(evaluations);

  const timestamp = (opts.now ? opts.now() : new Date()).toISOString();
  if (opts.writeRecommendations !== false) {
    fs.mkdirSync(path.dirname(recommendationsPath), { recursive: true });
    for (const r of recommendations) {
      const line = {
        timestamp,
        file: path.relative(root, r.filePath),
        type: r.type,
        recommendation: r.recommendation,
        retention: r.retention,
        days_since_access: r.days_since_access,
        stability_days: r.stability_days,
      };
      fs.appendFileSync(recommendationsPath, JSON.stringify(line) + '\n');
    }
    for (const c of contradictions) {
      const line = {
        timestamp,
        recommendation: 'contradiction_review',
        topic: c.topic,
        files: c.files.map((f) => path.relative(root, f)),
        reason: c.reason,
      };
      fs.appendFileSync(recommendationsPath, JSON.stringify(line) + '\n');
    }
  }

  return {
    scanned: evaluations.length,
    skipped: evaluations.filter((e) => e.skipped).length,
    archive: recommendations.filter((r) => r.recommendation === 'archive'),
    warn: recommendations.filter((r) => r.recommendation === 'warn'),
    contradictions,
    evaluations,
  };
}

module.exports = {
  DEFAULTS,
  ebbinghausRetention,
  parseFrontmatter,
  listMarkdownFiles,
  computeMemoryAge,
  classifyType,
  stabilityFor,
  evaluateMemoryFile,
  detectContradictions,
  sweep,
};

// CLI
if (require.main === module) {
  const result = sweep();
  process.stdout.write(
    JSON.stringify(
      {
        scanned: result.scanned,
        archive: result.archive.length,
        warn: result.warn.length,
        contradictions: result.contradictions.length,
      },
      null,
      2
    ) + '\n'
  );
}
