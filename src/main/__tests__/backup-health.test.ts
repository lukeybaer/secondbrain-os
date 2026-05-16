import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";
import { verifyBackupIntegrity } from "../backup-health";
import type { SnapshotMeta } from "../backups";

let testRoot: string;

vi.mock("better-sqlite3", () => ({
  default: class MockDatabase {
    dbPath: string;

    constructor(dbPath: string) {
      this.dbPath = dbPath;
      const content = fs.readFileSync(dbPath, "utf-8");
      if (content === "not sqlite") throw new Error("database disk image is malformed");
    }

    prepare() {
      return { all: () => [] };
    }

    close() {}
  },
}));

async function writeValidSnapshot(id = "snap-001"): Promise<{ root: string; meta: SnapshotMeta }> {
  const root = path.join(testRoot, id);
  const data = path.join(root, "data");
  await fsp.mkdir(data, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ openaiApiKey: "sk-test" }));
  fs.writeFileSync(path.join(data, "notes.json"), JSON.stringify({ ok: true }));
  fs.writeFileSync(path.join(data, "secondbrain.db"), "sqlite");
  const stats = await countFiles(root);
  const meta: SnapshotMeta = {
    id,
    timestamp: new Date().toISOString(),
    tier: "daily",
    fileCount: stats.fileCount,
    dataBytes: stats.dataBytes,
    durationMs: 1,
  };
  fs.writeFileSync(path.join(root, "meta.json"), JSON.stringify(meta, null, 2));
  return { root, meta };
}

async function countFiles(dir: string): Promise<{ fileCount: number; dataBytes: number }> {
  let fileCount = 0;
  let dataBytes = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "meta.json") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await countFiles(full);
      fileCount += sub.fileCount;
      dataBytes += sub.dataBytes;
    } else {
      fileCount++;
      dataBytes += fs.statSync(full).size;
    }
  }
  return { fileCount, dataBytes };
}

beforeEach(async () => {
  testRoot = path.join(os.tmpdir(), `sb-health-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fsp.mkdir(testRoot, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(testRoot, { recursive: true, force: true });
});

describe("verifyBackupIntegrity", () => {
  it("passes for a valid snapshot", async () => {
    const { root, meta } = await writeValidSnapshot();
    const report = await verifyBackupIntegrity(root, meta);
    expect(report.status).toBe("ok");
    expect(report.errors).toEqual([]);
  });

  it("warns when config.json is missing", async () => {
    const { root, meta } = await writeValidSnapshot();
    fs.unlinkSync(path.join(root, "config.json"));
    const adjustedMeta = { ...meta, fileCount: meta.fileCount - 1, dataBytes: meta.dataBytes - Buffer.byteLength(JSON.stringify({ openaiApiKey: "sk-test" })) };
    const report = await verifyBackupIntegrity(root, adjustedMeta);
    expect(report.status).toBe("warning");
    expect(report.warnings.join(" ")).toContain("config.json");
  });

  it("fails when snapshot directory is missing", async () => {
    const report = await verifyBackupIntegrity(path.join(testRoot, "missing"), null);
    expect(report.status).toBe("failed");
    expect(report.errors.join(" ")).toContain("Snapshot directory");
  });

  it("fails when data directory is missing", async () => {
    const { root, meta } = await writeValidSnapshot();
    await fsp.rm(path.join(root, "data"), { recursive: true, force: true });
    const report = await verifyBackupIntegrity(root, meta);
    expect(report.status).toBe("failed");
    expect(report.errors.join(" ")).toContain("data/");
  });

  it("detects meta.json file count and byte drift", async () => {
    const { root, meta } = await writeValidSnapshot();
    fs.writeFileSync(path.join(root, "data", "extra.txt"), "drift");
    const report = await verifyBackupIntegrity(root, meta);
    expect(report.status).toBe("failed");
    expect(report.errors.join(" ")).toContain("file count");
    expect(report.errors.join(" ")).toContain("byte total");
  });

  it("detects corrupt SQLite DB when present", async () => {
    const { root, meta } = await writeValidSnapshot();
    fs.writeFileSync(path.join(root, "data", "secondbrain.db"), "not sqlite");
    const adjustedMeta = { ...meta, dataBytes: (await countFiles(root)).dataBytes };
    const report = await verifyBackupIntegrity(root, adjustedMeta);
    expect(report.status).toBe("failed");
    expect(report.errors.join(" ")).toContain("secondbrain.db");
  });
});
