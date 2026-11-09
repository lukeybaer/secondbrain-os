'use strict';

// People-file ownership helpers for the voice People sync.
//
// Incident 2026-11-03: the sync rewrote a whole contact file from a copy it had
// read earlier, and a `last_linkedin_scan` date that the LinkedIn scan job had
// written in between was lost (two landed sync commits put an old 2026-10-18
// date back over a newer one). A People file is shared: frontmatter and body
// sections belong to many writers, and the voice sync owns only its generated
// blocks. So the sync never writes a copy it read earlier. It re-reads the
// CURRENT file under a per-file lock, applies only its own change to that text,
// and writes the result. Everything it does not own stays exactly as on disk.
//
// A staged copy is trusted only for what its producer owns (mergeStagedCopy):
//   voice_blocks             the marker blocks above; every other byte of the copy
//                            is a stale snapshot of a file git owns and is ignored
//   voice_confirmation_stub  the the owner note bullets of its "Voice Identity Context"
//                            section; the stub's seed keys and template lines
//                            describe a file that already exists and are not applied
// A copy from any other producer, or one that carries content outside what its
// producer owns, is not merged: the caller keeps its requests pending with a reason.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withFileLock } = require('./ledger-state-machine');
const { LEGACY_BLOCKS, LINK_END, LINK_START } = require('./people-voice-identity');

// The marker-delimited blocks the voice sync generates inside a People file.
const OWNED_BLOCKS = [[LINK_START, LINK_END], ...LEGACY_BLOCKS];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function blockRegExp(start, end) {
  return new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
}

// The lock lives outside the contacts folder so a crashed holder can never
// leave debris that `git add memory/contacts` would commit. It is keyed by the
// resolved file path, so every process on this host that touches the same file
// shares one lock, and an isolated worktree copy gets its own.
function peopleFileLockKey(file) {
  const resolved = path.resolve(file);
  const digest = crypto.createHash('sha1').update(resolved.toLowerCase()).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'secondbrain-people-file-locks', `${digest}-${path.basename(resolved)}`);
}

function withPeopleFileLock(file, fn, lockOpts) {
  return withFileLock(peopleFileLockKey(file), fn, lockOpts);
}

function defaultWrite(file, text) {
  fs.writeFileSync(file, text, 'utf8');
}

/**
 * Locked read-modify-write of one People file. `apply(currentText)` receives the
 * text on disk at this moment and returns the next text; it must change only
 * what the caller owns. Nothing is written when the result equals the current
 * text. A missing file is an error (ENOENT) unless the caller passes
 * `missingText`, which stands in for the absent file and is created on the
 * first change; a file that was removed meanwhile is never silently recreated.
 */
function updatePeopleFileLocked(file, apply, { missingText, write = defaultWrite, lockOpts } = {}) {
  return withPeopleFileLock(
    file,
    () => {
      const exists = fs.existsSync(file);
      if (!exists && missingText === undefined) {
        throw Object.assign(new Error(`People file is missing: ${path.basename(file)}`), { code: 'ENOENT' });
      }
      const current = exists ? fs.readFileSync(file, 'utf8') : missingText;
      const next = apply(current);
      if (typeof next !== 'string') throw new TypeError(`People file update for ${path.basename(file)} must return text`);
      if (next === current) return { changed: false, text: current, previous: current };
      if (!exists) fs.mkdirSync(path.dirname(file), { recursive: true });
      write(file, next);
      return { changed: true, text: next, previous: current };
    },
    lockOpts,
  );
}

/**
 * Apply the sync's own generated blocks from a pulled (staged) copy onto the
 * current file. A block is replaced only when BOTH copies carry it: a block the
 * current file has dropped (a legacy block already migrated away) is not
 * resurrected from an older staged copy, and the identity scripts that run next
 * regenerate whatever is missing. The current file's own line-ending convention
 * is kept.
 */
function mergeOwnedBlocks(currentText, stagedText) {
  let next = String(currentText);
  const applied = [];
  for (const [start, end] of OWNED_BLOCKS) {
    const re = blockRegExp(start, end);
    const staged = String(stagedText).match(re)?.[0];
    const current = next.match(re)?.[0];
    if (!staged || !current) continue;
    const eol = current.includes('\r\n') ? '\r\n' : '\n';
    const block = staged.replace(/\r?\n/g, eol);
    if (block === current) continue;
    next = next.replace(re, () => block);
    applied.push(start);
  }
  return { text: next, applied };
}

function stripOwnedBlocks(text) {
  let out = String(text);
  for (const [start, end] of OWNED_BLOCKS) out = out.replace(blockRegExp(start, end), '');
  return out;
}

function frontmatterKeyBlocks(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const keys = new Map();
  if (!match) return keys;
  let key = null;
  for (const line of match[1].split(/\r?\n/)) {
    const top = line.match(/^([A-Za-z0-9_-]+):/);
    if (top) {
      key = top[1];
      keys.set(key, [line]);
    } else if (key) {
      keys.get(key).push(line);
    }
  }
  return new Map([...keys].map(([name, lines]) => [name, lines.join('\n').trimEnd()]));
}

function bodySections(text) {
  const body = String(text).replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  const sections = new Map();
  for (const chunk of body.split(/^(?=#{1,6}\s)/m)) {
    const normalized = chunk.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
    if (!normalized.trim()) continue;
    const heading = /^#{1,6}\s/.test(normalized) ? normalized.split('\n', 1)[0] : '(preamble)';
    sections.set(heading, normalized);
  }
  return sections;
}

/**
 * Names of what a staged copy carries that the current file does not agree
 * with, outside the sync's own blocks. These are the parts the sync does NOT
 * apply (the file on disk wins), reported so a skipped difference is visible
 * and never silent. Frontmatter keys are named; body sections are only counted
 * because a heading can be personal.
 */
function describeUnownedDifferences(currentText, stagedText) {
  const current = stripOwnedBlocks(currentText);
  const staged = stripOwnedBlocks(stagedText);
  const currentKeys = frontmatterKeyBlocks(current);
  const stagedKeys = frontmatterKeyBlocks(staged);
  const differingKeys = [...new Set([...currentKeys.keys(), ...stagedKeys.keys()])]
    .filter((key) => currentKeys.get(key) !== stagedKeys.get(key))
    .sort();
  const currentSections = bodySections(current);
  const stagedSections = bodySections(staged);
  const differingSections = [...new Set([...currentSections.keys(), ...stagedSections.keys()])].filter(
    (heading) => currentSections.get(heading) !== stagedSections.get(heading),
  );
  return { frontmatter_keys: differingKeys, body_sections: differingSections.length };
}

// The voice-confirmation stub (scripts/lib/voice-people-stub.js buildStubBody) is the
// only staged shape with its own ownership: seed frontmatter, a title, and one
// "Voice Identity Context" section of bullets.
const STUB_SEED_KEYS = ['name', 'source', 'created_at'];
const STUB_CONTEXT_HEADING = '## Voice Identity Context';
const STUB_TEMPLATE_ITEMS = [
  /^- Created from the owner's Daily Briefing voice identity flow for `[^`]*`\.$/,
  /^- the owner has not added extra context yet\.$/,
];

// Staging sources whose staged text has a known owner (people-learning-stage meta
// `source`). Anything else is an unknown producer.
const STAGED_SOURCE_PRODUCERS = {
  otter_exact_call_projection: 'voice_blocks',
  briefing_voice_confirmation: 'voice_confirmation_stub',
};

function squash(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * The note bullets of a staged voice-confirmation stub, or null when the copy is
 * not exactly a stub (any other frontmatter key, section or loose text, outside
 * the sync's own marker blocks). Template bullets are creation metadata and are
 * not notes.
 */
function parseStubShell(stagedText) {
  const text = stripOwnedBlocks(stagedText);
  const keys = frontmatterKeyBlocks(text);
  if (!keys.size) return null;
  for (const key of keys.keys()) if (!STUB_SEED_KEYS.includes(key)) return null;
  let context = null;
  for (const [heading, chunk] of bodySections(text)) {
    if (heading === STUB_CONTEXT_HEADING) context = chunk;
    else if (!(/^# /.test(heading) && chunk.trim() === heading.trim())) return null;
  }
  const items = [];
  for (const raw of String(context || '').split('\n').slice(1)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith('- ')) items.push(line);
    else if (items.length) items[items.length - 1] += `\n${line}`;
    else return null;
  }
  return {
    notes: items.filter((item) => !STUB_TEMPLATE_ITEMS.some((re) => re.test(item))),
    seedKeys: new Map([...keys].filter(([key]) => STUB_SEED_KEYS.includes(key))),
  };
}

/**
 * Add the note bullets the current file does not already carry to its "Voice
 * Identity Context" section (created at the end when absent). Existing text is
 * never changed; a note already present anywhere in the file is not repeated.
 */
function placeStubNotes(currentText, notes) {
  const text = String(currentText);
  const haystack = squash(text);
  const missing = notes.filter((note) => !haystack.includes(squash(note)));
  if (!missing.length) return { text, count: 0 };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const added = missing.flatMap((note) => note.split('\n'));
  const at = lines.findIndex((line) => line.trim() === STUB_CONTEXT_HEADING);
  if (at < 0) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push('', STUB_CONTEXT_HEADING, '', ...added, '');
    return { text: lines.join(eol), count: missing.length };
  }
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i]) || /^<!--/.test(lines[i])) {
      end = i;
      break;
    }
  }
  let last = at;
  for (let i = at + 1; i < end; i += 1) if (lines[i].trim()) last = i;
  lines.splice(last + 1, 0, ...(last === at ? ['', ...added] : added));
  return { text: lines.join(eol), count: missing.length };
}

/**
 * Merge one staged copy onto the current file by the staged copy's producer.
 * origin 'mirror' is the EC2 contacts mirror (a voice sync output, stale by
 * nature); origin 'pending' is a staged People-learning copy, whose producer is
 * its stub shape or its staging `source`. Returns { ok: true, text, producer, ... }
 * or { ok: false, reason, detail } when nothing can be placed safely.
 */
function mergeStagedCopy(currentText, stagedText, { origin = 'pending', stagedSource = '' } = {}) {
  const current = String(currentText);
  const blocks = mergeOwnedBlocks(current, stagedText);
  const placed = (producer, text, extra = {}) => ({
    ok: true,
    producer,
    text,
    applied: blocks.applied,
    notes_placed: 0,
    seed_keys_not_applied: [],
    ...extra,
  });
  if (origin === 'mirror') return placed('voice_blocks', blocks.text);
  const shell = parseStubShell(stagedText);
  if (shell) {
    const currentKeys = frontmatterKeyBlocks(current);
    const notes = placeStubNotes(blocks.text, shell.notes);
    return placed('voice_confirmation_stub', notes.text, {
      notes_placed: notes.count,
      seed_keys_not_applied: [...shell.seedKeys]
        .filter(([key, block]) => currentKeys.get(key) !== block)
        .map(([key]) => key)
        .sort(),
    });
  }
  const producer = STAGED_SOURCE_PRODUCERS[String(stagedSource || '')];
  if (producer === 'voice_blocks') return placed(producer, blocks.text);
  // Unknown producer: its copy is placed only when it adds nothing outside the
  // voice blocks, so there is nothing of its own to lose.
  const differences = describeUnownedDifferences(current, stagedText);
  if (!differences.frontmatter_keys.length && !differences.body_sections) {
    return placed('voice_blocks', blocks.text);
  }
  return {
    ok: false,
    reason: producer ? 'staged_content_outside_producer_ownership' : 'unknown_producer',
    detail: { source: String(stagedSource || ''), ...differences },
  };
}

module.exports = {
  OWNED_BLOCKS,
  describeUnownedDifferences,
  mergeOwnedBlocks,
  mergeStagedCopy,
  parseStubShell,
  placeStubNotes,
  peopleFileLockKey,
  updatePeopleFileLocked,
  withPeopleFileLock,
};
