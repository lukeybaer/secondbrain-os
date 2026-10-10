#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { askAI } = require('./lib/ask-ai.js');
const { ensureCodexWorktree, resolveCodexSourceRoot } = require('./lib/codex-worktree.js');
const { assertNoForbiddenPeople } = require('./lib/forbidden-people.js');
const { landScanOutputs } = require('./lib/scan-output-lander.js');
const {
  createContact,
  parseProjection,
  resolveContact,
} = require('./lib/signal-people-project.js');
const {
  atomicWriteJson,
  linkDirectory,
  messageUrls,
  readJson,
  readJsonl,
} = require('./lib/signal-history-import.js');

const START = '<!-- amy-signal-history:start -->';
const END = '<!-- amy-signal-history:end -->';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex');
}

function attachmentContext(message, runRoot) {
  return (message.attachments || []).map((attachment) => {
    if (!attachment.available) {
      return {
        filename: attachment.filename || '',
        content_type: attachment.contentType || '',
        status: 'missing_from_signal_export',
        searchable_text: '',
      };
    }
    const receipt = readJson(
      path.join(runRoot, 'attachments-derived', attachment.file.sha256, 'receipt.json'),
      {},
    );
    let searchable = '';
    if (receipt.searchableTextPath && fs.existsSync(receipt.searchableTextPath)) {
      searchable = fs.readFileSync(receipt.searchableTextPath, 'utf8').trim().slice(0, 8000);
    }
    return {
      filename: attachment.filename || path.basename(attachment.file.path),
      content_type: attachment.contentType || '',
      status: receipt.status || 'missing_extraction_receipt',
      searchable_text: searchable,
    };
  });
}

function compactMessage(message, runRoot) {
  return {
    event_id: message.eventId,
    direction: message.direction,
    at: message.referenceTime,
    text: message.text || message.fallbackSummary || '',
    quoted_context: message.quote?.text || '',
    shared_links: messageUrls(message).map((url) => {
      const preview = (message.linkPreviews || []).find((row) => row.url === url) || {};
      const fetched = readJson(path.join(linkDirectory(runRoot, url), 'context.json'), {});
      return {
        url: fetched.canonicalUrl || url,
        title: fetched.title || preview.title || '',
        description: fetched.description || preview.description || '',
        page_context: String(fetched.excerpt || '').slice(0, 8000),
        fetch_status: fetched.status || 'preview_only',
      };
    }),
    attachments: attachmentContext(message, runRoot),
  };
}

function chunkMessages(messages, runRoot, maxCharacters = 300_000) {
  const chunks = [];
  let current = [];
  let characters = 0;
  for (const message of messages) {
    const compact = compactMessage(message, runRoot);
    const size = JSON.stringify(compact).length;
    if (current.length && characters + size > maxCharacters) {
      chunks.push(current);
      current = [];
      characters = 0;
    }
    current.push(compact);
    characters += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function projectChunk(contactBody, chunk, options = {}) {
  const prompt = [
    'Extract only durable People-file updates from this historical Signal message chunk.',
    'Attachment transcripts/OCR and link preview context are part of the cited conversation context.',
    'Return strict JSON only: {"durable_facts":["..."],"relationship_summary":""}.',
    'A durable fact is a lasting preference, role, relationship, commitment, decision, life event, or recurring context.',
    'Do not copy ordinary chatter, secrets, message text, phone numbers, or transient logistics.',
    'Use an empty array when nothing is durable. Never invent.',
    '',
    'Existing People file:',
    contactBody.slice(0, 18_000),
    '',
    'Historical Signal context:',
    JSON.stringify(chunk),
  ].join('\n');
  const response = await (options.askAI || askAI)(prompt, {
    surface: 'signal-history-people',
    // Large history prompts use Claude CLI first because this path is verified
    // to receive them on stdin and can run concurrently on Windows. Codex stays
    // the subscription fallback when a Claude chunk fails.
    rungOrder: options.rungOrder || ['claude-cli', 'codex'],
    toolLess: true,
    maxTokens: 1500,
    timeoutMs: Number(options.timeoutMs || 600_000),
  });
  return parseProjection(response && response.text);
}

function existingHistoryFacts(body) {
  const start = body.indexOf(START);
  const end = body.indexOf(END);
  if (start < 0 || end < start) return [];
  return body
    .slice(start, end)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('- Fact: '))
    .map((line) => line.slice('- Fact: '.length));
}

function updateContactHistory(body, messages, facts, relationshipSummary, exportName) {
  const first = messages[0];
  const latest = messages[messages.length - 1];
  const combinedFacts = [...new Set([...existingHistoryFacts(body), ...facts])].slice(-60);
  const attachmentReferences = messages.reduce(
    (total, message) => total + message.attachments.length,
    0,
  );
  const missingAttachmentReferences = messages.reduce(
    (total, message) =>
      total + message.attachments.filter((attachment) => !attachment.available).length,
    0,
  );
  const section = [
    START,
    '## Signal history (Amy managed)',
    '',
    `- Imported source: ${exportName}`,
    `- Imported messages: ${messages.length}`,
    `- Historical range: ${first.referenceTime} through ${latest.referenceTime}`,
    `- Latest historical event ID: ${latest.eventId}`,
    `- Attachment references: ${attachmentReferences}`,
    `- Missing-from-export attachment references: ${missingAttachmentReferences}`,
    ...(relationshipSummary ? [`- Relationship context: ${relationshipSummary}`] : []),
    ...combinedFacts.map((fact) => `- Fact: ${fact}`),
    END,
  ].join('\n');
  const expression = new RegExp(`${START}[\\s\\S]*?${END}`, 'm');
  let output = expression.test(body)
    ? body.replace(expression, section)
    : `${body.trimEnd()}\n\n${section}\n`;
  if (/^last_interaction:/m.test(output)) {
    const existing = output.match(/^last_interaction:\s*(.*)$/m)?.[1]?.trim() || '';
    const historical = latest.referenceTime.slice(0, 10);
    const value = existing && existing > historical ? existing : historical;
    output = output.replace(/^last_interaction:.*$/m, `last_interaction: ${value}`);
  }
  assertNoForbiddenPeople(output, 'Signal history People-file projection');
  return output;
}

function cleanupWorktree(sourceRoot, worktree) {
  if (!worktree?.created) return;
  spawnSync('git', ['worktree', 'remove', '--force', worktree.cwd], {
    cwd: sourceRoot,
    encoding: 'utf8',
    timeout: 120000,
  });
  if (worktree.branch) {
    spawnSync('git', ['branch', '-D', worktree.branch], {
      cwd: sourceRoot,
      encoding: 'utf8',
      timeout: 30000,
    });
  }
}

async function runBounded(items, concurrency, handler) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await handler(items[index], index);
    }
  }
  const width = Math.min(Math.max(1, Number(concurrency || 1)), Math.max(1, items.length));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

async function run(options) {
  const runRoot = path.resolve(options.runRoot);
  const messages = readJsonl(path.join(runRoot, 'messages.jsonl'));
  const privacyRows = readJsonl(path.join(runRoot, 'privacy-screen.jsonl'));
  const privacyByEvent = new Map(privacyRows.map((row) => [row.eventId, row.status]));
  if (privacyRows.length !== messages.length) {
    throw new Error(
      'People projection is blocked until every message has a privacy-screen receipt',
    );
  }
  const attachmentCoverage = readJson(path.join(runRoot, 'attachment-coverage.json'), {});
  const attachmentReceiptsComplete =
    attachmentCoverage.schema === 'amy.signal.history-attachment-coverage.v1' &&
    Number(attachmentCoverage.coveredPayloads || 0) +
      Number(attachmentCoverage.failedPayloads || 0) ===
      Number(attachmentCoverage.uniquePayloads || 0);
  if (!attachmentReceiptsComplete) {
    throw new Error(
      'People projection is blocked until every available attachment has a success or explicit failure receipt',
    );
  }

  const receipts = [];
  const groups = new Map();
  for (const message of messages) {
    if (privacyByEvent.get(message.eventId) === 'redacted') {
      receipts.push({
        eventId: message.eventId,
        status: 'skipped',
        reason: 'privacy-redacted-person',
      });
      continue;
    }
    const conversation = message.conversation || {};
    if (conversation.type !== 'contact' || !conversation.e164) {
      receipts.push({
        eventId: message.eventId,
        status: 'skipped',
        reason: 'group-self-or-no-direct-contact',
      });
      continue;
    }
    if (!groups.has(conversation.e164)) groups.set(conversation.e164, []);
    groups.get(conversation.e164).push(message);
  }

  const requestedRoot = options.repoRoot;
  const resolved = resolveCodexSourceRoot(requestedRoot, { candidates: [requestedRoot] });
  const sourceRoot = resolved.repoRoot;
  const worktree = ensureCodexWorktree({
    repoRoot: sourceRoot,
    forceNew: true,
    purpose: 'signal-history-people',
    branchPrefix: 'codex/signal-history-people',
    sessionsRoot: options.sessionsRoot,
    baseRef: 'origin/master',
    linkNodeModules: true,
  });
  const projectionRoot = path.join(runRoot, 'people', 'projections');
  const projectedGroups = [];
  const errors = [];
  try {
    const contactsDir = path.join(worktree.cwd, 'memory', 'contacts');
    let groupIndex = 0;
    const plans = [];
    const chunkTasks = [];
    for (const [e164, groupMessages] of groups) {
      groupIndex += 1;
      groupMessages.sort((left, right) => left.timestamp - right.timestamp);
      const latest = groupMessages[groupMessages.length - 1];
      const synthetic = {
        counterparty: e164,
        referenceTime: latest.referenceTime,
        text: '',
        envelope: { sourceName: latest.conversation?.label || e164 },
      };
      let contact = null;
      try {
        contact = resolveContact(synthetic, contactsDir);
        if (!contact) contact = createContact(synthetic, contactsDir);
        if (!contact) throw new Error('direct contact could not be resolved or created');
        const fingerprint = sha256(
          JSON.stringify(groupMessages.map((message) => compactMessage(message, runRoot))),
        );
        const projectionFile = path.join(projectionRoot, `${sha256(e164).slice(0, 24)}.json`);
        const currentBody = fs.readFileSync(contact.file, 'utf8');
        const prior = readJson(projectionFile, null);
        const plan = {
          contact,
          contactKey: sha256(e164).slice(0, 16),
          fingerprint,
          groupIndex,
          groupMessages,
          currentBody,
          projectionFile,
          projection:
            prior?.inputFingerprint === fingerprint && prior?.status === 'complete' ? prior : null,
          chunkResults: [],
          chunkErrors: [],
          totalChunks: 0,
        };
        plans.push(plan);
        if (!plan.projection) {
          const chunks = chunkMessages(
            groupMessages,
            runRoot,
            Number(options.chunkCharacters || 300_000),
          );
          plan.totalChunks = chunks.length;
          const chunkRoot = `${projectionFile}.chunks`;
          for (const [chunkIndex, chunk] of chunks.entries()) {
            const inputFingerprint = sha256(
              JSON.stringify({ contactFingerprint: fingerprint, chunkIndex, chunk }),
            );
            const receiptFile = path.join(
              chunkRoot,
              `chunk-${String(chunkIndex + 1).padStart(4, '0')}.json`,
            );
            const receipt = readJson(receiptFile, null);
            if (receipt?.status === 'complete' && receipt.inputFingerprint === inputFingerprint) {
              plan.chunkResults[chunkIndex] = receipt;
            } else {
              chunkTasks.push({
                plan,
                chunk,
                chunkIndex,
                totalChunks: chunks.length,
                inputFingerprint,
                receiptFile,
              });
            }
          }
        }
      } catch (error) {
        if (contact?.created && fs.existsSync(contact.file)) fs.unlinkSync(contact.file);
        errors.push({
          contactKey: sha256(e164).slice(0, 16),
          error: String(error.message || error).slice(0, 500),
        });
      }
    }

    let completedTasks = 0;
    await runBounded(chunkTasks, Number(options.concurrency || 4), async (task) => {
      let receipt;
      try {
        const value = await projectChunk(task.plan.currentBody, task.chunk, options);
        receipt = {
          schema: 'amy.signal.history-people-chunk-projection.v1',
          status: 'complete',
          inputFingerprint: task.inputFingerprint,
          chunkIndex: task.chunkIndex,
          totalChunks: task.totalChunks,
          durableFacts: value.durableFacts,
          relationshipSummary: value.relationshipSummary,
          completedAt: new Date().toISOString(),
        };
        task.plan.chunkResults[task.chunkIndex] = receipt;
      } catch (error) {
        receipt = {
          schema: 'amy.signal.history-people-chunk-projection.v1',
          status: 'failed',
          inputFingerprint: task.inputFingerprint,
          chunkIndex: task.chunkIndex,
          totalChunks: task.totalChunks,
          error: String(error.message || error).slice(0, 1000),
          failedAt: new Date().toISOString(),
        };
        task.plan.chunkErrors.push(receipt);
      }
      atomicWriteJson(task.receiptFile, receipt);
      completedTasks += 1;
      process.stderr.write(
        `[signal-history-people] model chunks ${completedTasks}/${chunkTasks.length}; contact ${task.plan.groupIndex}/${groups.size} chunk ${task.chunkIndex + 1}/${task.totalChunks}; ${receipt.status}\n`,
      );
      return receipt;
    });

    for (const plan of plans) {
      if (!plan.projection) {
        if (plan.chunkErrors.length || plan.chunkResults.length !== plan.totalChunks) {
          if (plan.contact.created && fs.existsSync(plan.contact.file)) fs.unlinkSync(plan.contact.file);
          errors.push({
            contactKey: plan.contactKey,
            error: `${plan.chunkErrors.length || plan.totalChunks - plan.chunkResults.length} People projection chunk(s) failed`,
          });
          continue;
        }
        const facts = plan.chunkResults.flatMap((receipt) => receipt.durableFacts || []);
        const relationshipSummary =
          [...plan.chunkResults].reverse().find((receipt) => receipt.relationshipSummary)
            ?.relationshipSummary || '';
        plan.projection = {
          schema: 'amy.signal.history-people-contact-projection.v1',
          status: 'complete',
          inputFingerprint: plan.fingerprint,
          messageCount: plan.groupMessages.length,
          completedChunks: plan.totalChunks,
          totalChunks: plan.totalChunks,
          durableFacts: [...new Set(facts)],
          relationshipSummary,
        };
        atomicWriteJson(plan.projectionFile, plan.projection);
      }
      const currentBody = fs.readFileSync(plan.contact.file, 'utf8');
      const updated = updateContactHistory(
        currentBody,
        plan.groupMessages,
        plan.projection.durableFacts,
        plan.projection.relationshipSummary,
        path.basename(runRoot),
      );
      if (updated !== currentBody) fs.writeFileSync(plan.contact.file, updated, 'utf8');
      projectedGroups.push({ contact: plan.contact, messages: plan.groupMessages });
    }
    let landing = null;
    if (projectedGroups.length) {
      landing = landScanOutputs({
        repoRoot: worktree.cwd,
        pathspecs: ['memory/contacts'],
        message: `memory: project ${projectedGroups.reduce((total, group) => total + group.messages.length, 0)} historical Signal interactions`,
        purpose: 'signal-history-people',
      });
      if (!landing.ok)
        throw new Error(`Signal history People landing failed: ${landing.reason || 'unknown'}`);
      for (const group of projectedGroups) {
        for (const message of group.messages) {
          receipts.push({
            eventId: message.eventId,
            status: 'complete',
            disposition: 'projected',
            contactFile: path.relative(worktree.cwd, group.contact.file).replace(/\\/g, '/'),
            attachmentInputComplete: message.attachmentCoverageComplete,
          });
        }
      }
    }
    const receiptFile = path.join(runRoot, 'people-coverage.jsonl');
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
    fs.writeFileSync(
      receiptFile,
      receipts
        .map((row) => JSON.stringify({ schema: 'amy.signal.history-people-receipt.v1', ...row }))
        .join('\n') + '\n',
      { mode: 0o600 },
    );
    const covered = new Set(receipts.map((receipt) => receipt.eventId));
    const coverage = {
      schema: 'amy.signal.history-people-coverage.v1',
      status: errors.length === 0 && covered.size === messages.length ? 'green' : 'red',
      messages: messages.length,
      coveredMessages: covered.size,
      projectedMessages: receipts.filter((receipt) => receipt.disposition === 'projected').length,
      skippedMessages: receipts.filter((receipt) => receipt.status === 'skipped').length,
      contactsProjected: projectedGroups.length,
      errors,
      landing,
    };
    atomicWriteJson(path.join(runRoot, 'people-coverage.json'), coverage);
    return coverage;
  } finally {
    cleanupWorktree(sourceRoot, worktree);
  }
}

if (require.main === module) {
  run({
    runRoot: arg('run-root'),
    repoRoot: arg('repo-root', path.resolve(__dirname, '..')),
    sessionsRoot: arg('sessions-root', path.dirname(path.resolve(__dirname, '..'))),
    chunkCharacters: Number(arg('chunk-characters', '300000')),
    concurrency: Number(arg('concurrency', '4')),
    timeoutMs: Number(arg('timeout-ms', '600000')),
  }).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.status !== 'green') process.exitCode = 1;
    },
    (error) => {
      process.stderr.write(`signal-history-people: ${error.stack || error.message}\n`);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  chunkMessages,
  compactMessage,
  existingHistoryFacts,
  projectChunk,
  runBounded,
  updateContactHistory,
};
