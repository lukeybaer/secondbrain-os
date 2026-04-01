import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export function runStartupChecks(): void {
  checkNativeModuleBinding();
  checkFileSystemAccess();
  checkNodeVersion();
}

function checkNativeModuleBinding(): void {
  try {
    require("better-sqlite3");
  } catch (err) {
    console.warn(
      "[startup-check] better-sqlite3 native binding not available. " +
        "Run: npm install && npm run postinstall\n",
      err,
    );
  }
}

function checkFileSystemAccess(): void {
  try {
    const dataDir = path.join(app.getPath("userData"), "data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const testFile = path.join(dataDir, ".write-test");
    fs.writeFileSync(testFile, Date.now().toString(), "utf-8");
    fs.unlinkSync(testFile);
  } catch (err) {
    console.warn(
      "[startup-check] Cannot write to userData/data/ directory. " +
        "Check file permissions.\n",
      err,
    );
  }
}

function checkNodeVersion(): void {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 18) {
    console.warn(
      `[startup-check] Node.js ${process.versions.node} detected. ` +
        "SecondBrain requires Node.js 18+.",
    );
  }
}
