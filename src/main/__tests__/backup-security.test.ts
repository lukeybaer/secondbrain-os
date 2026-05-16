import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";

const execFileSync = vi.fn();

vi.mock("child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...args),
}));

import { getBackupSecurityReport } from "../backup-security";

let testRoot: string;

beforeEach(async () => {
  testRoot = path.join(os.tmpdir(), `sb-security-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fsp.mkdir(path.join(testRoot, "data"), { recursive: true });
  execFileSync.mockReset();
  delete process.env.SECONDBRAIN_BACKUP_BUCKET;
});

afterEach(async () => {
  await fsp.rm(testRoot, { recursive: true, force: true });
});

describe("getBackupSecurityReport", () => {
  it("reports config inclusion", async () => {
    fs.writeFileSync(path.join(testRoot, "config.json"), "{}");
    const report = await getBackupSecurityReport(testRoot, "snap-001");
    expect(report.hasConfig).toBe(true);
    expect(report.sensitivePaths).toContain("config.json");
  });

  it("reports encrypted PII vault presence", async () => {
    await fsp.mkdir(path.join(testRoot, "data", "vault"), { recursive: true });
    fs.writeFileSync(path.join(testRoot, "data", "vault", "pii.encrypted.json"), "{}");
    const report = await getBackupSecurityReport(testRoot, "snap-001");
    expect(report.hasEncryptedPiiVault).toBe(true);
    expect(report.sensitivity).toBe("encrypted_sensitive");
  });

  it("warns when sensitive directories are present without a recognized encrypted vault", async () => {
    await fsp.mkdir(path.join(testRoot, "data", "sms"), { recursive: true });
    const report = await getBackupSecurityReport(testRoot, "snap-001");
    expect(report.sensitivity).toBe("sensitive");
    expect(report.warnings.join(" ")).toContain("Sensitive-looking paths");
  });

  it("reports S3 encryption when AWS metadata confirms server-side encryption", async () => {
    process.env.SECONDBRAIN_BACKUP_BUCKET = "bucket";
    execFileSync.mockReturnValue("AES256\n");
    const report = await getBackupSecurityReport(testRoot, "snap-001");
    expect(report.offsiteEncryption).toBe("encrypted");
  });
});
