/**
 * Tests for the backup system — snapshot, prune, restore, roll-forward.
 *
 * Uses a temp directory to simulate %APPDATA%\secondbrain so nothing
 * touches real data. Mocks Electron's `app.getPath("userData")`.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";

// ── Mock Electron's app module ───────────────────────────────────────────────

let testRoot: string;

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "userData") return testRoot;
      return testRoot;
    },
  },
}));

// Import after mock is set up
import {
  createSnapshot,
  listSnapshots,
  getSnapshot,
  inspectSnapshot,
  readSnapshotFile,
  testRestore,
  commitRestore,
  rollForward,
  pruneSnapshots,
  runDailyBackup,
  cleanupTestRestores,
} from "../backups";

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(async () => {
  testRoot = path.join(os.tmpdir(), `sb-backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dataDir = path.join(testRoot, "data");
  await fsp.mkdir(dataDir, { recursive: true });

  // Seed some data files
  const convDir = path.join(dataDir, "conversations", "conv-001");
  await fsp.mkdir(convDir, { recursive: true });
  fs.writeFileSync(path.join(convDir, "meta.json"), JSON.stringify({ id: "conv-001", title: "Test" }));
  fs.writeFileSync(path.join(convDir, "transcript.txt"), "Hello world transcript");

  const projDir = path.join(dataDir, "projects");
  await fsp.mkdir(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "proj-001.json"), JSON.stringify({ id: "proj-001", name: "Test Project" }));

  // Config file
  fs.writeFileSync(path.join(testRoot, "config.json"), JSON.stringify({ openaiApiKey: "sk-test" }));
});

afterAll(async () => {
  // Clean up temp dirs
  if (testRoot && fs.existsSync(testRoot)) {
    await fsp.rm(testRoot, { recursive: true, force: true });
  }
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createSnapshot", () => {
  it("creates a snapshot with correct metadata", async () => {
    const meta = await createSnapshot();
    expect(meta.id).toMatch(/^\d{8}T\d{6}_\d{3}$/);
    expect(meta.tier).toBe("daily");
    expect(meta.fileCount).toBeGreaterThan(0);
    expect(meta.dataBytes).toBeGreaterThan(0);
    expect(meta.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("copies data files into the snapshot", async () => {
    const meta = await createSnapshot();
    const snapshotData = path.join(testRoot, "backups", meta.id, "data");
    expect(fs.existsSync(path.join(snapshotData, "conversations", "conv-001", "meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(snapshotData, "projects", "proj-001.json"))).toBe(true);
  });

  it("copies config.json into the snapshot", async () => {
    const meta = await createSnapshot();
    const configCopy = path.join(testRoot, "backups", meta.id, "config.json");
    expect(fs.existsSync(configCopy)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(configCopy, "utf-8"));
    expect(parsed.openaiApiKey).toBe("sk-test");
  });

  it("writes per-snapshot meta.json", async () => {
    const meta = await createSnapshot();
    const metaFile = path.join(testRoot, "backups", meta.id, "meta.json");
    expect(fs.existsSync(metaFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(metaFile, "utf-8"));
    expect(parsed.id).toBe(meta.id);
    expect(parsed.tier).toBe("daily");
  });
});

describe("listSnapshots / getSnapshot", () => {
  it("lists snapshots newest first", async () => {
    const s1 = await createSnapshot();
    // Small delay to get different timestamps
    await new Promise(r => setTimeout(r, 1100));
    const s2 = await createSnapshot();

    const list = listSnapshots();
    expect(list.length).toBe(2);
    expect(list[0].id).toBe(s2.id);
    expect(list[1].id).toBe(s1.id);
  });

  it("getSnapshot returns correct snapshot", async () => {
    const meta = await createSnapshot();
    const found = getSnapshot(meta.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(meta.id);
  });

  it("getSnapshot returns null for missing ID", () => {
    expect(getSnapshot("nonexistent")).toBeNull();
  });
});

describe("inspectSnapshot / readSnapshotFile", () => {
  it("lists top-level data directories", async () => {
    const meta = await createSnapshot();
    const result = await inspectSnapshot(meta.id);
    expect(result).not.toBeNull();
    const names = result!.files.map(f => f.name);
    expect(names).toContain("conversations");
    expect(names).toContain("projects");
  });

  it("lists files in a subdirectory", async () => {
    const meta = await createSnapshot();
    const result = await inspectSnapshot(meta.id, "conversations/conv-001");
    expect(result).not.toBeNull();
    const names = result!.files.map(f => f.name);
    expect(names).toContain("meta.json");
    expect(names).toContain("transcript.txt");
  });

  it("reads a file from a snapshot", async () => {
    const meta = await createSnapshot();
    const content = await readSnapshotFile(meta.id, "conversations/conv-001/transcript.txt");
    expect(content).toBe("Hello world transcript");
  });

  it("reads JSON from a snapshot", async () => {
    const meta = await createSnapshot();
    const content = await readSnapshotFile(meta.id, "projects/proj-001.json");
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content!);
    expect(parsed.name).toBe("Test Project");
  });

  it("returns null for missing file", async () => {
    const meta = await createSnapshot();
    const content = await readSnapshotFile(meta.id, "nonexistent.json");
    expect(content).toBeNull();
  });
});

describe("commitRestore + rollForward", () => {
  it("restores data from a snapshot and creates pre-restore safety copy", async () => {
    // Create initial snapshot
    const original = await createSnapshot();

    // Modify live data
    const projPath = path.join(testRoot, "data", "projects", "proj-001.json");
    fs.writeFileSync(projPath, JSON.stringify({ id: "proj-001", name: "Modified Project" }));

    // Verify live data is modified
    expect(JSON.parse(fs.readFileSync(projPath, "utf-8")).name).toBe("Modified Project");

    // Restore to original snapshot
    const { preRestoreId } = await commitRestore(original.id);
    expect(preRestoreId).toBeTruthy();

    // Verify data was restored
    const restored = JSON.parse(fs.readFileSync(projPath, "utf-8"));
    expect(restored.name).toBe("Test Project");

    // Verify pre-restore snapshot exists with the modified data
    const preRestoreContent = await readSnapshotFile(preRestoreId, "projects/proj-001.json");
    expect(preRestoreContent).not.toBeNull();
    const preRestoreParsed = JSON.parse(preRestoreContent!);
    expect(preRestoreParsed.name).toBe("Modified Project");
  });

  it("rollForward undoes a restore", async () => {
    // Take snapshot of original state
    const original = await createSnapshot();

    // Modify data
    const projPath = path.join(testRoot, "data", "projects", "proj-001.json");
    fs.writeFileSync(projPath, JSON.stringify({ id: "proj-001", name: "V2 Project" }));

    // Restore to original (creates pre-restore of V2)
    await commitRestore(original.id);
    expect(JSON.parse(fs.readFileSync(projPath, "utf-8")).name).toBe("Test Project");

    // Roll forward — should get V2 back
    const { restoredFromId } = await rollForward();
    expect(restoredFromId).toBeTruthy();
    expect(JSON.parse(fs.readFileSync(projPath, "utf-8")).name).toBe("V2 Project");
  });

  it("rollForward fails gracefully when no pre-restore exists", async () => {
    // Fresh test root with no pre-restore snapshots
    await expect(rollForward()).rejects.toThrow("No pre-restore snapshot found");
  });
});

describe("testRestore", () => {
  it("extracts snapshot to temp dir without touching live data", async () => {
    const meta = await createSnapshot();

    // Modify live data
    const projPath = path.join(testRoot, "data", "projects", "proj-001.json");
    fs.writeFileSync(projPath, JSON.stringify({ id: "proj-001", name: "Modified" }));

    // Test restore
    const tempDir = await testRestore(meta.id);
    expect(fs.existsSync(tempDir)).toBe(true);

    // Temp dir has original data
    const tempProj = JSON.parse(fs.readFileSync(path.join(tempDir, "data", "projects", "proj-001.json"), "utf-8"));
    expect(tempProj.name).toBe("Test Project");

    // Live data is unchanged
    expect(JSON.parse(fs.readFileSync(projPath, "utf-8")).name).toBe("Modified");

    // Cleanup
    const cleaned = await cleanupTestRestores();
    expect(cleaned).toBe(1);
    expect(fs.existsSync(tempDir)).toBe(false);
  });
});

describe("pruneSnapshots", () => {
  it("prunes same-day duplicates (keeps one per interval)", async () => {
    const s1 = await createSnapshot();
    await new Promise(r => setTimeout(r, 50));
    const s2 = await createSnapshot();

    const deleted = await pruneSnapshots();
    // Both are within the same day — daily tier keeps one per day
    expect(deleted.length).toBe(1);

    const remaining = listSnapshots();
    expect(remaining.length).toBe(1);
    // The first (oldest) in the interval is kept
    expect(remaining[0].id).toBe(s1.id);
  });
});

describe("runDailyBackup", () => {
  it("creates snapshot and runs prune", async () => {
    const result = await runDailyBackup();
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot.tier).toBe("daily");
    expect(result.pruned).toBeDefined();
    expect(Array.isArray(result.pruned)).toBe(true);
  });
});
