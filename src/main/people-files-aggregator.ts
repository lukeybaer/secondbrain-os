/**
 * People-files change aggregator.
 *
 * Builds the "people files changed in the last 24h" list that the daily
 * briefing surfaces. The naive approach keys off file mtime, which produces
 * false positives: automated jobs (the nightly LinkedIn scan, the Gmail
 * enrichment sweep) re-touch contact files purely to bump an enrichment
 * timestamp in the frontmatter, mutating mtime without changing anything ExampleCo
 * cares about. That is the "a colleague's contact file showed as changed but
 * was never actually discussed" regression.
 *
 * Fix: a file counts as changed only when its MEANINGFUL CONTENT changed.
 * Meaningful content is the file body plus the frontmatter with volatile,
 * automation-owned keys stripped out. We hash that normalized content and
 * compare the hash against the previous snapshot. mtime-only touches and
 * enrichment-timestamp-only updates produce an identical hash and are ignored.
 *
 * Snapshot file: data/agent/people-files-snapshot.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Frontmatter keys that are written by automated enrichment jobs, not by ExampleCo.
 * A change to ONLY these keys is not a meaningful content change. Matched
 * case-insensitively. Any key matching the `last_*_scan` shape is also treated
 * as volatile so future scan jobs do not need this list updated.
 */
const VOLATILE_FRONTMATTER_KEYS = new Set([
  'last_linkedin_scan',
  'last_email_scan',
  'last_gmail_scan',
  'last_otter_scan',
  'last_scan',
  'updated',
  'updated_at',
  'last_updated',
  'enriched',
  'enriched_at',
  'last_enriched',
  'last_checked',
  'last_synced',
  'last_crawled',
  'scan_notes',
]);

function isVolatileKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  if (VOLATILE_FRONTMATTER_KEYS.has(k)) return true;
  // last_<source>_scan / <source>_scan_at style automation keys
  if (/^last_[a-z0-9]+_scan$/.test(k)) return true;
  if (/_scan(_at)?$/.test(k)) return true;
  return false;
}

/**
 * Normalize a contact .md file to its meaningful content: the body plus the
 * frontmatter minus volatile automation keys. Returns a deterministic string
 * suitable for hashing. Leading/trailing whitespace and CRLF differences are
 * normalized so a pure re-save does not register as a change.
 */
export function normalizeContent(raw: string): string {
  const text = raw.replace(/\r\n/g, '\n');
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!fmMatch) {
    return text.trim();
  }

  const frontmatterBlock = fmMatch[1];
  const body = fmMatch[2];

  const keptFrontmatterLines: string[] = [];
  for (const line of frontmatterBlock.split('\n')) {
    const keyMatch = line.match(/^([A-Za-z0-9_]+)\s*:/);
    if (keyMatch && isVolatileKey(keyMatch[1])) {
      continue; // drop automation-owned key
    }
    keptFrontmatterLines.push(line);
  }

  // Sort kept frontmatter so key reordering by a YAML writer is not a change.
  keptFrontmatterLines.sort();

  return (keptFrontmatterLines.join('\n') + '\n' + body).trim();
}

/** Content hash of a contact file's meaningful content. */
export function hashFile(filePath: string): string {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return crypto.createHash('sha256').update(normalizeContent(raw)).digest('hex');
}

export interface PeopleSnapshot {
  generatedAt: string;
  /** file basename -> content hash */
  hashes: Record<string, string>;
}

export interface PeopleChangeResult {
  changed: string[];
  added: string[];
  removed: string[];
  snapshot: PeopleSnapshot;
}

function isContactFile(name: string): boolean {
  return name.endsWith('.md') && name !== 'INDEX.md' && !name.startsWith('_') && !name.startsWith('PHASE');
}

/**
 * Build the current people-files snapshot by hashing every contact file's
 * meaningful content.
 */
export function buildSnapshot(contactsDir: string): PeopleSnapshot {
  const hashes: Record<string, string> = {};
  for (const name of fs.readdirSync(contactsDir)) {
    if (!isContactFile(name)) continue;
    hashes[name] = hashFile(path.join(contactsDir, name));
  }
  return { generatedAt: new Date().toISOString(), hashes };
}

function loadSnapshot(snapshotPath: string): PeopleSnapshot | null {
  if (!fs.existsSync(snapshotPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
    if (parsed && typeof parsed.hashes === 'object') return parsed as PeopleSnapshot;
  } catch {
    // corrupt snapshot, treat as no prior snapshot
  }
  return null;
}

/**
 * Detect which people files meaningfully changed since the last snapshot.
 *
 * A file is "changed" ONLY when its content hash differs from the previous
 * snapshot. An mtime-only touch, a YAML key reorder, or an enrichment-timestamp
 * bump (e.g. last_linkedin_scan) produces an identical hash and is excluded.
 *
 * @param persist when true, writes the freshly built snapshot back to disk.
 */
export function detectChangedPeopleFiles(
  contactsDir: string,
  snapshotPath: string,
  persist = true,
): PeopleChangeResult {
  const prev = loadSnapshot(snapshotPath);
  const current = buildSnapshot(contactsDir);

  const changed: string[] = [];
  const added: string[] = [];

  if (prev) {
    for (const [file, hash] of Object.entries(current.hashes)) {
      const prevHash = prev.hashes[file];
      if (prevHash === undefined) {
        added.push(file);
      } else if (prevHash !== hash) {
        changed.push(file);
      }
    }
  }

  const removed = prev
    ? Object.keys(prev.hashes).filter((f) => !(f in current.hashes))
    : [];

  if (persist) {
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify(current, null, 2));
  }

  return {
    changed: changed.sort(),
    added: added.sort(),
    removed: removed.sort(),
    snapshot: current,
  };
}
