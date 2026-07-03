#!/usr/bin/env node
'use strict';

// kingdom-grounding-pool.js
//
// Assembles a pool of REAL facts, quotes, and details from ExampleCo's own life for
// the daily KINGDOM EQUIPPING IDEAS briefing card
// (scripts/kingdom-equipping-ideas.js). Same anti-fabrication contract as
// scripts/lib/ExampleCo-quote-pool.js (comm-coaching): every fact in the pool
// ExampleCos a real source name that must exist on disk, and the generator may
// only cite facts drawn from this pool by id. We never invent a source.
//
// ExampleCo's ask (2026-07-02): kingdom equipping ideas must "traverse the millions
// of concepts and features and quotes and projects and details" from his real
// life, not repeat, and connect concepts across domains. This pool is the
// traversal: it samples broadly across memory files, contacts, and recent
// Otter transcripts, rotated by a date seed so the same handful of files are
// not sampled every day.
//
// Sources:
//   1. lifeGoals    -- memory/ExampleCo_life_goals_current.md (north star, strategic goals)
//   2. profile      -- memory/user_profile.md (identity, health, work)
//   3. companies    -- memory/user_companies.md (ExampleCo, BAI, ITM, SecondBrain, Snack Dude)
//   4. family       -- memory/user_wife_family.md (PRIVATE_NAME, immigration, baby planning)
//   5. contacts     -- memory/contacts/*.md (people ExampleCo actually knows), sampled and rotated
//   6. transcripts  -- Otter enriched/raw transcripts (recent), real spoken lines

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function cleanText(raw) {
  return String(raw || '')
    .replace(/[­​‌‍͏⁠﻿]/g, '')
    .replace(/[ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSubstantiveFact(text) {
  const t = cleanText(text);
  if (t.length < 25 || t.length > 500) return false;
  const letters = (t.match(/[a-zA-Z]/g) || []).length;
  if (letters < t.length * 0.4) return false;
  return t.split(' ').filter(Boolean).length >= 5;
}

// Deterministic seed from the CT date so sampling rotates day to day without a
// persisted counter, matching kingdom-equipping-ideas.js's dayOffset pattern.
function dateSeed(date) {
  const digits = String(date || '').replace(/\D/g, '');
  let n = 0;
  for (const ch of digits) n = (n + Number(ch)) % 100003;
  return n || 1;
}

// Small deterministic shuffle keyed by the date seed so different days sample
// different slices of a large list (e.g. contacts/*.md) without randomness.
function seededRotate(list, seed) {
  const n = list.length;
  if (n <= 1) return list.slice();
  const offset = seed % n;
  return [...list.slice(offset), ...list.slice(0, offset)];
}

// ---- Markdown bullet extractor: pull "- **Bold label**: rest of fact" or
// "- rest of fact" bullets out of a memory file, tagged with the section
// heading they fall under so each fact ExampleCos real, checkable context.
function extractBullets(md, sourceFile, sourceLabel) {
  const out = [];
  let heading = '';
  for (const line of String(md || '').split(/\r?\n/)) {
    const h = line.match(/^#{1,3}\s+(.+)$/);
    if (h) {
      heading = cleanText(h[1]);
      continue;
    }
    const b = line.match(/^\s*-\s+(.+)$/);
    if (!b) continue;
    const text = cleanText(b[1]).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    if (!isSubstantiveFact(text)) continue;
    out.push({ text, heading, sourceFile, sourceLabel });
  }
  return out;
}

function loadMemoryFile(relPath, sourceLabel, root) {
  const abs = path.join(root, relPath);
  const md = safe(() => fs.readFileSync(abs, 'utf8'), '');
  if (!md) return [];
  return extractBullets(md, relPath.replace(/\\/g, '/'), sourceLabel);
}

// ---- Contacts: sample a rotating slice of memory/contacts/*.md so different
// real people show up in different days' ideas instead of the same handful.
function loadContactFacts(root, seed, sampleCount = 12) {
  const dir = path.join(root, 'memory', 'contacts');
  const files = safe(
    () =>
      fs
        .readdirSync(dir)
        .filter((f) => /\.md$/i.test(f) && !f.startsWith('_') && f.toLowerCase() !== 'index.md'),
    [],
  );
  if (!files.length) return [];
  const rotated = seededRotate(files.sort(), seed);
  const sampled = rotated.slice(0, sampleCount);
  const out = [];
  for (const f of sampled) {
    const abs = path.join(dir, f);
    const md = safe(() => fs.readFileSync(abs, 'utf8'), '');
    if (!md) continue;
    const nameMatch = md.match(/^name:\s*(.+)$/m);
    const name = nameMatch ? cleanText(nameMatch[1]) : f.replace(/\.md$/i, '');
    const descMatch = md.match(/^description:\s*(.+)$/m);
    if (descMatch) {
      const text = cleanText(descMatch[1]);
      if (isSubstantiveFact(text)) {
        out.push({
          text: `${name}: ${text}`,
          heading: 'contact',
          sourceFile: `memory/contacts/${f}`,
          sourceLabel: `contact file (${name})`,
        });
      }
    }
    const bullets = extractBullets(md, `memory/contacts/${f}`, `contact file (${name})`).slice(
      0,
      2,
    );
    for (const b of bullets) out.push({ ...b, text: `${name}: ${b.text}` });
  }
  return out;
}

// ---- Otter transcripts: real spoken lines from recent calls/meetings. Checks
// both the repo-relative data/ dir and SECONDBRAIN_DATA_DIR (EC2 live store),
// freshest-artifact-wins per reference_ec2_server_deploy_path.md conventions,
// so a stale empty repo stub never shadows real cloud transcript data.
function otterCandidateDirs(root) {
  const dataDir = process.env.SECONDBRAIN_DATA_DIR;
  const dirs = [];
  if (dataDir)
    dirs.push(path.join(dataDir, 'otter', 'enriched'), path.join(dataDir, 'otter', 'raw'));
  dirs.push(path.join(root, 'data', 'otter', 'enriched'), path.join(root, 'data', 'otter', 'raw'));
  return dirs;
}

function extractTranscriptLines(json) {
  const lines = [];
  const segments = Array.isArray(json && json.segments)
    ? json.segments
    : Array.isArray(json && json.transcript)
      ? json.transcript
      : Array.isArray(json && json.utterances)
        ? json.utterances
        : [];
  for (const seg of segments) {
    const text = cleanText(seg && (seg.text || seg.transcript || seg.words));
    if (!isSubstantiveFact(text)) continue;
    const speaker = cleanText((seg && (seg.speaker || seg.speaker_name)) || 'ExampleCo speaker');
    lines.push({ text, speaker });
  }
  return lines;
}

function loadOtterFacts(root, seed, sampleCount = 8) {
  const out = [];
  for (const dir of otterCandidateDirs(root)) {
    const files = safe(() => fs.readdirSync(dir).filter((f) => f.endsWith('.json')), []);
    if (!files.length) continue;
    const rotated = seededRotate(files.sort().reverse().slice(0, 40), seed);
    for (const f of rotated.slice(0, sampleCount)) {
      const abs = path.join(dir, f);
      const json = safe(() => JSON.parse(fs.readFileSync(abs, 'utf8')), null);
      if (!json) continue;
      const title = cleanText(json.title || json.summary || f.replace(/\.json$/i, ''));
      const when = cleanText(json.date || json.createdAt || json.start_time || '').slice(0, 10);
      const lines = extractTranscriptLines(json).slice(0, 2);
      for (const line of lines) {
        out.push({
          text: line.text,
          heading: title,
          sourceFile: path.relative(root, abs).replace(/\\/g, '/'),
          sourceLabel: `Otter transcript (${title}${when ? `, ${when}` : ''}) - ${line.speaker}`,
        });
      }
    }
    if (out.length) break; // freshest non-empty dir wins, do not double-sample raw + enriched
  }
  return out;
}

// De-dup on normalized text prefix, assign stable ids.
function finalize(facts, max) {
  const seen = new Set();
  const unique = [];
  for (const f of facts) {
    const key = f.text.toLowerCase().slice(0, 100);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
  }
  return unique.slice(0, max).map((f, i) => ({ id: `g${i + 1}`, ...f }));
}

/**
 * @param {object} opts
 * @param {string} [opts.root] repo root
 * @param {string} [opts.date] CT date string, used as the rotation seed
 * @param {number} [opts.max]  cap on pool size handed to the LLM
 * @returns {{facts: Array, counts: object, sourceFiles: string[]}}
 */
function loadKingdomGroundingPool(opts = {}) {
  const root = opts.root || REPO_ROOT;
  const date = opts.date || '';
  const max = opts.max || 60;
  const seed = dateSeed(date);

  const lifeGoals = safe(
    () => loadMemoryFile('memory/ExampleCo_life_goals_current.md', 'life goals', root),
    [],
  );
  const profile = safe(() => loadMemoryFile('memory/user_profile.md', 'profile', root), []);
  const companies = safe(() => loadMemoryFile('memory/user_companies.md', 'companies', root), []);
  const family = safe(() => loadMemoryFile('memory/user_wife_family.md', 'family', root), []);
  const contacts = safe(() => loadContactFacts(root, seed), []);
  const transcripts = safe(() => loadOtterFacts(root, seed), []);

  // Rotate each source list by the seed too, so within a large file (e.g.
  // user_profile.md's 77 bullets) different days surface different facts.
  const rotatedLifeGoals = seededRotate(lifeGoals, seed);
  const rotatedProfile = seededRotate(profile, seed);
  const rotatedCompanies = seededRotate(companies, seed);
  const rotatedFamily = seededRotate(family, seed);

  const facts = finalize(
    [
      ...rotatedLifeGoals.slice(0, 12),
      ...rotatedProfile.slice(0, 12),
      ...rotatedCompanies.slice(0, 12),
      ...rotatedFamily.slice(0, 10),
      ...contacts,
      ...transcripts,
    ],
    max,
  );

  const sourceFiles = [...new Set(facts.map((f) => f.sourceFile))];

  return {
    facts,
    sourceFiles,
    counts: {
      lifeGoals: lifeGoals.length,
      profile: profile.length,
      companies: companies.length,
      family: family.length,
      contacts: contacts.length,
      transcripts: transcripts.length,
      total: facts.length,
    },
  };
}

module.exports = {
  loadKingdomGroundingPool,
  // exported for unit tests
  cleanText,
  isSubstantiveFact,
  dateSeed,
  seededRotate,
  extractBullets,
  loadContactFacts,
  loadOtterFacts,
  finalize,
};
