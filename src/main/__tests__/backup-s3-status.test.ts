import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SnapshotMeta } from "../backups";

const execFileSync = vi.fn();

vi.mock("child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...args),
}));

import { getBackupS3Status } from "../backup-s3-status";

const snapshots: SnapshotMeta[] = [
  { id: "snap-001", timestamp: "2026-01-01T00:00:00.000Z", tier: "daily", fileCount: 1, dataBytes: 1, durationMs: 1 },
  { id: "snap-002", timestamp: "2026-01-02T00:00:00.000Z", tier: "daily", fileCount: 1, dataBytes: 1, durationMs: 1 },
];

beforeEach(() => {
  execFileSync.mockReset();
  delete process.env.SECONDBRAIN_BACKUP_BUCKET;
});

describe("getBackupS3Status", () => {
  it("returns not_configured when SECONDBRAIN_BACKUP_BUCKET is absent", () => {
    const report = getBackupS3Status(snapshots);
    expect(report.availability).toBe("not_configured");
    expect(report.summary.localSnapshots).toBe(2);
  });

  it("marks snapshots synced when matching archives exist", () => {
    process.env.SECONDBRAIN_BACKUP_BUCKET = "bucket";
    execFileSync.mockReturnValue(JSON.stringify(["snapshots/snap-001.zip", "snapshots/snap-002.zip"]));
    const report = getBackupS3Status(snapshots);
    expect(report.availability).toBe("available");
    expect(report.snapshots.every((snapshot) => snapshot.status === "synced")).toBe(true);
    expect(report.summary.missingFromS3).toBe(0);
  });

  it("marks snapshots missing when local manifest has no matching archive", () => {
    process.env.SECONDBRAIN_BACKUP_BUCKET = "bucket";
    execFileSync.mockReturnValue(JSON.stringify(["snapshots/snap-001.zip"]));
    const report = getBackupS3Status(snapshots);
    expect(report.snapshots.find((snapshot) => snapshot.id === "snap-002")?.status).toBe("missing");
    expect(report.summary.missingFromS3).toBe(1);
  });

  it("handles AWS CLI failure as unavailable", () => {
    process.env.SECONDBRAIN_BACKUP_BUCKET = "bucket";
    execFileSync.mockImplementation(() => {
      throw new Error("aws failed");
    });
    const report = getBackupS3Status(snapshots);
    expect(report.availability).toBe("unavailable");
    expect(report.summary.s3Unreachable).toBe(true);
  });
});
