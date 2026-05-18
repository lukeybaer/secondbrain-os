/**
 * Regression: people-files change detection must key off meaningful CONTENT,
 * not file mtime.
 *
 * The "a colleague's contact file showed as changed in the last 24h even
 * though it was never actually discussed" bug came from the briefing keying
 * its people-changed list on file mtime. The nightly LinkedIn enrichment job
 * re-touches every contact file to bump `last_linkedin_scan` in the
 * frontmatter, mutating mtime without any meaningful content change.
 * detectChangedPeopleFiles() must ignore those.
 *
 * Fixtures use a fully fictional person and company so no real names land in
 * the public-sync payload.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeContent, detectChangedPeopleFiles } from '../people-files-aggregator';

let tmpDir: string;
let contactsDir: string;
let snapshotPath: string;

const CONTACT_BASE = `---
name: Dana Northwind
description: Northwind colleague
type: user
category: active-network
linkedin: not-found
last_linkedin_scan: "2026-05-10"
warmth: dormant
---

## Contact
- **Work email**: dana@northwind.example

## Personal
- Works in product at Northwind.
`;

function writeContact(name: string, content: string): void {
  fs.writeFileSync(path.join(contactsDir, name), content);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-agg-'));
  contactsDir = path.join(tmpDir, 'contacts');
  fs.mkdirSync(contactsDir, { recursive: true });
  snapshotPath = path.join(tmpDir, 'data', 'agent', 'people-files-snapshot.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('detectChangedPeopleFiles - content-hash, not mtime', () => {
  it('mtime-only touch with identical content does NOT register as changed', () => {
    writeContact('dana_northwind.md', CONTACT_BASE);
    // First run establishes the baseline snapshot.
    detectChangedPeopleFiles(contactsDir, snapshotPath);

    // Re-write the exact same bytes and bump mtime into the future,
    // simulating an automated re-save / `touch`.
    const filePath = path.join(contactsDir, 'dana_northwind.md');
    fs.writeFileSync(filePath, CONTACT_BASE);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    fs.utimesSync(filePath, future, future);

    const result = detectChangedPeopleFiles(contactsDir, snapshotPath);
    expect(result.changed).not.toContain('dana_northwind.md');
    expect(result.changed).toEqual([]);
  });

  it('enrichment-timestamp-only frontmatter bump does NOT register as changed', () => {
    writeContact('dana_northwind.md', CONTACT_BASE);
    detectChangedPeopleFiles(contactsDir, snapshotPath);

    // Nightly LinkedIn scan bumps last_linkedin_scan only. No body change,
    // no meaningful frontmatter change.
    const enriched = CONTACT_BASE.replace(
      'last_linkedin_scan: "2026-05-10"',
      'last_linkedin_scan: "2026-05-18"',
    );
    writeContact('dana_northwind.md', enriched);

    const result = detectChangedPeopleFiles(contactsDir, snapshotPath);
    expect(result.changed).not.toContain('dana_northwind.md');
    expect(result.changed).toEqual([]);
  });

  it('a real content edit DOES register as changed', () => {
    writeContact('dana_northwind.md', CONTACT_BASE);
    detectChangedPeopleFiles(contactsDir, snapshotPath);

    const edited = CONTACT_BASE + '\n- 2026-05-18: Discussed the dashboard rollout.\n';
    writeContact('dana_northwind.md', edited);

    const result = detectChangedPeopleFiles(contactsDir, snapshotPath);
    expect(result.changed).toEqual(['dana_northwind.md']);
  });

  it('a meaningful frontmatter edit (not a volatile key) DOES register as changed', () => {
    writeContact('dana_northwind.md', CONTACT_BASE);
    detectChangedPeopleFiles(contactsDir, snapshotPath);

    const edited = CONTACT_BASE.replace('warmth: dormant', 'warmth: active');
    writeContact('dana_northwind.md', edited);

    const result = detectChangedPeopleFiles(contactsDir, snapshotPath);
    expect(result.changed).toEqual(['dana_northwind.md']);
  });

  it('a brand-new contact file shows as added, not changed', () => {
    writeContact('dana_northwind.md', CONTACT_BASE);
    detectChangedPeopleFiles(contactsDir, snapshotPath);

    writeContact('new_person.md', CONTACT_BASE.replace('Dana Northwind', 'New Person'));

    const result = detectChangedPeopleFiles(contactsDir, snapshotPath);
    expect(result.added).toEqual(['new_person.md']);
    expect(result.changed).toEqual([]);
  });

  it('first run with no prior snapshot reports nothing as changed', () => {
    writeContact('dana_northwind.md', CONTACT_BASE);
    const result = detectChangedPeopleFiles(contactsDir, snapshotPath);
    expect(result.changed).toEqual([]);
    expect(result.added).toEqual([]);
    expect(fs.existsSync(snapshotPath)).toBe(true);
  });
});

describe('normalizeContent', () => {
  it('strips volatile last_*_scan keys but keeps real frontmatter', () => {
    const norm = normalizeContent(CONTACT_BASE);
    expect(norm).not.toContain('last_linkedin_scan');
    expect(norm).toContain('warmth: dormant');
    expect(norm).toContain('name: Dana Northwind');
  });

  it('produces an identical result regardless of CRLF vs LF line endings', () => {
    expect(normalizeContent(CONTACT_BASE)).toBe(
      normalizeContent(CONTACT_BASE.replace(/\n/g, '\r\n')),
    );
  });
});
