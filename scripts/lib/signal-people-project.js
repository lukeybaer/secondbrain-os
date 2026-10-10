'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { askAI } = require('./ask-ai.js');
const { ensureCodexWorktree, resolveCodexSourceRoot } = require('./codex-worktree.js');
const { assertNoForbiddenPeople, findForbiddenPeople } = require('./forbidden-people.js');
const { landScanOutputs } = require('./scan-output-lander.js');
const { atomicWriteJson, phoneDigits, readJson, sha256 } = require('./signal-ingest.js');

const START = '<!-- amy-signal-activity:start -->';
const END = '<!-- amy-signal-activity:end -->';

function peopleReceiptFile(stateRoot, eventId) {
  return path.join(stateRoot, 'people', `${eventId}.json`);
}

function linkContextForEvent(eventDir) {
  return readJson(path.join(eventDir, 'links', 'context.json'), { links: [] });
}

function peopleInputFingerprint(normalized, linkContext = { links: [] }) {
  return sha256(
    JSON.stringify({
      eventId: normalized && normalized.id,
      direction: normalized && normalized.direction,
      referenceTime: normalized && normalized.referenceTime,
      text: normalized && normalized.text,
      links: (linkContext.links || []).map((link) => ({
        id: link.id,
        canonicalUrl: link.canonicalUrl || link.url,
        title: link.title || '',
        description: link.description || '',
        excerpt: String(link.excerpt || '').slice(0, 20_000),
        transcript: String(link.transcript || '').slice(0, 30_000),
      })),
    }),
  );
}

// A staged receipt means the event is durably queued for the daily noon
// People-file batch (AMY_REQUIREMENTS "Daily People-file consolidation"). It
// satisfies the Signal flow-health People stage (an accepted staging receipt
// closes the intake job) but is NOT a projection: pendingPeopleEvents keeps
// selecting the event until the noon batch writes a complete/skipped receipt.
function peopleReceiptIsStaged(receipt, fingerprint) {
  return Boolean(
    receipt &&
      receipt.schema === 'amy.signal.people-projection.v2' &&
      receipt.status === 'staged' &&
      String(receipt.inputFingerprint || '') === String(fingerprint || ''),
  );
}

function peopleReceiptIsCurrent(receipt, fingerprint) {
  if (
    !receipt ||
    receipt.schema !== 'amy.signal.people-projection.v2' ||
    String(receipt.inputFingerprint || '') !== String(fingerprint || '')
  ) {
    return false;
  }
  if (receipt.status === 'complete') {
    return Boolean(receipt.contactFile && receipt.landing?.ok === true);
  }
  if (receipt.status === 'skipped') {
    return ['group-or-no-counterparty', 'note-to-self', 'privacy-redacted-person'].includes(
      receipt.reason,
    );
  }
  return false;
}

function finishPeopleStage(event, receipt) {
  const statusFile = path.join(event.dir, 'status.json');
  const status = readJson(statusFile, {});
  status.schema = 'amy.signal.ingest-status.v2';
  status.stages = status.stages || {};
  status.stages.people = {
    status: 'complete',
    at: receipt.at,
    disposition: receipt.status,
    inputFingerprint: receipt.inputFingerprint,
    receiptFile: event.receiptFile,
  };
  status.complete = true;
  status.completedAt = receipt.at;
  atomicWriteJson(statusFile, status);
}

function writePeopleReceipt(event, values) {
  const receipt = {
    schema: 'amy.signal.people-projection.v2',
    eventId: event.normalized.id,
    at: new Date().toISOString(),
    inputFingerprint: event.inputFingerprint,
    ...values,
  };
  atomicWriteJson(event.receiptFile, receipt);
  finishPeopleStage(event, receipt);
  return receipt;
}

function isNoteToSelf(normalized) {
  const account = phoneDigits(normalized && normalized.account);
  return Boolean(account && account === phoneDigits(normalized && normalized.counterparty));
}

function pendingPeopleEvents(stateRoot) {
  const eventsRoot = path.join(stateRoot, 'events');
  if (!fs.existsSync(eventsRoot)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'status.json') {
        const status = readJson(full, {});
        if (status.captureComplete === true) {
          const normalized = readJson(path.join(dir, 'normalized.json'));
          const receiptFile = normalized ? peopleReceiptFile(stateRoot, normalized.id) : '';
          const linkContext = normalized ? linkContextForEvent(dir) : { links: [] };
          const inputFingerprint = normalized ? peopleInputFingerprint(normalized, linkContext) : '';
          const receipt = receiptFile ? readJson(receiptFile, null) : null;
          if (normalized && !peopleReceiptIsCurrent(receipt, inputFingerprint)) {
            out.push({ dir, receiptFile, status, normalized, linkContext, inputFingerprint });
          }
        }
      }
    }
  };
  walk(eventsRoot);
  return out.sort((a, b) => a.normalized.timestamp - b.normalized.timestamp);
}

function contactFiles(contactsDir) {
  if (!fs.existsSync(contactsDir)) return [];
  return fs
    .readdirSync(contactsDir)
    .filter((name) => name.endsWith('.md') && !name.startsWith('_') && name !== 'INDEX.md')
    .map((name) => ({ name, file: path.join(contactsDir, name), body: fs.readFileSync(path.join(contactsDir, name), 'utf8') }));
}

function resolveContact(normalized, contactsDir) {
  const wanted = phoneDigits(normalized.counterparty);
  if (!wanted) return null;
  const tail = wanted.slice(-10);
  const matches = contactFiles(contactsDir).filter((contact) => {
    const phoneLines = contact.body
      .split(/\r?\n/)
      .filter((line) => /\b(phone|mobile|signal)\b/i.test(line));
    return phoneLines.some((line) => {
      const candidates = line.match(/\+?\d[\d ()-]{7,}\d/g) || [];
      return candidates.some((candidate) => {
        const digits = phoneDigits(candidate);
        return digits === wanted || (tail.length === 10 && digits.endsWith(tail));
      });
    });
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Signal contact ${tail} matched multiple People files`);
  return null;
}

function safeSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function inferredName(normalized) {
  const envelope = normalized.envelope || {};
  return envelope.sourceName || envelope.profileName || envelope.sourceNumber || normalized.counterparty || 'Signal contact';
}

function createContact(normalized, contactsDir) {
  const digits = phoneDigits(normalized.counterparty);
  if (!digits) return null;
  const name = inferredName(normalized);
  assertNoForbiddenPeople(`${name}\n${normalized.text || ''}`, 'Signal People-file creation');
  const base = safeSlug(name === normalized.counterparty ? 'signal_contact' : name) || 'signal_contact';
  const file = path.join(contactsDir, `${base}_${digits.slice(-4)}.md`);
  const body = [
    '---',
    `name: ${JSON.stringify(name)}`,
    'relationship: Signal contact',
    `last_interaction: ${normalized.referenceTime.slice(0, 10)}`,
    '---',
    '',
    `# ${name}`,
    '',
    `- **Phone / Signal**: ${normalized.counterparty}`,
    '- **Source**: Automatically created from a direct Signal interaction.',
    '',
  ].join('\n');
  fs.mkdirSync(contactsDir, { recursive: true });
  fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { name: path.basename(file), file, body, created: true };
}

function markPeoplePending(event, error) {
  const statusFile = path.join(event.dir, 'status.json');
  const status = readJson(statusFile, {});
  status.schema = 'amy.signal.ingest-status.v2';
  status.complete = false;
  status.stages = status.stages || {};
  status.stages.people = {
    status: 'pending',
    at: new Date().toISOString(),
    inputFingerprint: event.inputFingerprint,
    lastError: String(error?.message || error).slice(0, 1000),
  };
  atomicWriteJson(statusFile, status);
}

function parseProjection(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const parsed = JSON.parse(cleaned);
  if (!parsed || !Array.isArray(parsed.durable_facts)) throw new Error('Projection response lacks durable_facts array');
  return {
    durableFacts: parsed.durable_facts.map((value) => String(value).trim()).filter(Boolean).slice(0, 12),
    relationshipSummary: String(parsed.relationship_summary || '').trim(),
  };
}

async function projectFacts(contactBody, events, options = {}) {
  const compactEvents = events.map((event) => ({
    event_id: event.normalized.id,
    direction: event.normalized.direction,
    at: event.normalized.referenceTime,
    text: event.normalized.text,
    attachments: (event.normalized.attachments || []).map((a) => ({
      contentType: a && a.contentType,
      filename: a && (a.filename || a.storedFilename),
    })),
    shared_links: (event.linkContext?.links || []).map((link) => ({
      url: link.canonicalUrl || link.url,
      title: link.title || '',
      description: link.description || '',
      excerpt: String(link.excerpt || '').slice(0, 6000),
      transcript: String(link.transcript || '').slice(0, 12000),
    })),
  }));
  const prompt = [
    'Extract only durable people-memory updates from these Signal messages.',
    'Return strict JSON only: {"durable_facts":["..."],"relationship_summary":""}.',
    'A durable fact is a lasting preference, role, relationship, commitment, decision, life event, or recurring context.',
    'Do not copy ordinary chatter, secrets, full message text, phone numbers, or transient logistics.',
    'Use an empty array when nothing is durable. Never invent.',
    '',
    'Existing People file:',
    contactBody.slice(0, 16000),
    '',
    'New Signal events:',
    JSON.stringify(compactEvents),
  ].join('\n');
  const response = await (options.askAI || askAI)(prompt, {
    surface: 'signal-people-project',
    rungOrder: ['codex', 'claude-cli'],
    toolLess: true,
    maxTokens: 1000,
    timeoutMs: 90000,
  });
  return parseProjection(response && response.text);
}

function existingFactLines(body) {
  const start = body.indexOf(START);
  const end = body.indexOf(END);
  if (start < 0 || end < start) return [];
  return body
    .slice(start, end)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('- Fact: '))
    .map((line) => line.slice('- Fact: '.length));
}

function existingEventIds(body) {
  const match = body.match(/^- Processed event IDs:\s*(.*)$/m);
  return match ? match[1].split(',').map((id) => id.trim()).filter(Boolean) : [];
}

function updateContactBody(body, events, projection) {
  const latest = events[events.length - 1].normalized;
  const existing = existingFactLines(body);
  const facts = [...new Set([...existing, ...projection.durableFacts])].slice(-30);
  const eventIds = [...new Set([...existingEventIds(body), ...events.map((event) => event.normalized.id)])].slice(-100);
  const activity = [
    START,
    '## Signal activity (Amy managed)',
    '',
    `- Last interaction: ${latest.referenceTime}`,
    `- Recorded messages in this block: ${eventIds.length}`,
    `- Latest event ID: ${latest.id}`,
    `- Direction of latest: ${latest.direction}`,
    `- Processed event IDs: ${eventIds.join(', ')}`,
    ...(projection.relationshipSummary ? [`- Relationship context: ${projection.relationshipSummary}`] : []),
    ...facts.map((fact) => `- Fact: ${fact}`),
    END,
  ].join('\n');
  const re = new RegExp(`${START}[\\s\\S]*?${END}`, 'm');
  let out = re.test(body) ? body.replace(re, activity) : `${body.trimEnd()}\n\n${activity}\n`;
  if (/^last_interaction:/m.test(out)) {
    out = out.replace(/^last_interaction:.*$/m, `last_interaction: ${latest.referenceTime.slice(0, 10)}`);
  }
  assertNoForbiddenPeople(out, 'Signal People-file projection');
  return out;
}

function cleanupWorktree(sourceRoot, worktree) {
  if (!worktree || !worktree.created) return;
  spawnSync('git', ['worktree', 'remove', '--force', worktree.cwd], { cwd: sourceRoot, encoding: 'utf8', timeout: 120000 });
  if (worktree.branch) spawnSync('git', ['branch', '-D', worktree.branch], { cwd: sourceRoot, encoding: 'utf8', timeout: 30000 });
}

// A People projection is not complete until its changed People file has passed
// the normal land gate. Check that deterministic prerequisite before creating a
// disposable worktree or calling a subscription model, so a missing local hook
// cannot turn the minute healer into a repeated model-spend loop.
function peopleProjectionLandingReadiness(repoRoot, options = {}) {
  const runGit = options.runGit || ((args, cwd) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
    return { ok: result.status === 0, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
  });
  let common;
  try {
    common = runGit(['rev-parse', '--git-common-dir'], repoRoot);
  } catch (error) {
    return { ok: false, reason: `git-common-dir-failed: ${String(error.message || error)}` };
  }
  if (!common?.ok) {
    return { ok: false, reason: `git-common-dir-failed: ${String(common?.stderr || common?.status || 'unknown')}` };
  }
  const rawDir = String(common.stdout || '').trim();
  if (!rawDir) return { ok: false, reason: 'git-common-dir-failed: empty common git directory' };
  const commonDir = path.isAbsolute(rawDir) ? rawDir : path.resolve(repoRoot, rawDir);
  const hook = path.join(commonDir, 'hooks', 'pre-push');
  let source = '';
  try { source = fs.readFileSync(hook, 'utf8'); } catch { /* fail below */ }
  if (source.includes('AMY_LAND_PUSH_PROOF_V1') && source.includes('scripts/git-hooks/pre-push')) {
    return { ok: true, hook };
  }
  return {
    ok: false,
    reason: `master land protection is not installed at ${hook}; run scripts/install-git-hooks.sh before projecting Signal People facts`,
    hook,
  };
}

const BATCH_HOUR_CT = 12;
const BATCH_MARKER = 'people-batch.json';
const BATCH_LIMIT = 1000;

function chicagoParts(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

// One batch per Central day, at or after noon CT. The marker is written only
// after a batch finishes without errors, so a failed noon run retries on the
// next tick instead of waiting a day.
function peopleBatchWindow(stateRoot, now = new Date()) {
  const { date, hour } = chicagoParts(now);
  const marker = readJson(path.join(stateRoot, BATCH_MARKER), {});
  return { date, due: hour >= BATCH_HOUR_CT && marker.lastBatchDate !== date };
}

function stagePendingForNoonBatch(pending, date) {
  let staged = 0;
  for (const event of pending) {
    const existing = readJson(event.receiptFile, null);
    if (peopleReceiptIsStaged(existing, event.inputFingerprint)) continue;
    atomicWriteJson(event.receiptFile, {
      schema: 'amy.signal.people-projection.v2',
      eventId: event.normalized.id,
      at: new Date().toISOString(),
      inputFingerprint: event.inputFingerprint,
      status: 'staged',
      batch: 'daily-noon-ct',
      stagedForDate: date,
    });
    staged += 1;
  }
  return staged;
}

async function runPeopleProjection(options = {}) {
  const stateRoot = options.stateRoot || process.env.SIGNAL_INGEST_ROOT || '/opt/secondbrain-durable/signal-ingest';
  const immediate = options.immediate === true || process.env.SIGNAL_PEOPLE_PROJECT_IMMEDIATE === '1';
  const window = peopleBatchWindow(stateRoot, options.now || new Date());
  const pending = pendingPeopleEvents(stateRoot).slice(0, immediate ? options.limit || 100 : BATCH_LIMIT);
  if (!pending.length) {
    if (!immediate && window.due) markBatchDone(stateRoot, window.date, 0);
    return { ok: true, projected: 0, reason: 'clean' };
  }
  if (!immediate && !window.due) {
    return {
      ok: true,
      projected: 0,
      reason: 'staged-until-noon',
      staged: stagePendingForNoonBatch(pending, window.date),
      pending: pending.length,
    };
  }
  const result = await projectPendingBatch({ ...options, stateRoot, pending });
  if (!immediate && window.due && result.ok === true) markBatchDone(stateRoot, window.date, result.projected || 0);
  return result;
}

function markBatchDone(stateRoot, date, projected) {
  atomicWriteJson(path.join(stateRoot, BATCH_MARKER), {
    schema: 'amy.signal.people-batch.v1',
    lastBatchDate: date,
    at: new Date().toISOString(),
    projected,
  });
}

async function projectPendingBatch(options = {}) {
  const { stateRoot, pending } = options;
  const requestedRoot = options.repoRoot || process.env.SECONDBRAIN_ROOT || '/home/ec2-user/secondbrain-current';
  const resolved = (options.resolveSourceRoot || resolveCodexSourceRoot)(requestedRoot, {
    candidates: ['/home/ec2-user/secondbrain-current'],
  });
  const sourceRoot = resolved.repoRoot;
  const readiness = (options.peopleProjectionLandingReadiness || peopleProjectionLandingReadiness)(sourceRoot);
  if (!readiness.ok) {
    return {
      ok: false,
      projected: 0,
      reason: 'landing-not-ready',
      errors: [{ stage: 'landing-preflight', error: readiness.reason }],
      pendingEventIds: pending.map((event) => event.normalized.id),
    };
  }
  const worktree = (options.ensureWorktree || ensureCodexWorktree)({
    repoRoot: sourceRoot,
    forceNew: true,
    purpose: 'signal-people-project',
    branchPrefix: 'codex/signal-people',
    sessionsRoot: options.sessionsRoot || '/home/ec2-user/sb-sessions',
    baseRef: 'origin/master',
    linkNodeModules: true,
  });

  try {
    const contactsDir = path.join(worktree.cwd, 'memory', 'contacts');
    const groups = new Map();
    const errors = [];
    for (const event of pending) {
      try {
        if (isNoteToSelf(event.normalized)) {
          writePeopleReceipt(event, {
            status: 'skipped',
            reason: 'note-to-self',
          });
          continue;
        }
        const privateText = `${inferredName(event.normalized)}\n${event.normalized.text || ''}`;
        if (findForbiddenPeople(privateText).length) {
          writePeopleReceipt(event, {
            status: 'skipped',
            reason: 'privacy-redacted-person',
          });
          continue;
        }
        let contact = resolveContact(event.normalized, contactsDir);
        if (!contact) contact = createContact(event.normalized, contactsDir);
        if (!contact) {
          writePeopleReceipt(event, {
            status: 'skipped',
            reason: 'group-or-no-counterparty',
          });
          continue;
        }
        const key = contact.file;
        if (!groups.has(key)) groups.set(key, { contact, events: [] });
        groups.get(key).events.push(event);
      } catch (error) {
        markPeoplePending(event, error);
        errors.push({ eventId: event.normalized.id, error: String(error.message || error).slice(0, 500) });
      }
    }

    const projected = [];
    for (const group of groups.values()) {
      try {
        const current = fs.readFileSync(group.contact.file, 'utf8');
        const projection = await projectFacts(current, group.events, options);
        fs.writeFileSync(group.contact.file, updateContactBody(current, group.events, projection), 'utf8');
        projected.push(group);
      } catch (error) {
        if (group.contact.created) {
          try { fs.unlinkSync(group.contact.file); } catch { /* worktree cleanup remains authoritative */ }
        }
        for (const event of group.events) {
          markPeoplePending(event, error);
          errors.push({ eventId: event.normalized.id, error: String(error.message || error).slice(0, 500) });
        }
      }
    }
    if (!projected.length) {
      return {
        ok: errors.length === 0,
        projected: 0,
        reason: errors.length ? 'people-events-pending' : 'no-direct-contact',
        errors,
      };
    }
    const landing = (options.landOutputs || landScanOutputs)({
      repoRoot: worktree.cwd,
      pathspecs: ['memory/contacts'],
      message: `memory: project ${projected.reduce((n, g) => n + g.events.length, 0)} Signal interaction(s)`,
      purpose: 'signal-people-project',
    });
    if (!landing.ok) throw new Error(`People-file landing failed: ${landing.reason || 'unknown'}`);
    for (const group of projected) {
      for (const event of group.events) {
        writePeopleReceipt(event, {
          status: 'complete',
          contactFile: path.relative(worktree.cwd, group.contact.file).replace(/\\/g, '/'),
          landing,
        });
      }
    }
    return {
      ok: errors.length === 0,
      projected: projected.reduce((n, g) => n + g.events.length, 0),
      landing,
      errors,
    };
  } finally {
    cleanupWorktree(sourceRoot, worktree);
  }
}

module.exports = {
  END,
  START,
  contactFiles,
  createContact,
  existingFactLines,
  existingEventIds,
  inferredName,
  isNoteToSelf,
  parseProjection,
  pendingPeopleEvents,
  peopleProjectionLandingReadiness,
  peopleInputFingerprint,
  peopleReceiptIsCurrent,
  peopleReceiptIsStaged,
  peopleBatchWindow,
  peopleReceiptFile,
  projectFacts,
  resolveContact,
  runPeopleProjection,
  safeSlug,
  updateContactBody,
};
