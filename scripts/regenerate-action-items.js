#!/usr/bin/env node
// Rebuild data/briefing-action-items.json from a current Gmail inbox rebuild.
//
// This is the missing mechanical counterpart to the daily-gmail-scan skill:
// the briefing must not clear the Action Items card just because an old JSON
// file was reply-verified. A clean card requires a current source rebuild.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadStandingReminders, mergeStandingIntoCommitments } = require('./lib/standing-reminders');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const DATA_DIR = process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data');
const DATA_PATH = path.join(DATA_DIR, 'briefing-action-items.json');
const LOG_PATH = path.join(DATA_DIR, 'agent', 'action-items-regenerator.jsonl');
const GMAIL_RAW_ROOT = path.join(DATA_DIR, 'gmail', 'raw');
// The regen owns its OWN UID watermark. It deliberately does NOT seed from the
// gmail-amy-scan watcher watermark, because that watcher advances over mail it
// never archived into data/gmail/raw, so trusting it as a skip floor could
// permanently drop un-archived asks on migration (Codex peer review 2026-06-23).
//
// Coverage model (so the watermark is honest, not over-claimed):
//   - The LIVE incremental fetch covers only NEW mail going forward. On the
//     FIRST run (no own watermark) it bootstraps with NO --after-uid floor: a
//     single limit-capped pull of the NEWEST messages (fast, not a 300-message
//     window), establishing a recent baseline. After that it pulls the oldest
//     contiguous batch above the watermark, so it never skips a UID BETWEEN the
//     watermark and the highest fetched UID.
//   - The bootstrap intentionally does NOT promise to have seen mail older than
//     that newest baseline. Older still-open asks are covered by the ARCHIVE
//     union (deep 300-message window) and by carry-forward of prior open asks,
//     NOT by the live fetch. That is the whole reason for the union.
// Net: recent asks come from the small live pull; older open asks come from the
// archive + carry-forward; nothing an open ask depends on is silently dropped.
const UID_WATERMARK_PATH = path.join(DATA_DIR, 'agent', 'action-items-fetch-uid-watermark.json');
const ExampleCo_EMAIL = 'ExampleCo.d.ExampleCo@gmail.com';
const ExampleCo_WORK_EMAIL = ['lExampleCo', ['benefits', 'allin.com'].join('')].join('@');
const CURRENT_EMAIL_MAX_AGE_DAYS = 120;

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}

function todayCt() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function log(row) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
}

function parseJsonArray(stdout) {
  const raw = String(stdout || '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  return JSON.parse(raw.slice(start, end + 1));
}

// Read the UID watermark the gmail-amy-scan watch loop maintains so the regen
// fetches incrementally. Returns the on-disk { uid, updatedAt } shape. Missing
// or corrupt watermark returns { uid: 0 } so the fetch is a small top-up with
// no --after-uid, never a full window.
function readUidWatermarkFile(watermarkPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(watermarkPath, 'utf8'));
    // The on-disk format is { uid, updatedAt }, but tolerate a bare numeric
    // watermark too so a hand-edited or legacy file still drives the fetch.
    const uid = typeof raw === 'number' ? raw : Number(raw && raw.uid);
    const updatedAt = raw && typeof raw === 'object' ? raw.updatedAt : undefined;
    return { uid: Number.isFinite(uid) ? uid : 0, updatedAt };
  } catch {
    return { uid: 0 };
  }
}

// The regen's OWN watermark. On first run (no file) returns { uid: 0 } so the
// bootstrap pull has no --after-uid floor: a single limit-capped fetch of the
// newest messages, no inherited skip floor from any other process.
function loadActionScanWatermark(watermarkPath = UID_WATERMARK_PATH) {
  if (fs.existsSync(watermarkPath)) return readUidWatermarkFile(watermarkPath);
  return { uid: 0 };
}

function saveActionScanWatermark(uid, watermarkPath = UID_WATERMARK_PATH) {
  if (!Number.isFinite(uid) || uid <= 0) return;
  fs.mkdirSync(path.dirname(watermarkPath), { recursive: true });
  fs.writeFileSync(
    watermarkPath,
    JSON.stringify({ uid, updatedAt: new Date().toISOString() }, null, 2),
  );
}

function highestUid(messages) {
  let max = 0;
  for (const msg of messages || []) {
    const u = Number(msg && msg.uid);
    if (Number.isFinite(u) && u > max) max = u;
  }
  return max;
}

function fetchRecentMessages(limit, afterUid = 0) {
  const python = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  const script = path.join(REPO, 'scripts', 'fetch-recent-gmail.py');
  const args = [script, String(limit)];
  // The watermark is what makes this fast: pull only messages newer than the
  // last seen UID. The count is just a sane upper bound on the top-up.
  if (Number.isFinite(afterUid) && afterUid > 0) args.push('--after-uid', String(afterUid));
  const result = spawnSync(python, args, {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 4 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || `exit ${result.status}`).slice(-1000);
    throw new Error(`fetch-recent-gmail.py failed: ${msg}`);
  }
  return parseJsonArray(result.stdout);
}

function safeReadJson(absPath) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

function sortedDirsDesc(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

function archiveMessageToRecentMessage(row) {
  const date = row.date || row.archived_at || '';
  return {
    id: row.id || row.gmail_message_hex || row.message_id || '',
    message_id: row.message_id || row.gmail_message_hex || row.id || '',
    from: row.from || '',
    to: row.to || '',
    subject: row.subject || '',
    date,
    body: row.body || '',
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    gmailUrl: row.gmail_url || row.gmailUrl || '',
    sourceArchivePath: row.archive_dir || row.raw_saved_to || '',
    source: 'gmail-local-archive',
  };
}

function loadArchivedGmailMessages(limit, rawRoot = GMAIL_RAW_ROOT) {
  const messages = [];
  const seen = new Set();
  for (const year of sortedDirsDesc(rawRoot)) {
    const yearDir = path.join(rawRoot, year);
    for (const month of sortedDirsDesc(yearDir)) {
      const monthDir = path.join(yearDir, month);
      for (const day of sortedDirsDesc(monthDir)) {
        const dayDir = path.join(monthDir, day);
        for (const msgDir of sortedDirsDesc(dayDir)) {
          const row = safeReadJson(path.join(dayDir, msgDir, 'message.json'));
          if (!row || !row.subject) continue;
          const key = row.gmail_message_hex || row.message_id || row.id || msgDir;
          if (seen.has(key)) continue;
          seen.add(key);
          messages.push(archiveMessageToRecentMessage(row));
          if (messages.length >= limit * 3) break;
        }
        if (messages.length >= limit * 3) break;
      }
      if (messages.length >= limit * 3) break;
    }
    if (messages.length >= limit * 3) break;
  }
  return messages
    .sort((a, b) => {
      const ad = Date.parse(a.date || '');
      const bd = Date.parse(b.date || '');
      return (Number.isFinite(bd) ? bd : 0) - (Number.isFinite(ad) ? ad : 0);
    })
    .slice(0, limit);
}

// Stable de-dup key for a Gmail message across the archive and the incremental
// fetch. A REAL Gmail Message-ID always contains '@' (it is <local@domain>) and
// is the ONLY identifier shared between a live IMAP record and its archived
// copy. The archive promotes its gmail hex into message_id when the original had
// no real Message-ID, and the live fetch uses the IMAP UID as `id` with no hex.
// Those are source-specific and would split the same email into two keys. So:
// trust message_id only when it looks like a real Message-ID; otherwise fall to
// a NORMALIZED from|subject|date signature so the live and archive copies of a
// no-Message-ID email collapse even when their headers differ by case, display
// format, or whitespace (Codex peer review 2026-06-23).
function messageDedupKey(msg) {
  const realMessageId =
    typeof msg.message_id === 'string' && msg.message_id.includes('@') ? msg.message_id : '';
  if (realMessageId) return realMessageId;
  // Normalize: sender to its bare email address (or lowercased display name when
  // no address), subject lowercased + whitespace-collapsed, date to its parsed
  // epoch ms when parseable. This makes the signature robust to encoding/case/
  // format drift between the live and archived copies of the same email.
  const fromKey = emailAddress(msg.from) || senderName(msg.from).toLowerCase();
  const subjectKey = String(msg.subject || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const parsedDate = Date.parse(msg.date || '');
  const dateKey = Number.isFinite(parsedDate)
    ? String(parsedDate)
    : String(msg.date || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
  return `${fromKey}|${subjectKey}|${dateKey}`;
}

// Build the recent-email corpus ExampleCo's model asks for: ONE small incremental
// fetch (only messages newer than the saved UID watermark) UNIONED with the raw
// Gmail archive on disk, de-duped by Gmail message-id.
//
// Why the union: the incremental fetch only returns the small contiguous batch
// just above the watermark, so an older still-unanswered email would vanish if
// we used the fetch alone. The archive ExampleCos those older ones; the fetch
// ExampleCos the brand-new ones. Together they are "all the emails" without a slow
// 300-message full pull.
//
// source === 'imap' when the incremental fetch succeeds (reply-verifier runs
// live). It only degrades to 'local-archive' as a TRUE last resort if even the
// tiny incremental fetch fails.
function buildRegenerationCorpus(limit, options = {}) {
  const watermarkReader = options.watermarkReader || (() => loadActionScanWatermark());
  const liveFetcher = options.liveFetcher || ((n, afterUid) => fetchRecentMessages(n, afterUid));
  const archiveLoader = options.archiveLoader || ((n) => loadArchivedGmailMessages(n));
  // The incremental LIVE fetch stays small/fast (limit). The ARCHIVE backfill
  // reads a deeper window so an older still-unanswered ask outside the newest
  // ~50 archived messages is NOT lost (Codex peer review 2026-06-23). The
  // archive is already on disk, so this read is cheap; downstream filtering +
  // the maxItems cap keep the output tight.
  const archiveBackfill = Number.isFinite(options.archiveBackfill)
    ? options.archiveBackfill
    : Math.max(limit, 300);

  // Accept either the { uid } object shape (file format + injected tests) or a
  // bare number (gmail-amy-scan's loadUidWatermark), and treat 0/missing as "no
  // watermark yet" -> small top-up fetch with no --after-uid.
  const watermark = watermarkReader();
  const watermarkUid =
    typeof watermark === 'number' ? watermark : watermark && Number(watermark.uid);
  const afterUid = Number.isFinite(watermarkUid) && watermarkUid > 0 ? watermarkUid : null;
  const archived = archiveLoader(archiveBackfill);

  let fresh;
  try {
    fresh = liveFetcher(limit, afterUid);
  } catch (e) {
    // The incremental fetch failed: fall back to the archive ONLY. Never the
    // 300-message full live pull. No watermark advance on failure.
    if (archived.length) {
      return { messages: archived, source: 'local-archive', fetchError: e.message || String(e) };
    }
    throw e;
  }

  // The live fetch succeeded. Compute the watermark FLOOR to persist, but do NOT
  // write it here: main() persists it only AFTER the durable action artifact is
  // written, so a crash mid-write can never leave a UID receipt claiming mail
  // was handled when the artifact was not updated (Codex peer review 2026-06-23).
  //
  // The floor is max(effective seed floor, highest UID pulled). Carrying the
  // effective floor forward persists the seed even when zero new mail arrived,
  // so the "seed once then decouple" invariant becomes durable on the first run.
  const floorUid = Number.isFinite(watermarkUid) ? watermarkUid : 0;
  const candidateWatermarkUid = Math.max(floorUid, highestUid(fresh));
  // Optional eager writer for unit-testing the advance decision in isolation.
  if (options.watermarkWriter && candidateWatermarkUid > floorUid) {
    options.watermarkWriter(candidateWatermarkUid);
  }

  // De-duped union: the incremental fetch wins on conflict (freshest copy),
  // then older archived messages fill in still-unanswered asks.
  const byKey = new Map();
  for (const msg of Array.isArray(fresh) ? fresh : []) byKey.set(messageDedupKey(msg), msg);
  for (const msg of archived) {
    const key = messageDedupKey(msg);
    if (!byKey.has(key)) byKey.set(key, msg);
  }
  return {
    messages: [...byKey.values()],
    source: 'imap',
    fetchError: null,
    candidateWatermarkUid,
  };
}

// Back-compat shim: existing callers/tests that only inject liveFetcher +
// archiveLoader still work. The union is the real path; this preserves the old
// signature for the local-archive fallback test.
function fetchMessagesForRegeneration(limit, options = {}) {
  return buildRegenerationCorpus(limit, options);
}

// A SUCCESSFUL incremental live fetch that returns zero new messages is the
// normal steady state (ExampleCo gets ~20 emails/day; after a recent run there is
// often nothing new). It must flow through write/verify/watermark so ExampleCod
// still-open asks survive and reply verification still runs. Only a fallback
// path (local archive) that found literally nothing is fatal, since that means
// we have no source of truth at all (Codex peer review 2026-06-23).
function isEmptyCorpusFatal(fetched) {
  return !(fetched && fetched.messages && fetched.messages.length) && fetched.source !== 'imap';
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/â€™|â€˜/g, "'")
    .replace(/â€œ|â€/g, '"')
    .replace(/â€”|â€“/g, ' - ')
    .replace(/â€‹/g, '')
    .replace(/=C2=A0/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, '"')
    .replace(/&mdash;|&ndash;/gi, ' - ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function cleanText(text, max = 700) {
  const noHtml = decodeEntities(text)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[[^\]]{1,80}\]\(https?:\/\/[^)]+\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return noHtml.slice(0, max).trim();
}

function senderName(from) {
  const s = decodeEntities(from || '').trim();
  const m = s.match(/^"?([^"<]+)"?\s*</);
  return (m ? m[1] : s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() || 'PRIVATE_NAME sender';
}

function emailAddress(raw) {
  const s = String(raw || '').toLowerCase();
  const m = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  return m ? m[0] : '';
}

function domainOf(raw) {
  const addr = emailAddress(raw);
  return addr.includes('@') ? addr.split('@')[1] : '';
}

function slug(text, max = 72) {
  return (
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max) || 'gmail-item'
  );
}

function isoDate(raw) {
  const ms = Date.parse(raw || '');
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function daysOld(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
}

function firstSentence(text, max = 240) {
  const clean = cleanText(text, max + 120);
  const m = clean.match(/^(.{40,}?[.!?])\s+/);
  const s = (m ? m[1] : clean).slice(0, max).trim();
  return s || 'Recent Gmail message needs a current human review.';
}

const PROMO_RE =
  /\b(unsubscribe|view in browser|privacy notice|terms & conditions|limited time|shop now|shop|sale|free gift|gift alert|gifts for|personalized gift|personalized guidance|fee-waived personalized guidance|deal|deals|cash bonus|cashback|pay less|bonus points|earn up to|offer disappears|rental car|car's value|credit score|webinar|newsletter|digest|promotion|sponsor|trial ended|market your business|coupon|off\b|address book|did you know|commercial auto|small business insurance|transaction history|receipt for payment|payment receipt|receipt|is hiring|job alert|product director|delivery update|shipped:|your order|ordered:|order update|prime day|review it on amazon|meet your expectations|survey|share your thoughts|rate your transaction|public comment hearing|wrist health exercises|wwe night of champions|we'?ll let you in on a secret)\b/i;
const HARD_PROMO_SUBJECT_RE =
  /\b(receipt for payment|payment receipt|payment (?:has been )?received|new e-?statement is now available|statement is now available|e-?transfer.*successfully deposited|weekend rundown|retired yet|bonus points|coupon|personalized gift|personalized guidance|fee-waived personalized guidance|gifts? for|cashback|pay less|deals?|credit score|car's value|is hiring|job alert|product director|delivery update|shipped:|your order|ordered:|order update|prime day|mark your calendar|review it on amazon|meet your expectations|rate your transaction|share your thoughts|welcome to|public comment hearing|your expertise is requested|bill is available online|copa mundial|fifa|father'?s day reservations|rare spirits sale|age of high performance|mlb\.tv|connect your email to your brand|wrist health exercises|wwe night of champions|we'?ll let you in on a secret|off\b)\b/i;
const BULK_SENDER_RE =
  /\b(no-?reply|donotreply|marketing|newsletter|notifications?|updates?|customer service|e-?stmt|estmt|account services?|support@primallifeorganics|constantcontact|meetup|substack|medium|quora|noreply|bytesize|espn|peacock|ally invest|gmb praxis|red headed hostess|td canada trust|atmosenergy|atmos energy)\b/i;
const HUMAN_ASK_RE =
  /\b(please|can you|could you|would you|let me know|please reply|please respond|confirm|approve|approval|review|sign|send me|send over|follow up|following up|checking in|schedule|scheduling|calendar|introduction|intro)\b/i;
const SYSTEM_ACTION_RE =
  /\b(action required|needs your attention|payment failed|past due|federal notice|policy needs|complete your policy|renewal|invoice|bill is available|e-statement|statement is now available|document available|uploaded|shared|data room)\b/i;
const LOW_VALUE_FEEDBACK_RE =
  /\b(review it on amazon|meet your expectations|rate your transaction|share your thoughts|take (?:a|our) survey|customer satisfaction survey)\b/i;

function isFromExampleCo(msg) {
  const addr = emailAddress(msg.from);
  if (addr === ExampleCo_EMAIL || addr === ExampleCo_WORK_EMAIL) return true;
  return /^ExampleCo\s+ExampleCo$/i.test(senderName(msg.from));
}

function isCalendarOrMeetingArtifact(msg) {
  const subject = cleanText(msg.subject || '', 240);
  const body = cleanText(msg.body || '', 1500);
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  const hasCalendarAttachment = attachments.some(
    (att) =>
      /text\/calendar|application\/ics/i.test(att.content_type || '') ||
      /\.ics$/i.test(att.filename || ''),
  );
  const meetingChrome =
    /\b(Microsoft Teams|Meeting ID|Join the meeting|Add to calendar|Google Calendar|Outlook Calendar|RSVP)\b/i.test(
      body,
    );
  const meetingSubject =
    /\b(meeting recap|steering committee|calendar|invitation|invite|event)\b/i.test(subject);
  const explicitAsk =
    /\b(ExampleCo,?\s+please|please\s+(?:confirm|reply|respond|send|review)|can you|could you|would you|let me know|need you to|are you able to)\b/i.test(
      body,
    );
  return (hasCalendarAttachment || (meetingSubject && meetingChrome)) && !explicitAsk;
}

// 2026-06-07 (ExampleCo): action items kept surfacing daily-FYI spam -- receipts,
// monthly statements, "your recent stay", ticket promos, "opportunities are
// live". "I don't need you to remind me that I got a monthly statement." These
// are informational notifications, not required attention. They slipped through
// because a "system action" keyword (receipt/order/statement) bypassed the promo
// filter. A purely informational notification is NOT an ask unless a real human
// asks ExampleCo to do something, or it is genuinely urgent (payment failed / past
// due / deadline -- priorityFor === 1).
const NOTIFICATION_FYI_RE =
  /\b(receipt|payment receipt|e-?statement|statement is (now )?available|monthly statement|account statement|your (recent )?stay|your booking|booking confirmation|reservation (confirmed|confirmation)|your order|ordered:|order (confirmation|update|shipped)|has shipped|shipped:|tickets? to\b|get .{0,30}tickets|opportunities are (now )?live|is now live|are (now )?live|price drop|back in stock|welcome to|verify your (email|account)|confirm your (email|subscription)|new (login|sign-?in)|security alert|thanks for your (order|purchase|payment|booking)|payment (?:has been )?received|payment confirmation|e-?transfer.*successfully deposited|your bill is (now )?available|bill is (now )?available online|online bill|bill is (now )?ready|bill is ready to be viewed|view your (online )?bill|weekend rundown|this week.?s|newsletter|digest|prime day|mark your calendar|review it on amazon|meet your expectations|rate your transaction|share your thoughts|public comment hearing|your expertise is requested|fee-waived personalized guidance|personalized guidance|wrist health exercises|we'?ll let you in on a secret|wwe night of champions|is it making a difference)\b/i;

// Dev/test/sandbox system notifications are NEVER a ExampleCo action item, even when
// they mention "issues"/"delivery"/"failed" (which trip the system-action
// keywords). ExampleCo 2026-06-08: a "[Sandbox] Stripe webhook delivery issues [test
// mode]" alert is dev noise. Hard-drop regardless of human-ask wording.
const DEV_TEST_NOTIFICATION_RE =
  /\[sandbox\]|\[test ?mode\]|\btest mode\b|\bsandbox\b.{0,40}\b(webhook|api|payment|charge|event)|\b(webhook|api event)\b.{0,40}\btest mode\b/i;
// Marketing/solicitation blasts that imitate a personal ask ("Let's make sure
// your loved ones are protected") -- insurance/financial-services promos. Their
// imperative phrasing fools the human-ask detector, so they hard-drop.
const SOLICITATION_RE =
  /\bloved ones (are|stay|will be) protected\b|\bmake sure your loved ones\b|\b(life|final expense|term|whole life) insurance\b|\bprotect your (family|loved ones|legacy)\b|\b(get|request) (a |your )?(free )?quote\b/i;
// Promotional/marketing UPSELL blasts that personalize the subject with a first
// name so they read like a real note but are pure "save money / you are
// overpaying / boost your credit" marketing (Experian "ExampleCo, still paying for
// subscriptions you don't use?"). The CATEGORY is upsell marketing copy, not one
// brand. Hard-drop regardless of human-ask/system-action wording, because the
// personalized imperative phrasing is exactly what fools the ask detector.
// -> feedback: action items drop promotional upsell marketing (ExampleCo 2026-07-07).
const PROMO_UPSELL_RE =
  /\b(still paying for (?:subscriptions?|services?)|subscriptions? you (?:don'?t|do not|no longer) use|cancel (?:unwanted|unused) subscriptions?|stop (?:overpaying|wasting money)|(?:you'?re|you are) (?:overpaying|still paying)|save (?:money|\$?\d+).{0,30}(?:subscriptions?|bills?|monthly|each month|per month)|lower your bills?|find (?:hidden|unused) subscriptions?|manage your subscriptions?|boost your credit score|raise your credit score|check your (?:free )?credit score|unlock (?:your )?(?:savings|offers?)|upgrade to (?:premium|pro|plus) today|claim your (?:reward|offer|discount)|your (?:free )?trial (?:is ending|expires))\b/i;

function isLikelyActionable(msg) {
  const subject = cleanText(msg.subject || '', 240);
  const body = cleanText(msg.body || '', 1200);
  const combined = `${subject}\n${body}`;
  const from = `${msg.from || ''} ${domainOf(msg.from)}`;
  if (!subject || isFromExampleCo(msg)) return false;
  if (/^(ordered|shipped):/i.test(subject)) return false;
  if (
    /amazon/i.test(from) &&
    /\b(your orders|thanks for your order|order #|buy again|prime day|review it on amazon|meet your expectations)\b/i.test(
      combined,
    )
  )
    return false;
  if (isCalendarOrMeetingArtifact(msg)) return false;
  if (/^(accepted|declined|tentative|updated|canceled):/i.test(subject)) return false;
  if (HARD_PROMO_SUBJECT_RE.test(subject)) return false;
  // Dev/test-mode notifications and insurance/financial solicitations are never a
  // real ask, even when they carry system-action or imperative wording.
  if (DEV_TEST_NOTIFICATION_RE.test(combined)) return false;
  if (SOLICITATION_RE.test(combined)) return false;
  if (PROMO_UPSELL_RE.test(combined)) return false;
  const hasHumanAsk = HUMAN_ASK_RE.test(combined);
  const hasSystemAction = SYSTEM_ACTION_RE.test(combined);
  // Drop FYI notifications (receipts/statements/stays/promos) that no human is
  // asking ExampleCo to act on and that are not urgent. This is the "bounce it
  // against required attention" gate -> feedback_briefing_status_means_action.
  const isNotificationFyi =
    NOTIFICATION_FYI_RE.test(subject) || NOTIFICATION_FYI_RE.test(body.slice(0, 400));
  if (LOW_VALUE_FEEDBACK_RE.test(combined)) return false;
  if (isNotificationFyi && !hasHumanAsk && priorityFor(msg) !== 1) return false;
  if (!hasHumanAsk && !hasSystemAction) return false;

  if (PROMO_RE.test(combined) && !hasSystemAction) return false;
  if (BULK_SENDER_RE.test(from) && !hasSystemAction) return false;
  if (
    /klaviyo|constantcontact|mailchimp|sendgrid|geopod-ismtpd/i.test(
      String(msg.message_id || ''),
    ) &&
    !hasSystemAction
  )
    return false;
  if (/^(re|fwd?):/i.test(subject) && /thanks|thank you|received|got it/i.test(body)) return false;
  return true;
}

function priorityFor(msg) {
  const s = `${msg.subject || ''}\n${msg.body || ''}`;
  if (
    /action required|past due|payment failed|federal notice|deadline|due today|needs your attention/i.test(
      s,
    )
  )
    return 1;
  if (/please|can you|could you|review|approve|sign|confirm|quote|data room/i.test(s)) return 2;
  return 3;
}

// Verb-led exec summary per feedback_gmail_summary_labels.md: every Gmail item
// must read "Reply to <person> re: <topic>" or "Review <topic> from <person>",
// never the raw email body and never internal schema terms like "open commitment".
function execSummary(from, subject, body, age) {
  const combined = `${subject}\n${body}`;
  const isHumanAsk =
    /(please reply|please respond|let me know|when works|got time|are you available|can you|could you|would you|reply when|introduce|introduction|intro\b|follow up|following up|checking in)/i.test(
      combined,
    );
  const isFinancialNotice =
    /(payment failed|past due|federal notice|action required|needs your attention|deadline|due today|invoice|bill is available|e-statement|statement is now available|renewal)/i.test(
      combined,
    );
  const subjectShort = subject.replace(/^(re|fwd?):\s*/i, '').slice(0, 80);
  const ageNote = age === 0 ? 'today' : `${age}d old`;
  if (isFinancialNotice) {
    return `Review "${subjectShort}" from ${from} (${ageNote})`;
  }
  if (isHumanAsk) {
    return `Reply to ${from} re: "${subjectShort}" (${ageNote})`;
  }
  return `Reply to ${from} re: "${subjectShort}" (${ageNote})`;
}

function buildItem(msg, rank) {
  const sentAt = isoDate(msg.date);
  const subject = cleanText(msg.subject || '(no subject)', 180);
  const from = senderName(msg.from);
  const body = cleanText(msg.body || '', 1200);
  const threadId = slug(`${from}-${subject}`);
  const gmailUrl =
    msg.gmailUrl ||
    msg.gmail_url ||
    'https://mail.google.com/mail/u/0/#search/' +
      encodeURIComponent(`subject:"${subject.slice(0, 100)}"`);
  const preview = firstSentence(body, 260);
  const age = daysOld(sentAt);
  return {
    rank,
    person: from,
    subject,
    threadId,
    sentAt,
    daysOld: age,
    summary: execSummary(from, subject, body, age),
    preview,
    gmailUrl,
    source: msg.source || 'gmail-imap-current-inbox',
    sourceMessageId: msg.message_id || msg.id || '',
  };
}

// ExampleCo 2026-07-01: an item ExampleCo explicitly asked to KEEP (a curated/pinned ask,
// e.g. a "tax" note) was dropped on a later regeneration because every prune
// path is source-driven: carry-forward re-runs isLikelyActionable + the age
// cap, and the reply verifier drops rows whose repliedAt > sentAt. None of that
// respects ExampleCo's decision to keep an item. A pinned item is a durable floor:
// once ExampleCo marks keep:true (or pinned:true), the regeneration never drops it,
// even when it is not re-derived from the current Gmail source. It leaves only
// when ExampleCo resolves it (resolvedAt set) -- source heuristics do not overrule a
// human keep. Same shape as standing reminders, but scoped to a specific ask.
function isPinnedActionItem(item) {
  return !!(item && (item.keep === true || item.pinned === true) && !item.resolvedAt);
}

function existingDismissedSignatures(existing) {
  const replied = new Set();
  for (const item of existing.unansweredEmails || []) {
    if (!item.repliedAt || !item.sentAt) continue;
    const r = Date.parse(item.repliedAt);
    const s = Date.parse(item.sentAt);
    if (Number.isFinite(r) && Number.isFinite(s) && r > s) {
      replied.add(`${slug(item.person)}|${slug(item.subject)}`);
    }
  }
  return replied;
}

function loadExisting() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function activeUnansweredEmails(existing) {
  return (Array.isArray(existing && existing.unansweredEmails) ? existing.unansweredEmails : [])
    .filter((item) => {
      // A pinned item survives even a detected reply: ExampleCo kept it on purpose.
      if (isPinnedActionItem(item)) return true;
      const r = Date.parse(item && item.repliedAt ? item.repliedAt : '');
      const s = Date.parse(item && item.sentAt ? item.sentAt : '');
      return !(Number.isFinite(r) && Number.isFinite(s) && r > s);
    })
    .filter((item) => {
      // A pinned item bypasses the source/actionability/age prune entirely.
      if (isPinnedActionItem(item)) return true;
      const source = String(item?.source || '');
      if (!/gmail|imap|archive|inbox/i.test(source)) return true;
      const msgLike = {
        subject: item?.subject || item?.title || item?.summary || '',
        body: [item?.summary, item?.preview, item?.detail].filter(Boolean).join('\n'),
        from: item?.person || '',
        date: item?.sentAt || item?.date || '',
        message_id: item?.sourceMessageId || item?.message_id || '',
      };
      if (!isLikelyActionable(msgLike)) return false;
      const age = Number.isFinite(Number(item?.daysOld))
        ? Number(item.daysOld)
        : daysOld(item?.sentAt || item?.date);
      return !Number.isFinite(age) || age <= CURRENT_EMAIL_MAX_AGE_DAYS;
    })
    .map((item, ix) => ({ ...item, rank: ix + 1 }));
}

function collapseGuardForActionItems(existing, nextUnansweredEmails, options = {}) {
  if (options.allowCollapse) return null;
  const previous = activeUnansweredEmails(existing);
  const previousCount = previous.length;
  const nextCount = Array.isArray(nextUnansweredEmails) ? nextUnansweredEmails.length : 0;
  if (previousCount < 3) return null;
  const collapseFloor = Math.max(1, Math.floor(previousCount * 0.35));
  if (nextCount > collapseFloor) return null;
  const recentReplies = previous.filter((item) => {
    const r = Date.parse(item.repliedAt || '');
    const s = Date.parse(item.sentAt || '');
    return Number.isFinite(r) && Number.isFinite(s) && r > s;
  }).length;
  if (recentReplies >= previousCount - nextCount) return null;
  return {
    triggered: true,
    previousCount,
    attemptedCount: nextCount,
    preservedCount: previousCount,
    reason: `action-item rebuild collapsed from ${previousCount} active ask(s) to ${nextCount} without matching reply proof`,
    previousGeneratedAt: existing.generatedAt || existing.lastFullReviewAt || null,
  };
}

function writeActionArtifact(messages, options) {
  const existing = loadExisting();
  const repliedSigs = existingDismissedSignatures(existing);
  const seen = new Set();
  const candidates = [];
  for (const msg of messages) {
    if (!isLikelyActionable(msg)) continue;
    const sig = `${slug(senderName(msg.from))}|${slug(msg.subject)}`;
    if (seen.has(sig) || repliedSigs.has(sig)) continue;
    seen.add(sig);
    candidates.push(msg);
  }
  candidates.sort((a, b) => {
    const p = priorityFor(a) - priorityFor(b);
    if (p) return p;
    return Date.parse(b.date || '') - Date.parse(a.date || '');
  });
  // The maxItems cap is a DISPLAY cap on FRESH items only. Compute the capped
  // fresh list FIRST, then carry forward any prior still-open ask not already
  // represented in that FINAL list. De-duping carry-forward against the CAPPED
  // fresh list (not the full fresh list) is what guarantees a prior open ask
  // that was re-fetched but ranked below the cap is still preserved instead of
  // being both sliced out of fresh AND excluded from carry-forward (Codex peer
  // review 2026-06-23). A still-open ask must survive until reply proof.
  const cappedFreshItems = candidates
    .filter((msg) => daysOld(msg.date) <= CURRENT_EMAIL_MAX_AGE_DAYS)
    .slice(0, options.maxItems)
    .map((msg, ix) => buildItem(msg, ix + 1));
  const cappedFreshSigs = new Set(
    cappedFreshItems.map((it) => `${slug(it.person)}|${slug(it.subject)}`),
  );
  const ExampleCodForward = activeUnansweredEmails(existing).filter(
    (it) => !cappedFreshSigs.has(`${slug(it.person)}|${slug(it.subject)}`),
  );
  let unansweredEmails = [...cappedFreshItems, ...ExampleCodForward].map((item, ix) => ({
    ...item,
    rank: ix + 1,
  }));
  const now = new Date().toISOString();
  const collapseGuard = collapseGuardForActionItems(existing, unansweredEmails, options);
  if (collapseGuard) {
    unansweredEmails = activeUnansweredEmails(existing);
  }
  const output = {
    generatedAt: now,
    lastFullReviewAt: now,
    generatedBy: `regenerate-action-items.js current Gmail ${options.source === 'local-archive' ? 'local archive' : 'inbox'} rebuild on ${now}; fetched ${messages.length} recent messages, filtered ${candidates.length} actionable candidates, wrote ${unansweredEmails.length} current items.${collapseGuard ? ` Collapse guard preserved the previous active ask list because ${collapseGuard.reason}.` : ''}${options.source === 'local-archive' ? ' Live IMAP was unavailable, so this pass used saved raw Gmail archive records.' : ' Reply verifier runs immediately after this write.'}`,
    reviewWindow: {
      date: options.date,
      fetchedMessages: messages.length,
      actionableCandidates: candidates.length,
      maxItems: options.maxItems,
      method:
        options.source === 'local-archive'
          ? 'local raw Gmail archive fallback; sent-mail reply verifier skipped unless live IMAP is available'
          : 'IMAP INBOX current pull plus sent-mail reply verifier',
      source: options.source || 'imap',
      fetchError: options.fetchError || undefined,
      collapseGuard: collapseGuard || undefined,
    },
    unansweredEmails,
    openCommitments: mergeStandingIntoCommitments([], loadStandingReminders(), new Date()),
    supersededCommitments: Array.isArray(existing.supersededCommitments)
      ? existing.supersededCommitments
      : [],
    recentActivity: [],
    falseFlags: [],
  };
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
  if (collapseGuard) log({ event: 'collapse-guard', ...collapseGuard, output: DATA_PATH });
  return output;
}

// The reply verifier walks the live sent-mail folder over IMAP; it is slow by
// nature, not hung. Measured DESKTOP runtime on the fast path with working
// credentials: 575.6s ("[verify-replies] matched 1/11 items", exit 0). The old
// 4-minute bound therefore killed a HEALTHY verifier every single run, and on
// EC2 the SIGTERM surfaced as `verifier.ok=false`, which blocked action_items.
// 15 minutes gives real headroom over the measured worst case; override with
// ACTION_ITEMS_VERIFY_TIMEOUT_MS when a mailbox legitimately needs longer.
const REPLY_VERIFIER_TIMEOUT_MS =
  Number(process.env.ACTION_ITEMS_VERIFY_TIMEOUT_MS) > 0
    ? Number(process.env.ACTION_ITEMS_VERIFY_TIMEOUT_MS)
    : 15 * 60 * 1000;

// Every non-ok outcome ExampleCos a distinguishable REASON. The old shape returned
// a bare `ok:false` with empty stdout/stderr for BOTH a timeout kill and a
// missing script, so on EC2 (where scripts/verify-action-item-replies.py was
// never in the deploy manifest) a hard deploy gap read as an ordinary skip for
// an ExampleCo length of time. A verifier that did not run must say WHY.
// Injectable spawn/script/timeout so tests can drive every failure shape
// deterministically instead of depending on a real python + live IMAP.
function runReplyVerifier({
  spawn = spawnSync,
  script = path.join(REPO, 'scripts', 'verify-action-item-replies.py'),
  python = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'),
  timeoutMs = REPLY_VERIFIER_TIMEOUT_MS,
} = {}) {
  const scriptRel = path.relative(REPO, script).replace(/\\/g, '/');
  if (!fs.existsSync(script)) {
    return {
      ok: false,
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      scriptMissing: true,
      reason: `reply verifier script is not present at ${scriptRel} (deploy manifest gap, not a verifier failure)`,
    };
  }
  const result = spawn(python, [script, '--repo', REPO], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  const errorCode = result.error && result.error.code ? String(result.error.code) : '';
  const record = {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal || null,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
  if (record.ok) return record;
  // spawnSync signals a timeout kill as error.code ETIMEDOUT plus the kill
  // signal; keep the signal-only shape as a fallback for the same category.
  if (errorCode === 'ETIMEDOUT' || (result.status === null && result.signal && !errorCode)) {
    record.timedOut = true;
    record.timeoutMs = timeoutMs;
    record.reason =
      `reply verifier exceeded its ${Math.round(timeoutMs / 1000)}s bound and was killed` +
      ` (${result.signal || 'no signal'}); raise ACTION_ITEMS_VERIFY_TIMEOUT_MS if the mailbox needs longer`;
    return record;
  }
  if (errorCode === 'ENOENT') {
    record.spawnFailed = true;
    record.reason = `could not launch the reply verifier: "${python}" not found on PATH (set PYTHON_BIN)`;
    return record;
  }
  if (errorCode) {
    record.spawnFailed = true;
    record.reason = `reply verifier spawn failed (${errorCode}): ${String(
      result.error.message || result.error,
    ).slice(0, 300)}`;
    return record;
  }
  record.reason = `reply verifier exited ${result.status}`;
  return record;
}

function dropVerifiedReplies() {
  const data = loadExisting();
  const kept = [];
  const replied = [];
  for (const item of data.unansweredEmails || []) {
    // A pinned item is never dropped by the reply verifier: ExampleCo asked to keep it.
    if (isPinnedActionItem(item)) {
      kept.push(item);
      continue;
    }
    const r = Date.parse(item.repliedAt || '');
    const s = Date.parse(item.sentAt || '');
    if (Number.isFinite(r) && Number.isFinite(s) && r > s) replied.push(item);
    else kept.push(item);
  }
  data.unansweredEmails = kept.map((item, ix) => ({ ...item, rank: ix + 1 }));
  data.recentActivity = [
    ...(Array.isArray(data.recentActivity) ? data.recentActivity : []),
    ...replied.map((item) => ({
      type: 'replied-action-item',
      person: item.person,
      subject: item.subject,
      repliedAt: item.repliedAt,
      note: 'Dropped from unansweredEmails by regenerate-action-items.js after sent-mail verification.',
    })),
  ].slice(-50);
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return replied.length;
}

function recordReplyVerifier(verifier, droppedReplies = 0) {
  const data = loadExisting();
  const finalUnansweredCount = Array.isArray(data.unansweredEmails)
    ? data.unansweredEmails.filter((item) => {
        if (isPinnedActionItem(item)) return true;
        const r = Date.parse(item && item.repliedAt ? item.repliedAt : '');
        const s = Date.parse(item && item.sentAt ? item.sentAt : '');
        return !(Number.isFinite(r) && Number.isFinite(s) && r > s);
      }).length
    : 0;
  data.reviewWindow = {
    ...(data.reviewWindow || {}),
    replyVerifier: verifier,
    droppedReplies,
    finalUnansweredCount,
  };
  if (verifier && verifier.ok && !verifier.skipped && !data.lastReplyVerificationAt) {
    data.lastReplyVerificationAt = new Date().toISOString();
  }
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return data;
}

function main() {
  const date = argValue('--date', todayCt());
  // Small cap, not a 300-message window: ExampleCo gets ~20 emails/day, the UID
  // watermark makes the incremental fetch the fast path, and the archive union
  // backfills older still-unanswered asks (ExampleCo 2026-06-22).
  const limit = Number(argValue('--limit', process.env.ACTION_ITEMS_GMAIL_LIMIT || '50'));
  const maxItems = Number(argValue('--max-items', process.env.ACTION_ITEMS_MAX_ITEMS || '10'));
  const dryRun = process.argv.includes('--dry-run');
  const skipReplyVerify = process.argv.includes('--skip-reply-verify');
  const allowCollapse = process.argv.includes('--allow-collapse');
  const source = argValue('--source', process.env.ACTION_ITEMS_SOURCE || 'auto');

  const fetched =
    source === 'local-archive'
      ? {
          // Forced archive-only mode keeps the deep window (not the small live
          // cap) so it is not a regression from the prior 300-message fallback.
          messages: loadArchivedGmailMessages(Math.max(limit, 300)),
          source: 'local-archive',
          fetchError: null,
        }
      : buildRegenerationCorpus(limit);
  if (isEmptyCorpusFatal(fetched)) {
    throw new Error(`no Gmail messages available from ${fetched.source}`);
  }
  const messages = fetched.messages;
  const artifact = writeActionArtifact(messages, {
    date,
    maxItems,
    source: fetched.source,
    fetchError: fetched.fetchError,
    allowCollapse,
  });
  let verifier = { ok: true, skipped: true };
  let droppedReplies = 0;
  if (!dryRun && !skipReplyVerify && fetched.source !== 'local-archive') {
    verifier = runReplyVerifier();
    if (verifier.ok) droppedReplies = dropVerifiedReplies();
  } else if (fetched.source === 'local-archive' && !skipReplyVerify) {
    verifier = {
      ok: true,
      skipped: true,
      reason:
        'live IMAP fetch failed; regenerated from local raw Gmail archive, so live sent-mail verifier was skipped',
    };
  }
  const finalArtifact = recordReplyVerifier(verifier, droppedReplies);
  // Persist the UID watermark ONLY now that the durable action artifact and
  // reply-verifier metadata are written. Advancing earlier could leave a UID
  // receipt claiming mail was handled after a mid-write crash (Codex peer
  // review 2026-06-23). Only the live path produces a candidate.
  if (
    fetched.source === 'imap' &&
    Number.isFinite(fetched.candidateWatermarkUid) &&
    fetched.candidateWatermarkUid > 0
  ) {
    saveActionScanWatermark(fetched.candidateWatermarkUid);
  }
  const summary = {
    ok: verifier.ok !== false,
    date,
    source: fetched.source,
    fetchError: fetched.fetchError,
    fetchedMessages: messages.length,
    writtenItems: artifact.unansweredEmails.length,
    finalItems: Array.isArray(finalArtifact.unansweredEmails)
      ? finalArtifact.unansweredEmails.length
      : artifact.unansweredEmails.length,
    droppedReplies,
    verifier,
    output: DATA_PATH,
  };
  log({ event: 'regenerate-finish', ...summary });
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    log({ event: 'regenerate-error', error: e.message || String(e) });
    console.error('[regenerate-action-items] ' + (e.message || e));
    process.exit(1);
  }
}

module.exports = {
  isLikelyActionable,
  buildItem,
  archiveMessageToRecentMessage,
  fetchMessagesForRegeneration,
  buildRegenerationCorpus,
  isEmptyCorpusFatal,
  loadActionScanWatermark,
  saveActionScanWatermark,
  highestUid,
  messageDedupKey,
  loadArchivedGmailMessages,
  writeActionArtifact,
  activeUnansweredEmails,
  collapseGuardForActionItems,
  recordReplyVerifier,
  dropVerifiedReplies,
  isPinnedActionItem,
  runReplyVerifier,
  REPLY_VERIFIER_TIMEOUT_MS,
};
