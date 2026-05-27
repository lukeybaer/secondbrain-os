/**
 * Luke 2026-04-29 #learn dispatch: "you said all green but it wasn't."
 *
 * Root cause for the People Files card specifically: I edited the live-git
 * filter in ec2-server.js (buildPeopleFilesChangeCard) but NOT the snapshot
 * generator (scripts/snapshot-people-and-memory-delta.js). EC2 has no .git,
 * so the dashboard fell back to the snapshot, which still contained
 * `_gmail-daily-intel.md` as biggest. "Done" in the source was not "done"
 * in the artifact Luke sees.
 *
 * This test locks the symmetry: BOTH the live-git path AND the snapshot
 * generator must filter aggregator/index files (`_*.md`, `INDEX.md`) the
 * same way. A future refactor that fixes one and forgets the other fails
 * here.
 *
 * See feedback_verify_in_artifact_not_implementation.md.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const REPO = path.join(__dirname, '..', '..', '..');
const SERVER = path.join(REPO, 'ec2-server.js');
const SNAPSHOT_GEN = path.join(REPO, 'scripts', 'snapshot-people-and-memory-delta.js');

describe("People-files aggregator filter is symmetric (Luke 2026-04-29 #learn)", () => {
  const serverSrc = fs.readFileSync(SERVER, 'utf8');
  const snapshotSrc = fs.readFileSync(SNAPSHOT_GEN, 'utf8');

  it("ec2-server.js exposes isAggregatorFile helper", () => {
    expect(serverSrc).toMatch(/function isAggregatorFile\(/);
  });

  it("snapshot generator also defines isAggregatorFile (no skew between paths)", () => {
    expect(snapshotSrc).toMatch(/function isAggregatorFile\(/);
  });

  it("snapshot generator filters out _-prefixed files at write time", () => {
    expect(snapshotSrc).toMatch(/if \(isAggregatorFile\(file\)\) continue/);
  });

  it("ec2-server.js snapshot fallback re-applies the filter at read time (defense in depth)", () => {
    expect(serverSrc).toMatch(/snap\.allEntries\.filter\(\(e\) => !isAggregatorFile/);
  });

  it("snapshot generator includes allEntries (drilldown needs every contact)", () => {
    expect(snapshotSrc).toMatch(/allEntries:\s*entries/);
  });

  it("snapshot generator extracts addedSample from real diff content", () => {
    expect(snapshotSrc).toMatch(/historyEntries/);
    expect(snapshotSrc).toMatch(/bulletEntries/);
  });

  // Luke 2026-04-29 dispatch (third pass): "you've started dumping all this
  // crap into memory.md now???" The dashboard was misleading because it
  // showed the commit subject instead of the actual added lines. Lock the
  // real-diff render at the parser layer.
  it("MEMORY.md card surfaces actual addedLines from the diff (not just commit subjects)", () => {
    expect(snapshotSrc).toMatch(/addedLines/);
    const ec2 = fs.readFileSync(SERVER, 'utf8');
    expect(ec2).toMatch(/addedLines/);
    // Render must prefer the real diff over the commit subject when both
    // are available (snapshot has both for graceful fallback).
    expect(ec2).toMatch(/c\.addedLines && c\.addedLines\.length > 0/);
  });

  it("on-disk snapshot (if present) does NOT contain aggregator files as biggest/smallest", () => {
    const snapPath = path.join(REPO, 'data', 'agent', 'people-files-snapshot.json');
    if (!fs.existsSync(snapPath)) return; // snapshot not yet generated
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    if (snap.biggest) {
      const bn = path.basename(snap.biggest.file || '', '.md');
      expect(bn.startsWith('_'), `snapshot biggest is aggregator: ${bn}`).toBe(false);
      expect(bn.toUpperCase() !== 'INDEX', `snapshot biggest is INDEX`).toBe(true);
    }
    if (snap.smallest) {
      const bn = path.basename(snap.smallest.file || '', '.md');
      expect(bn.startsWith('_'), `snapshot smallest is aggregator: ${bn}`).toBe(false);
    }
  });
});
