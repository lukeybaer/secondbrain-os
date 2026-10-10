// Clamps oversized display columns in the Codex thread index.
//
// Codex stores the whole first user message into threads.title / .preview /
// .first_user_message. With Amy's injected preload blocks those grow to tens of
// MB across ~1000 rows, and rendering the sidebar then spins the Electron main
// process forever so the app never shows a window.
//
// This trims only display text. Thread rows and rollout_path are untouched, so
// no history is lost. See memory/codex-desktop-hang-is-codex-home-data.md
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dbPath = path.join(os.homedir(), ".codex", "state_5.sqlite");
const logPath = path.join(os.homedir(), ".amy", "codex-session-guard.log");

function log(msg) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const line = `${stamp}  ${msg}\n`;
  try {
    fs.appendFileSync(logPath, line);
  } catch {}
}

if (!fs.existsSync(dbPath)) {
  log("state-clamp: no state_5.sqlite, skipped");
  process.exit(0);
}

let db;
try {
  db = new DatabaseSync(dbPath);
  const before = db
    .prepare(
      `SELECT SUM(COALESCE(LENGTH(title),0)
              + COALESCE(LENGTH(preview),0)
              + COALESCE(LENGTH(first_user_message),0)) b FROM threads`,
    )
    .get();

  const fat = db
    .prepare(
      `SELECT COUNT(*) c FROM threads
        WHERE LENGTH(title) > 200 OR LENGTH(preview) > 300
           OR LENGTH(first_user_message) > 4000`,
    )
    .get();

  if (fat.c === 0) {
    log("state-clamp: clean, no oversized thread titles");
    db.close();
    process.exit(0);
  }

  db.exec(`UPDATE threads
              SET title = substr(replace(replace(title, char(10), ' '), char(13), ' '), 1, 200)
            WHERE title IS NOT NULL AND LENGTH(title) > 200;`);
  db.exec(`UPDATE threads
              SET preview = substr(replace(replace(preview, char(10), ' '), char(13), ' '), 1, 300)
            WHERE preview IS NOT NULL AND LENGTH(preview) > 300;`);
  db.exec(`UPDATE threads
              SET first_user_message = substr(first_user_message, 1, 4000)
            WHERE first_user_message IS NOT NULL AND LENGTH(first_user_message) > 4000;`);
  // Leave DB/WAL identity intact; no VACUUM or raw-session relocation.

  const after = db
    .prepare(
      `SELECT SUM(COALESCE(LENGTH(title),0)
              + COALESCE(LENGTH(preview),0)
              + COALESCE(LENGTH(first_user_message),0)) b FROM threads`,
    )
    .get();
  log(
    `state-clamp: trimmed ${fat.c} thread(s), display text ${(before.b / 1048576).toFixed(1)}MB -> ${(after.b / 1048576).toFixed(2)}MB`,
  );
  db.close();
} catch (e) {
  log(`state-clamp error: ${e.message}`);
  try {
    if (db) db.close();
  } catch {}
  process.exit(1);
}
