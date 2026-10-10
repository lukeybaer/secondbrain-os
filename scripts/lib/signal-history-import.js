'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { uploadFile } = require('./cloud-archive.js');
const { findForbiddenPeople } = require('./forbidden-people.js');
const {
  appendEventsBulk,
  normalizeEvent,
  readReceiptIndex,
} = require('./graphiti-event-log.js');
const { extractUrls, fetchSharedUrl } = require('./signal-link-context.js');

const HISTORY_ARCHIVE_PREFIX = 'data-lake/secondbrain/life-archive/data/signal/history/imports';

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function parseSignalExportJsonl(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const records = [];
  let buffer = '';
  let quoted = false;
  let escaped = false;
  let repairedNewlines = 0;

  const finish = () => {
    if (!buffer.trim()) return;
    records.push(JSON.parse(buffer));
    buffer = '';
  };

  for (const char of raw) {
    if (quoted) {
      if (escaped) {
        buffer += char;
        escaped = false;
      } else if (char === '\\') {
        buffer += char;
        escaped = true;
      } else if (char === '"') {
        buffer += char;
        quoted = false;
      } else if (char === '\n') {
        buffer += '\\n';
        repairedNewlines += 1;
      } else if (char !== '\r') {
        buffer += char;
      }
      continue;
    }

    if (char === '"') {
      buffer += char;
      quoted = true;
    } else if (char === '\n') {
      finish();
    } else if (char !== '\r') {
      buffer += char;
    }
  }
  finish();
  return { records, repairedNewlines };
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  };
  walk(root);
  return files.sort();
}

function plaintextHashHex(pointer) {
  const encoded = pointer?.locatorInfo?.plaintextHash;
  if (!encoded || typeof encoded !== 'string') return '';
  try {
    const value = Buffer.from(encoded, 'base64').toString('hex');
    return /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : '';
  } catch {
    return '';
  }
}

function exportFileHash(pointer) {
  const plaintextHash = pointer?.locatorInfo?.plaintextHash;
  const localKey = pointer?.locatorInfo?.key;
  if (!plaintextHash || !localKey) return '';
  try {
    return crypto
      .createHash('sha256')
      .update(Buffer.concat([Buffer.from(plaintextHash, 'base64'), Buffer.from(localKey, 'base64')]))
      .digest('hex');
  } catch {
    return '';
  }
}

function collectPointerReferences(chatItem) {
  const item = chatItem?.chatId ? chatItem : chatItem?.chatItem || {};
  const messageId = [item.chatId || '', item.authorId || '', item.dateSent || ''].join(':');
  const references = [];
  const add = (pointer, kind, revisionIndex = null) => {
    if (!pointer || typeof pointer !== 'object') return;
    references.push({
      messageId,
      kind,
      revisionIndex,
      pointer,
      plaintextHash: plaintextHashHex(pointer),
      exportFileHash: exportFileHash(pointer),
    });
  };
  const standard = item.standardMessage || {};
  for (const attachment of standard.attachments || []) add(attachment?.pointer, 'attachment');
  for (const preview of standard.linkPreview || []) add(preview?.image, 'link-preview');
  add(item.stickerMessage?.sticker?.data, 'sticker');
  for (const [revisionIndex, revision] of (item.revisions || []).entries()) {
    const revised = revision?.standardMessage || {};
    for (const attachment of revised.attachments || []) {
      add(attachment?.pointer, 'revision-attachment', revisionIndex);
    }
    for (const preview of revised.linkPreview || []) {
      add(preview?.image, 'revision-link-preview', revisionIndex);
    }
  }
  return references;
}

function pointerKind(pointerPath) {
  const value = pointerPath.join('.');
  if (/\.revisions\./.test(value) && /\.attachments\./.test(value)) return 'revision-attachment';
  if (/\.revisions\./.test(value) && /\.linkPreview\./.test(value)) return 'revision-link-preview';
  if (/\.quote\./.test(value) && /\.thumbnail$/.test(value)) return 'quote-thumbnail';
  if (/\.quote\./.test(value) && /\.attachments\./.test(value)) return 'quote-attachment';
  if (/\.linkPreview\./.test(value)) return 'link-preview';
  if (/\.attachments\./.test(value)) return 'attachment';
  if (/\.sticker/i.test(value)) return 'sticker';
  if (/\.avatar/i.test(value)) return 'avatar';
  if (/\.wallpaper/i.test(value)) return 'wallpaper';
  return 'other-pointer';
}

function collectAllPointerReferences(records) {
  const references = [];
  const visit = (value, pointerPath, context) => {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && value.locatorInfo && typeof value.locatorInfo === 'object') {
      references.push({
        messageId: context.messageId,
        recordType: context.recordType,
        recordIndex: context.recordIndex,
        kind: pointerKind(pointerPath),
        pointerPath: pointerPath.join('.'),
        pointer: value,
        plaintextHash: plaintextHashHex(value),
        exportFileHash: exportFileHash(value),
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...pointerPath, String(index)], context));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, [...pointerPath, key], context);
    }
  };
  records.forEach((record, recordIndex) => {
    const recordType = Object.keys(record || {})[0] || 'unknown';
    const item = record?.chatItem || {};
    const messageId =
      recordType === 'chatItem'
        ? [item.chatId || '', item.authorId || '', item.dateSent || ''].join(':')
        : null;
    visit(record?.[recordType], [recordType], { messageId, recordType, recordIndex });
  });
  return references;
}

function physicalAttachmentIndex(exportRoot, options = {}) {
  const filesRoot = path.join(exportRoot, 'files');
  const files = walkFiles(filesRoot);
  const byExportHash = new Map();
  const bySha256 = new Map();
  const rows = files.map((file) => {
    const relativePath = path.relative(exportRoot, file).replace(/\\/g, '/');
    const exportHash = path.parse(file).name.toLowerCase();
    const stat = fs.statSync(file);
    const row = {
      file,
      relativePath,
      exportHash,
      extension: path.extname(file).toLowerCase(),
      bytes: stat.size,
      sha256: options.hashContent === false ? null : sha256File(file),
    };
    if (/^[a-f0-9]{64}$/.test(exportHash)) byExportHash.set(exportHash, row);
    if (row.sha256) bySha256.set(row.sha256, row);
    return row;
  });
  return { files, rows, byExportHash, bySha256 };
}

function timestampRange(chatItems) {
  let oldest = Number.POSITIVE_INFINITY;
  let newest = 0;
  for (const wrapper of chatItems) {
    const value = Number(wrapper?.dateSent || wrapper?.chatItem?.dateSent);
    if (!Number.isFinite(value) || value <= 0) continue;
    oldest = Math.min(oldest, value);
    newest = Math.max(newest, value);
  }
  return {
    oldest: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
    newest: newest > 0 ? new Date(newest).toISOString() : null,
  };
}

function countBy(values, keyFn) {
  const counts = {};
  for (const value of values) {
    const key = keyFn(value) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function inspectSignalExport(exportRoot, options = {}) {
  const mainFile = path.join(exportRoot, 'main.jsonl');
  if (!fs.existsSync(mainFile)) throw new Error(`Signal export main.jsonl not found: ${mainFile}`);
  const parsed = parseSignalExportJsonl(mainFile);
  const chatItems = parsed.records.filter((record) => record?.chatItem).map((record) => record.chatItem);
  const references = collectAllPointerReferences(parsed.records);
  const physical = physicalAttachmentIndex(exportRoot, options);
  const matched = [];
  const missing = [];
  for (const reference of references) {
    const file =
      physical.byExportHash.get(reference.exportFileHash) ||
      physical.bySha256.get(reference.plaintextHash) ||
      null;
    (file ? matched : missing).push({ ...reference, file });
  }
  const uniqueReferenceHashes = new Set(references.map((value) => value.plaintextHash).filter(Boolean));
  const uniqueMatchedHashes = new Set(matched.map((value) => value.plaintextHash));
  const uniqueMissingHashes = new Set(missing.map((value) => value.plaintextHash).filter(Boolean));
  const referencedPhysicalHashes = new Set(matched.map((value) => value.file.exportHash));
  const referencedPhysicalDigests = new Set(matched.map((value) => value.file.sha256));
  const unreferencedPhysical = physical.rows.filter(
    (row) =>
      !referencedPhysicalHashes.has(row.exportHash) && !referencedPhysicalDigests.has(row.sha256),
  );
  const physicalContentCounts = countBy(physical.rows, (row) => row.sha256);
  const textCharacters = chatItems.reduce(
    (total, wrapper) =>
      total + String((wrapper?.standardMessage || wrapper?.chatItem?.standardMessage)?.text?.body || '').length,
    0,
  );

  return {
    schema: 'amy.signal.history-inspection.v1',
    exportRoot: path.resolve(exportRoot),
    generatedAt: new Date().toISOString(),
    records: parsed.records.length,
    repairedNewlines: parsed.repairedNewlines,
    recordTypes: countBy(parsed.records, (record) => Object.keys(record || {})[0]),
    messages: chatItems.length,
    textCharacters,
    timestampRange: timestampRange(chatItems),
    attachmentCoverage: {
      physicalFiles: physical.rows.length,
      physicalBytes: physical.rows.reduce((total, row) => total + row.bytes, 0),
      references: references.length,
      uniqueReferenceHashes: uniqueReferenceHashes.size,
      matchedReferences: matched.length,
      uniqueMatchedHashes: uniqueMatchedHashes.size,
      missingReferences: missing.length,
      uniqueMissingHashes: uniqueMissingHashes.size,
      unreferencedPhysicalFiles: unreferencedPhysical.length,
      duplicatePhysicalFiles: Object.values(physicalContentCounts).reduce(
        (total, count) => total + Math.max(0, count - 1),
        0,
      ),
      referencesByKind: countBy(references, (reference) => reference.kind),
      matchedByKind: countBy(matched, (reference) => reference.kind),
      missingByKind: countBy(missing, (reference) => reference.kind),
      physicalByExtension: countBy(physical.rows, (row) => row.extension),
    },
    _private: {
      records: parsed.records,
      chatItems,
      references,
      matched,
      missing,
      physical,
      unreferencedPhysical,
    },
  };
}

function publicInspection(inspection) {
  const { _private, ...safe } = inspection;
  return safe;
}

function extensionForReference(reference) {
  const fromName = path.extname(reference.pointer?.fileName || '').toLowerCase();
  if (fromName) return fromName;
  const byType = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'audio/mp4': '.m4a',
    'audio/mpeg': '.mp3',
    'application/pdf': '.pdf',
    'application/vnd.apple.pkpass': '.pkpass',
    'application/json': '.json',
  };
  return byType[String(reference.pointer?.contentType || '').toLowerCase()] || '.bin';
}

function applySignalCacheRecovery(inspection, recoveryRoot, runRoot) {
  if (!recoveryRoot || !fs.existsSync(recoveryRoot)) {
    return { scannedFiles: 0, scannedBytes: 0, recoveredPayloads: 0, recoveredReferences: 0 };
  }
  const cacheRows = walkFiles(recoveryRoot).map((file) => {
    const stat = fs.statSync(file);
    return { file, bytes: stat.size, sha256: sha256File(file) };
  });
  const bySha = new Map(cacheRows.map((row) => [row.sha256, row]));
  const recoveredBySha = new Map();
  const stillMissing = [];
  const recoveredReferences = [];
  for (const reference of inspection._private.missing) {
    const cache = bySha.get(reference.plaintextHash);
    if (!cache) {
      stillMissing.push(reference);
      continue;
    }
    let fileRow = recoveredBySha.get(cache.sha256);
    if (!fileRow) {
      const extension = extensionForReference(reference);
      const relativePath = path.join('recovered-source', cache.sha256.slice(0, 2), `${cache.sha256}${extension}`);
      const destination = path.join(runRoot, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (!fs.existsSync(destination) || sha256File(destination) !== cache.sha256) fs.copyFileSync(cache.file, destination);
      fileRow = {
        file: destination,
        relativePath: relativePath.replace(/\\/g, '/'),
        exportHash: '',
        extension,
        bytes: cache.bytes,
        sha256: cache.sha256,
        recoveredFrom: cache.file,
        sourceType: 'signal-desktop-attachment-cache',
      };
      recoveredBySha.set(cache.sha256, fileRow);
    }
    recoveredReferences.push({ ...reference, file: fileRow, recovered: true });
  }
  const recoveredRows = [...recoveredBySha.values()];
  inspection._private.missing = stillMissing;
  inspection._private.matched.push(...recoveredReferences);
  inspection._private.physical.rows.push(...recoveredRows);
  for (const row of recoveredRows) inspection._private.physical.bySha256.set(row.sha256, row);
  const coverage = inspection.attachmentCoverage;
  coverage.exportPhysicalFiles = coverage.physicalFiles;
  coverage.exportPhysicalBytes = coverage.physicalBytes;
  coverage.recoveryCacheFilesScanned = cacheRows.length;
  coverage.recoveryCacheBytesScanned = cacheRows.reduce((total, row) => total + row.bytes, 0);
  coverage.recoveredPhysicalPayloads = recoveredRows.length;
  coverage.recoveredReferences = recoveredReferences.length;
  coverage.physicalFiles += recoveredRows.length;
  coverage.physicalBytes += recoveredRows.reduce((total, row) => total + row.bytes, 0);
  coverage.matchedReferences = inspection._private.matched.length;
  coverage.uniqueMatchedHashes = new Set(inspection._private.matched.map((row) => row.plaintextHash).filter(Boolean)).size;
  coverage.missingReferences = stillMissing.length;
  coverage.uniqueMissingHashes = new Set(stillMissing.map((row) => row.plaintextHash).filter(Boolean)).size;
  coverage.matchedByKind = countBy(inspection._private.matched, (row) => row.kind);
  coverage.missingByKind = countBy(stillMissing, (row) => row.kind);
  coverage.physicalByExtension = countBy(inspection._private.physical.rows, (row) => row.extension);
  return {
    scannedFiles: cacheRows.length,
    scannedBytes: coverage.recoveryCacheBytesScanned,
    recoveredPayloads: recoveredRows.length,
    recoveredReferences: recoveredReferences.length,
    remainingMissingReferences: stillMissing.length,
    remainingUniqueMissingHashes: coverage.uniqueMissingHashes,
  };
}

function stableMessageId(item) {
  const basis = [item?.chatId || '', item?.authorId || '', item?.dateSent || '', JSON.stringify(item || {})].join('|');
  return `signal-history-${crypto.createHash('sha256').update(basis).digest('hex')}`;
}

function pointerReferenceKey(reference) {
  return [
    reference.recordIndex ?? '',
    reference.pointerPath || '',
    reference.plaintextHash || '',
    reference.exportFileHash || '',
  ].join('|');
}

function recipientDescriptor(record, account = {}) {
  if (!record) return { type: 'unknown', label: 'Unknown Signal participant', e164: '' };
  if (record.contact) {
    const contact = record.contact;
    const given = contact.systemGivenName || contact.profileGivenName || '';
    const family = contact.systemFamilyName || contact.profileFamilyName || '';
    const nickname = contact.systemNickname || '';
    const e164 = contact.e164 || '';
    return {
      type: 'contact',
      label: [given, family].filter(Boolean).join(' ').trim() || nickname || e164 || contact.aci || 'Signal contact',
      e164,
      aci: contact.aci || '',
    };
  }
  if (record.group) {
    return {
      type: 'group',
      label: record.group.snapshot?.title || 'Signal group',
      e164: '',
    };
  }
  if (record.self) {
    return {
      type: 'self',
      label: [account.givenName, account.familyName].filter(Boolean).join(' ').trim() || 'ExampleCo',
      e164: '',
    };
  }
  if (record.releaseNotes) return { type: 'release-notes', label: 'Signal release notes', e164: '' };
  if (record.distributionList) return { type: 'distribution-list', label: 'Signal distribution list', e164: '' };
  return { type: 'unknown', label: 'Unknown Signal participant', e164: '' };
}

function updateSummary(item) {
  if (item.remoteDeletedMessage) return 'Remote-deleted Signal message.';
  if (item.stickerMessage) return 'Signal sticker message.';
  if (item.contactMessage) return 'Signal shared-contact message.';
  if (!item.updateMessage) return '';
  const kind = Object.keys(item.updateMessage)[0] || 'update';
  return `Signal ${kind.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()} update.`;
}

function normalizeSignalHistory(inspection) {
  const records = inspection._private.records;
  const account = records.find((record) => record?.account)?.account || {};
  const recipientRecords = new Map(
    records.filter((record) => record?.recipient).map((record) => [String(record.recipient.id), record.recipient]),
  );
  const recipients = new Map(
    [...recipientRecords.entries()].map(([id, record]) => [id, recipientDescriptor(record, account)]),
  );
  const chats = new Map(
    records.filter((record) => record?.chat).map((record) => [String(record.chat.id), record.chat]),
  );
  const referencesByRawMessage = new Map();
  for (const reference of inspection._private.references) {
    if (!reference.messageId) continue;
    if (!referencesByRawMessage.has(reference.messageId)) referencesByRawMessage.set(reference.messageId, []);
    referencesByRawMessage.get(reference.messageId).push(reference);
  }
  const matchedByReference = new Map(
    inspection._private.matched.map((reference) => [pointerReferenceKey(reference), reference.file]),
  );
  const messages = [];
  const messagesByEventId = new Map();
  records.forEach((record, recordIndex) => {
    const item = record?.chatItem;
    if (!item) return;
    const rawMessageId = [item.chatId || '', item.authorId || '', item.dateSent || ''].join(':');
    const chat = chats.get(String(item.chatId)) || {};
    const conversation = recipients.get(String(chat.recipientId)) || {
      type: 'unknown',
      label: 'Unknown Signal conversation',
      e164: '',
    };
    const author = recipients.get(String(item.authorId)) || { type: 'unknown', label: 'Unknown Signal author', e164: '' };
    const direction = item.outgoing ? 'outbound' : item.incoming ? 'inbound' : 'directionless';
    const standard = item.standardMessage || {};
    const text = String(standard.text?.body || '');
    const seenReferences = new Set();
    const references = (referencesByRawMessage.get(rawMessageId) || []).filter((reference) => {
      const key = [reference.kind, reference.pointerPath, reference.plaintextHash, reference.exportFileHash].join('|');
      if (seenReferences.has(key)) return false;
      seenReferences.add(key);
      return true;
    }).map((reference, attachmentIndex) => {
      const file =
        matchedByReference.get(pointerReferenceKey(reference)) ||
        inspection._private.physical.bySha256.get(reference.plaintextHash) ||
        null;
      return {
        attachmentIndex,
        kind: reference.kind,
        pointerPath: reference.pointerPath,
        contentType: reference.pointer?.contentType || '',
        filename: reference.pointer?.fileName || '',
        declaredBytes: Number(reference.pointer?.locatorInfo?.size || 0) || null,
        plaintextHash: reference.plaintextHash,
        exportFileHash: reference.exportFileHash,
        available: Boolean(file),
        missingReason: file ? null : 'not-present-in-signal-plaintext-export',
        file: file
          ? {
              path: file.file,
              relativePath: file.relativePath,
              bytes: file.bytes,
              sha256: file.sha256,
              extension: file.extension,
            }
          : null,
      };
    });
    const linkPreviews = (standard.linkPreview || []).map((preview) => ({
      url: preview.url || '',
      title: preview.title || '',
      description: preview.description || '',
      date: preview.date || null,
    }));
    const revisions = (item.revisions || []).map((revision) => ({
      dateSent: revision.dateSent || null,
      text: String(revision.standardMessage?.text?.body || ''),
    }));
    const quote = standard.quote
      ? {
          author: recipients.get(String(standard.quote.authorId))?.label || '',
          targetSentTimestamp: standard.quote.targetSentTimestamp || null,
          text: String(standard.quote.text || ''),
          type: standard.quote.type || '',
        }
      : null;
    const eventId = stableMessageId(item);
    const normalized = {
      schema: 'amy.signal.history-message.v1',
      eventId,
      rawMessageId,
      recordIndex,
      recordIndices: [recordIndex],
      chatId: String(item.chatId || ''),
      authorId: String(item.authorId || ''),
      direction,
      timestamp: Number(item.dateSent || 0),
      referenceTime: new Date(Number(item.dateSent || 0)).toISOString(),
      conversation,
      author,
      text,
      fallbackSummary: updateSummary(item),
      quote,
      revisions,
      linkPreviews,
      attachments: references,
      attachmentCoverageComplete: references.every((reference) => reference.available),
    };
    const prior = messagesByEventId.get(eventId);
    if (prior) {
      prior.recordIndices.push(recordIndex);
      return;
    }
    messagesByEventId.set(eventId, normalized);
    messages.push(normalized);
  });
  return { account, recipients, chats, messages };
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const output = fs.createWriteStream(temporary, { encoding: 'utf8', mode: 0o600 });
  for (const row of rows) output.write(`${JSON.stringify(row)}\n`);
  return new Promise((resolve, reject) => {
    output.on('error', (error) => {
      try { fs.unlinkSync(temporary); } catch { /* best-effort temp cleanup */ }
      reject(error);
    });
    output.on('finish', () => {
      fs.renameSync(temporary, file);
      resolve();
    });
    output.end();
  });
}

async function prepareSignalHistory(exportRoot, runRoot, options = {}) {
  const inspection = inspectSignalExport(exportRoot);
  const recovery = applySignalCacheRecovery(inspection, options.recoveryRoot, runRoot);
  const normalized = normalizeSignalHistory(inspection);
  fs.mkdirSync(runRoot, { recursive: true });
  const inspectionFile = path.join(runRoot, 'inspection.json');
  const messagesFile = path.join(runRoot, 'messages.jsonl');
  const attachmentsFile = path.join(runRoot, 'attachments.jsonl');
  const missingFile = path.join(runRoot, 'missing-attachments.jsonl');
  const attachmentRows = inspection._private.physical.rows.map((file) => {
    const refs = inspection._private.matched
      .filter((reference) => reference.file.sha256 === file.sha256)
      .map((reference) => ({
        messageId: reference.messageId,
        kind: reference.kind,
        recordType: reference.recordType,
        pointerPath: reference.pointerPath,
        contentType: reference.pointer?.contentType || '',
        filename: reference.pointer?.fileName || '',
      }));
    return {
      schema: 'amy.signal.history-attachment.v1',
      path: file.file,
      relativePath: file.relativePath,
      bytes: file.bytes,
      sha256: file.sha256,
      exportHash: file.exportHash,
      extension: file.extension,
      references: refs,
    };
  });
  const missingRows = inspection._private.missing.map((reference) => ({
    schema: 'amy.signal.history-missing-attachment.v1',
    messageId: reference.messageId,
    recordType: reference.recordType,
    kind: reference.kind,
    pointerPath: reference.pointerPath,
    contentType: reference.pointer?.contentType || '',
    filename: reference.pointer?.fileName || '',
    declaredBytes: Number(reference.pointer?.locatorInfo?.size || 0) || null,
    plaintextHash: reference.plaintextHash,
    reason: 'not-present-in-signal-plaintext-export',
  }));
  await Promise.all([
    writeJsonl(messagesFile, normalized.messages),
    writeJsonl(attachmentsFile, attachmentRows),
    writeJsonl(missingFile, missingRows),
  ]);
  const publicResult = {
    ...publicInspection(inspection),
    schema: 'amy.signal.history-prepare.v1',
    runRoot: path.resolve(runRoot),
    messagesWithAttachmentReferences: normalized.messages.filter((message) => message.attachments.length).length,
    messagesWithMissingAttachments: normalized.messages.filter((message) => !message.attachmentCoverageComplete).length,
    sourceChatItemRecords: inspection.messages,
    logicalMessages: normalized.messages.length,
    duplicateChatItemRecords: inspection.messages - normalized.messages.length,
    recovery,
    messageIdCollisions: normalized.messages.length - new Set(normalized.messages.map((message) => message.eventId)).size,
    artifacts: { inspectionFile, messagesFile, attachmentsFile, missingFile },
  };
  atomicWriteJson(inspectionFile, publicResult);
  return publicResult;
}

function archiveIndexFile(runRoot) {
  return path.join(runRoot, 'raw-archive-index.json');
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function archiveSourceFiles(exportRoot, excludeRoot = '') {
  const excluded = excludeRoot ? path.resolve(excludeRoot) : '';
  return walkFiles(exportRoot)
    .filter((file) => {
      if (!excluded) return true;
      const relative = path.relative(excluded, path.resolve(file));
      return relative.startsWith('..') || path.isAbsolute(relative);
    })
    .sort();
}

function archiveKey(exportRoot, file) {
  const exportName = path.basename(path.resolve(exportRoot));
  const relative = path.relative(exportRoot, file).replace(/\\/g, '/');
  return `${HISTORY_ARCHIVE_PREFIX}/${exportName}/${relative}`;
}

function archiveSignalExport(exportRoot, runRoot, options = {}) {
  const indexFile = archiveIndexFile(runRoot);
  const index = readJson(indexFile, {
    schema: 'amy.signal.history-raw-archive.v1',
    exportRoot: path.resolve(exportRoot),
    startedAt: new Date().toISOString(),
    objects: {},
  });
  const files = archiveSourceFiles(exportRoot, runRoot);
  let uploaded = 0;
  let reused = 0;
  for (const [position, file] of files.entries()) {
    const relativePath = path.relative(exportRoot, file).replace(/\\/g, '/');
    const bytes = fs.statSync(file).size;
    const digest = sha256File(file);
    const prior = index.objects[relativePath];
    if (prior?.status === 'verified' && prior.sha256 === digest && prior.bytes === bytes) {
      reused += 1;
      continue;
    }
    const receipt = (options.uploadFile || uploadFile)(file, {
      env: options.env || process.env,
      bucket: options.bucket,
      region: options.region || 'us-east-1',
      key: archiveKey(exportRoot, file),
      requireChecksumSha256: true,
      allowSensitive: true,
    });
    index.objects[relativePath] = { status: 'verified', ...receipt };
    index.updatedAt = new Date().toISOString();
    atomicWriteJson(indexFile, index);
    uploaded += 1;
    if (options.onProgress) options.onProgress({ position: position + 1, total: files.length, relativePath });
  }
  index.completedAt = new Date().toISOString();
  index.status = Object.keys(index.objects).length === files.length ? 'verified' : 'incomplete';
  index.files = files.length;
  index.bytes = files.reduce((total, file) => total + fs.statSync(file).size, 0);
  index.uploadedThisRun = uploaded;
  index.reusedThisRun = reused;
  atomicWriteJson(indexFile, index);
  return index;
}

function archiveSignalRecovery(runRoot, options = {}) {
  const sourceRoot = path.join(runRoot, 'recovered-source');
  const files = walkFiles(sourceRoot);
  const indexFile = path.join(runRoot, 'recovery-archive-index.json');
  const index = readJson(indexFile, {
    schema: 'amy.signal.history-recovery-archive.v1',
    startedAt: new Date().toISOString(),
    objects: {},
  });
  for (const [position, file] of files.entries()) {
    const relativePath = path.relative(sourceRoot, file).replace(/\\/g, '/');
    const digest = sha256File(file);
    const bytes = fs.statSync(file).size;
    const prior = index.objects[relativePath];
    if (prior?.status === 'verified' && prior.sha256 === digest && prior.bytes === bytes) continue;
    const receipt = (options.uploadFile || uploadFile)(file, {
      env: options.env || process.env,
      bucket: options.bucket,
      region: options.region || 'us-east-1',
      key: `${HISTORY_ARCHIVE_PREFIX}/${path.basename(runRoot)}/recovered/${relativePath}`,
      requireChecksumSha256: true,
      allowSensitive: true,
    });
    index.objects[relativePath] = { status: 'verified', ...receipt };
    index.updatedAt = new Date().toISOString();
    atomicWriteJson(indexFile, index);
    if (options.onProgress) options.onProgress({ position: position + 1, total: files.length });
  }
  index.status = Object.keys(index.objects).length === files.length ? 'verified' : 'incomplete';
  index.files = files.length;
  index.completedAt = new Date().toISOString();
  atomicWriteJson(indexFile, index);
  return index;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function derivativeArchiveFiles(runRoot) {
  const files = [];
  const derivedRoot = path.join(runRoot, 'attachments-derived');
  files.push(...walkFiles(derivedRoot));
  files.push(...walkFiles(path.join(runRoot, 'links')));
  for (const name of [
    'inspection.json',
    'messages.jsonl',
    'attachments.jsonl',
    'missing-attachments.jsonl',
    'attachment-coverage.json',
    'link-coverage.json',
    'life-archive-coverage.json',
    'privacy-screen.jsonl',
    'graphiti-plan.jsonl',
    'graphiti-coverage.json',
    'people-coverage.json',
    'people-coverage.jsonl',
    'overall-coverage.json',
  ]) {
    const file = path.join(runRoot, name);
    if (fs.existsSync(file)) files.push(file);
  }
  return [...new Set(files.map((file) => path.resolve(file)))].sort();
}

function messageUrls(message) {
  return [
    ...new Set([
      ...extractUrls(message.text),
      ...(message.linkPreviews || []).map((preview) => preview.url).filter(Boolean),
    ]),
  ];
}

function linkDirectory(runRoot, url) {
  return path.join(runRoot, 'links', sha256Value(url).slice(0, 32));
}

function sha256Value(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function writeBufferAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, value, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function isHistoricalLinkSourceUnavailable(error) {
  const message = String(error?.message || error || '');
  return (
    error?.sourceLimitation === true ||
    error?.code === 'SIGNAL_LINK_SOURCE_LIMITATION' ||
    /^Shared link HTTP \d{3}$/i.test(message) ||
    /^(?:fetch failed|Shared link (?:source|response) unavailable: .+)$/i.test(message)
  );
}

function omittedLinkContext(url, error, existing = {}) {
  return {
    ...existing,
    schema: 'amy.signal.history-link-context.v1',
    status: 'omitted',
    url,
    urlHash: sha256Value(url),
    omissionReason: 'historical-url-unavailable',
    sourceError: String(error?.message || error || '').slice(0, 1000),
    omittedAt: new Date().toISOString(),
  };
}

async function enrichSignalHistoryLinks(runRoot, options = {}) {
  const messages = readJsonl(path.join(runRoot, 'messages.jsonl'));
  const urls = [...new Set(messages.flatMap(messageUrls))];
  let cursor = 0;
  const results = [];
  const fetcher = options.fetchSharedUrl || fetchSharedUrl;
  async function worker() {
    while (cursor < urls.length) {
      const position = cursor++;
      const url = urls[position];
      const dir = linkDirectory(runRoot, url);
      const contextFile = path.join(dir, 'context.json');
      const prior = readJson(contextFile, null);
      if (prior?.urlHash === sha256Value(url)) {
        if (['fetched', 'omitted'].includes(prior.status)) {
          results.push(prior);
          continue;
        }
        if (prior.status === 'failed' && isHistoricalLinkSourceUnavailable(prior.error)) {
          const omitted = omittedLinkContext(url, prior.error, prior);
          omitted.migratedFrom = {
            status: 'failed',
            recordedAt: prior.failedAt || prior.fetchedAt || null,
          };
          delete omitted.error;
          delete omitted.fetchedAt;
          delete omitted.failedAt;
          atomicWriteJson(contextFile, omitted);
          results.push(omitted);
          continue;
        }
      }
      let context;
      try {
        const fetched = await fetcher(url, {
          timeoutMs: options.timeoutMs || 20_000,
          maxBytes: options.maxBytes || 5 * 1024 * 1024,
        });
        const extension = /html/.test(fetched.contentType) ? '.html' : /json/.test(fetched.contentType) ? '.json' : '.bin';
        const pageFile = path.join(dir, `page${extension}`);
        writeBufferAtomic(pageFile, fetched.body);
        context = {
          schema: 'amy.signal.history-link-context.v1',
          status: 'fetched',
          url,
          urlHash: sha256Value(url),
          finalUrl: fetched.finalUrl,
          canonicalUrl: fetched.canonicalUrl,
          title: fetched.title,
          description: fetched.description,
          excerpt: fetched.excerpt,
          contentType: fetched.contentType,
          bytes: fetched.bytes,
          sha256: fetched.sha256,
          mediaExpected: fetched.mediaExpected,
          pageFile,
          fetchedAt: new Date().toISOString(),
        };
      } catch (error) {
        context = isHistoricalLinkSourceUnavailable(error)
          ? omittedLinkContext(url, error)
          : {
              schema: 'amy.signal.history-link-context.v1',
              status: 'failed',
              url,
              urlHash: sha256Value(url),
              error: String(error.message || error).slice(0, 1000),
              failedAt: new Date().toISOString(),
            };
      }
      atomicWriteJson(contextFile, context);
      results.push(context);
      if (options.onProgress) options.onProgress({ position: position + 1, total: urls.length, status: context.status });
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Number(options.concurrency || 6)), Math.max(1, urls.length)) }, () => worker()));
  const fetched = results.filter((row) => row.status === 'fetched').length;
  const omitted = results.filter((row) => row.status === 'omitted').length;
  const failed = results.filter((row) => row.status === 'failed').length;
  const coverage = {
    schema: 'amy.signal.history-link-coverage.v1',
    status: failed === 0 && fetched + omitted === urls.length ? 'green' : 'red',
    urls: urls.length,
    fetched,
    omitted,
    failed,
    mediaExpected: results.filter((row) => row.mediaExpected).length,
    omissionReason: omitted ? 'historical-url-unavailable' : null,
    note: 'Unavailable historical URLs are omitted; Signal-exported preview context remains indexed.',
  };
  atomicWriteJson(path.join(runRoot, 'link-coverage.json'), coverage);
  return coverage;
}

function archiveDerivativeKey(runRoot, file) {
  const exportName = path.basename(path.resolve(runRoot));
  const relative = path.relative(runRoot, file).replace(/\\/g, '/');
  return `${HISTORY_ARCHIVE_PREFIX}/${exportName}/derived/${relative}`;
}

function uploadFileInChild(localPath, options = {}) {
  const workerOptions = {
    bucket: options.bucket,
    region: options.region,
    key: options.key,
    requireChecksumSha256: options.requireChecksumSha256,
    allowSensitive: options.allowSensitive,
    dryRun: options.dryRun,
  };
  const encodedOptions = Buffer.from(JSON.stringify(workerOptions), 'utf8').toString('base64');
  const workerSource = [
    "const [modulePath, localPath, encoded] = process.argv.slice(1);",
    "const { uploadFile } = require(modulePath);",
    "(async () => {",
    "try {",
    "  const options = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));",
    "  process.stdout.write(JSON.stringify(await uploadFile(localPath, options)));",
    "} catch (error) {",
    "  process.stderr.write(String(error && error.stack || error));",
    "  process.exitCode = 1;",
    "}",
    "})()",
  ].join('\n');
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['-e', workerSource, require.resolve('./cloud-archive.js'), localPath, encodedOptions],
      {
        encoding: 'utf8',
        env: options.env || process.env,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 180_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.message = `${error.message}: ${String(stderr || '').trim()}`.slice(0, 2000);
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(stdout || '{}'));
        } catch (parseError) {
          reject(new Error(`Archive worker returned invalid JSON: ${parseError.message}`));
        }
      },
    );
  });
}

async function archiveSignalDerivatives(runRoot, options = {}) {
  const indexFile = path.join(runRoot, 'derived-archive-index.json');
  const index = readJson(indexFile, {
    schema: 'amy.signal.history-derived-archive.v1',
    runRoot: path.resolve(runRoot),
    startedAt: new Date().toISOString(),
    objects: {},
  });
  const files = derivativeArchiveFiles(runRoot);
  let uploaded = 0;
  let reused = 0;
  let processed = 0;
  let cursor = 0;
  const failures = [];
  const concurrency = Math.min(16, Math.max(1, Number(options.concurrency || 8)));
  const uploader = options.uploadFile
    ? async (file, uploadOptions) => options.uploadFile(file, uploadOptions)
    : uploadFileInChild;
  async function worker() {
    while (cursor < files.length) {
      const file = files[cursor++];
      const relativePath = path.relative(runRoot, file).replace(/\\/g, '/');
      const bytes = fs.statSync(file).size;
      const digest = sha256File(file);
      const prior = index.objects[relativePath];
      if (prior?.status === 'verified' && prior.sha256 === digest && prior.bytes === bytes) {
        reused += 1;
      } else {
        try {
          const receipt = await uploader(file, {
            env: options.env || process.env,
            bucket: options.bucket,
            region: options.region || 'us-east-1',
            key: archiveDerivativeKey(runRoot, file),
            requireChecksumSha256: true,
            allowSensitive: true,
          });
          index.objects[relativePath] = { status: 'verified', ...receipt };
          uploaded += 1;
        } catch (error) {
          const failure = {
            status: 'failed',
            bytes,
            sha256: digest,
            error: String(error.message || error).slice(0, 2000),
            failedAt: new Date().toISOString(),
          };
          index.objects[relativePath] = failure;
          failures.push({ relativePath, ...failure });
        }
      }
      processed += 1;
      index.updatedAt = new Date().toISOString();
      atomicWriteJson(indexFile, index);
      if (options.onProgress) options.onProgress({ position: processed, total: files.length, relativePath });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, files.length)) }, () => worker()));
  const verified = files.filter((file) => {
    const relativePath = path.relative(runRoot, file).replace(/\\/g, '/');
    const receipt = index.objects[relativePath];
    return receipt?.status === 'verified' && receipt.sha256 === sha256File(file) && receipt.bytes === fs.statSync(file).size;
  }).length;
  index.completedAt = new Date().toISOString();
  index.status = verified === files.length ? 'verified' : 'incomplete';
  index.files = files.length;
  index.verified = verified;
  index.uploadedThisRun = uploaded;
  index.reusedThisRun = reused;
  index.failedThisRun = failures.length;
  index.failures = failures;
  atomicWriteJson(indexFile, index);
  if (failures.length) {
    throw new Error(`Derivative archive left ${failures.length} failed object(s); rerun to retry them.`);
  }
  return index;
}

function attachmentExtraction(runRoot, sha256) {
  const receiptFile = path.join(runRoot, 'attachments-derived', sha256, 'receipt.json');
  const receipt = readJson(receiptFile, null);
  let searchableText = '';
  if (receipt?.searchableTextPath && fs.existsSync(receipt.searchableTextPath)) {
    searchableText = fs.readFileSync(receipt.searchableTextPath, 'utf8').trim();
  }
  return { receiptFile, receipt, searchableText };
}

function messageGraphitiBody(message, runRoot, rawArchive) {
  const conversation = message.conversation || {};
  const attachmentParts = [];
  for (const attachment of message.attachments || []) {
    if (!attachment.available) {
      attachmentParts.push(
        `Attachment ${attachment.filename || attachment.kind || 'file'} was referenced but absent from the Signal export.`,
      );
      continue;
    }
    const extracted = attachmentExtraction(runRoot, attachment.file.sha256);
    const searchable = String(extracted.searchableText || '').slice(0, 12_000);
    attachmentParts.push([
      `Attachment: ${attachment.filename || path.basename(attachment.file.path)}; content type ${attachment.contentType || 'unknown'}; sha256 ${attachment.file.sha256}.`,
      extracted.receipt?.status === 'failed'
        ? `Attachment extraction failed and coverage remains incomplete: ${String(extracted.receipt.error || 'unknown extraction failure').slice(0, 500)}`
        : searchable
          ? `Searchable attachment context: ${searchable}`
          : 'Attachment was inspected and yielded no searchable text.',
    ].join('\n'));
  }
  const links = messageUrls(message);
  const previews = new Map((message.linkPreviews || []).map((preview) => [preview.url, preview]));
  const linkParts = links.map((url) => {
    const preview = previews.get(url) || {};
    const fetched = readJson(path.join(linkDirectory(runRoot, url), 'context.json'), {});
    return [
      `Shared link: ${url}`,
      fetched.canonicalUrl && fetched.canonicalUrl !== url ? `Canonical URL: ${fetched.canonicalUrl}` : '',
      fetched.title || preview.title ? `Link title: ${fetched.title || preview.title}` : '',
      fetched.description || preview.description ? `Link description: ${fetched.description || preview.description}` : '',
      fetched.excerpt ? `Page context: ${String(fetched.excerpt).slice(0, 10_000)}` : '',
      fetched.status === 'omitted'
        ? 'Historical URL was unavailable and omitted; Signal-exported preview context was retained.'
        : fetched.status === 'failed'
          ? 'Historical URL processing failed; coverage remains incomplete.'
          : '',
    ].filter(Boolean).join('\n');
  });
  const rawReceipt = rawArchive?.objects?.['main.jsonl'];
  const body = [
    `Historical Signal ${message.direction} message in ${conversation.type || 'unknown'} conversation with ${conversation.label || 'unknown participant'} at ${message.referenceTime}.`,
    message.text ? `Message: ${message.text}` : message.fallbackSummary || 'Message contained no text.',
    message.quote?.text ? `Quoted message context from ${message.quote.author || 'unknown author'}: ${message.quote.text}` : '',
    ...(message.revisions || []).filter((revision) => revision.text).map((revision) => `Earlier revision: ${revision.text}`),
    ...linkParts,
    ...attachmentParts,
    `Permanent raw export: ${rawReceipt?.s3Uri || 'raw export archive receipt pending'}.`,
    `Historical event id: ${message.eventId}.`,
  ].filter(Boolean).join('\n');
  return { body, links };
}

async function prepareGraphitiHistory(runRoot, options = {}) {
  const messages = readJsonl(path.join(runRoot, 'messages.jsonl'));
  const rawArchive = readJson(path.join(runRoot, 'raw-archive-index.json'), {});
  if (rawArchive.status !== 'verified') {
    throw new Error('Raw Signal export archive is not verified; Graphiti preparation is blocked');
  }
  const attachmentCoverage = readJson(path.join(runRoot, 'attachment-coverage.json'), {});
  const attachmentReceiptsComplete =
    attachmentCoverage.schema === 'amy.signal.history-attachment-coverage.v1' &&
    Number(attachmentCoverage.coveredPayloads || 0) + Number(attachmentCoverage.failedPayloads || 0) ===
      Number(attachmentCoverage.uniquePayloads || 0);
  if (!attachmentReceiptsComplete) {
    throw new Error('Available Signal attachments do not all have success or explicit failure receipts; Graphiti preparation is blocked');
  }
  const derivedArchive = readJson(path.join(runRoot, 'derived-archive-index.json'), {});
  if (derivedArchive.status !== 'verified') {
    throw new Error('Searchable Signal derivatives are not checksum-verified in S3; Graphiti preparation is blocked');
  }
  const observedAt = new Date().toISOString();
  const events = [];
  const privacyReceipts = [];
  for (const message of messages) {
    const context = messageGraphitiBody(message, runRoot, rawArchive);
    const privacyInput = [
      message.conversation?.label || '',
      message.author?.label || '',
      context.body,
    ].join('\n');
    const privacyRedacted = findForbiddenPeople(privacyInput).length > 0;
    const body = privacyRedacted
      ? [
          `Historical Signal ${message.direction} message at ${message.referenceTime}.`,
          'Message content, attachment context, citations, and participant were suppressed as privacy_redacted_person.',
          `Permanent historical event id: ${message.eventId}.`,
        ].join('\n')
      : context.body;
    privacyReceipts.push({
      schema: 'amy.signal.history-privacy-screen.v1',
      eventId: message.eventId,
      status: privacyRedacted ? 'redacted' : 'passed',
      graphitiOutputScreened: true,
      peopleOutputScreened: true,
    });
    events.push({
      source: `signal-history-${message.direction}`,
      source_id: message.eventId,
      source_description: 'signal-plaintext-export-history',
      name: privacyRedacted
        ? `Signal history ${message.direction} privacy-redacted`
        : `Signal history ${message.direction} ${message.eventId}`,
      body,
      reference_time: message.referenceTime,
      observed_at: observedAt,
      raw_path: path.join(runRoot, 'messages.jsonl'),
      s3_uri: rawArchive.objects?.['main.jsonl']?.s3Uri || null,
      contact_name: privacyRedacted ? null : message.conversation?.label || null,
      direction: message.direction,
      metadata: {
        historical_signal_event_id: message.eventId,
        privacy_screen: privacyRedacted ? 'redacted' : 'passed',
        attachment_references: message.attachments.length,
        attachment_coverage_complete: message.attachmentCoverageComplete,
        missing_attachment_references: message.attachments.filter((attachment) => !attachment.available).length,
        shared_links: context.links.length,
      },
    });
  }
  const graphitiRoot = options.graphitiRoot || path.join(runRoot, 'graphiti-runtime');
  const normalizedEvents = events.map((event) => normalizeEvent(event));
  await Promise.all([
    writeJsonl(path.join(runRoot, 'graphiti-plan.jsonl'), normalizedEvents),
    writeJsonl(path.join(runRoot, 'privacy-screen.jsonl'), privacyReceipts),
  ]);
  const appendResult = appendEventsBulk(normalizedEvents, { root: graphitiRoot });
  const result = {
    schema: 'amy.signal.history-graphiti-plan.v1',
    status: normalizedEvents.length === messages.length ? 'ready' : 'red',
    graphitiRoot,
    messages: messages.length,
    events: normalizedEvents.length,
    privacyPassed: privacyReceipts.filter((receipt) => receipt.status === 'passed').length,
    privacyRedacted: privacyReceipts.filter((receipt) => receipt.status === 'redacted').length,
    appendResult,
    executionMode: 'finite-direct-history-import',
  };
  atomicWriteJson(path.join(runRoot, 'graphiti-plan-receipt.json'), result);
  return result;
}

function graphitiHistoryCoverage(runRoot, options = {}) {
  const plan = readJsonl(path.join(runRoot, 'graphiti-plan.jsonl'));
  const graphitiRoot = options.graphitiRoot || path.join(runRoot, 'graphiti-runtime');
  const receiptIndex = readReceiptIndex(graphitiRoot);
  const statuses = {};
  const failures = [];
  for (const event of plan) {
    const receipt = receiptIndex[event.event_id];
    const status = receipt?.status || 'pending';
    statuses[status] = (statuses[status] || 0) + 1;
    if (status !== 'ok') failures.push({ eventId: event.source_id, graphitiEventId: event.event_id, status, detail: receipt?.detail || '' });
  }
  const result = {
    schema: 'amy.signal.history-graphiti-coverage.v1',
    status: plan.length > 0 && failures.length === 0 ? 'green' : 'red',
    graphitiRoot,
    plannedEvents: plan.length,
    acceptedEvents: statuses.ok || 0,
    statusCounts: statuses,
    uncoveredEvents: failures.length,
    failures: failures.slice(0, 1000),
  };
  atomicWriteJson(path.join(runRoot, 'graphiti-coverage.json'), result);
  return result;
}

function signalHistoryOverallCoverage(runRoot) {
  const inspection = readJson(path.join(runRoot, 'inspection.json'), {});
  const missingAttachmentReferences = Number(inspection.attachmentCoverage?.missingReferences || 0);
  const missingAttachmentReceipt = path.join(runRoot, 'missing-attachments.jsonl');
  const missingAttachmentRows = readJsonl(missingAttachmentReceipt);
  const sourceAttachmentOmissionsReceipted =
    missingAttachmentReferences === 0 ||
    (fs.existsSync(missingAttachmentReceipt) &&
      missingAttachmentRows.length === missingAttachmentReferences &&
      missingAttachmentRows.every((row) => row.reason === 'not-present-in-signal-plaintext-export'));
  const stages = {
    rawArchive: readJson(path.join(runRoot, 'raw-archive-index.json'), {}),
    recoveryArchive: readJson(path.join(runRoot, 'recovery-archive-index.json'), {}),
    attachmentExtraction: readJson(path.join(runRoot, 'attachment-coverage.json'), {}),
    linkContext: readJson(path.join(runRoot, 'link-coverage.json'), {}),
    derivativeArchive: readJson(path.join(runRoot, 'derived-archive-index.json'), {}),
    lifeArchive: readJson(path.join(runRoot, 'life-archive-coverage.json'), {}),
    graphiti: readJson(path.join(runRoot, 'graphiti-coverage.json'), {}),
    people: readJson(path.join(runRoot, 'people-coverage.json'), {}),
  };
  const recoveredPayloads = Number(inspection.attachmentCoverage?.recoveredPhysicalPayloads || 0);
  const checks = {
    rawArchive: stages.rawArchive.status === 'verified',
    recoveryArchive: recoveredPayloads === 0 || stages.recoveryArchive.status === 'verified',
    attachmentExtraction: stages.attachmentExtraction.status === 'green',
    linkContext: stages.linkContext.status === 'green',
    derivativeArchive: stages.derivativeArchive.status === 'verified',
    lifeArchive: stages.lifeArchive.status === 'green',
    graphiti: stages.graphiti.status === 'green',
    people: stages.people.status === 'green',
    sourceAttachmentOmissionsReceipted,
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  const result = {
    schema: 'amy.signal.history-overall-coverage.v1',
    status: failedChecks.length ? 'red' : 'green',
    generatedAt: new Date().toISOString(),
    logicalMessages: inspection.logicalMessages || null,
    sourceChatItemRecords: inspection.sourceChatItemRecords || null,
    attachmentReferences: inspection.attachmentCoverage?.references || 0,
    availableUniquePayloads: inspection.attachmentCoverage?.uniqueMatchedHashes || 0,
    missingAttachmentReferences,
    missingUniquePayloads: inspection.attachmentCoverage?.uniqueMissingHashes || 0,
    omitted: {
      sourceAttachments: {
        attachmentReferences: missingAttachmentReferences,
        uniquePayloads: inspection.attachmentCoverage?.uniqueMissingHashes || 0,
        reason: 'not-present-in-signal-plaintext-export',
      },
      linkContext: {
        urls: Number(stages.linkContext.omitted || 0),
        reason: 'historical-url-unavailable',
      },
    },
    checks,
    failedChecks,
    stages: Object.fromEntries(
      Object.entries(stages).map(([name, value]) => [name, { status: value.status || 'missing' }]),
    ),
  };
  atomicWriteJson(path.join(runRoot, 'overall-coverage.json'), result);
  return result;
}

module.exports = {
  collectPointerReferences,
  collectAllPointerReferences,
  exportFileHash,
  inspectSignalExport,
  archiveKey,
  archiveDerivativeKey,
  archiveSignalDerivatives,
  archiveSignalExport,
  archiveSignalRecovery,
  archiveSourceFiles,
  atomicWriteJson,
  applySignalCacheRecovery,
  enrichSignalHistoryLinks,
  HISTORY_ARCHIVE_PREFIX,
  graphitiHistoryCoverage,
  normalizeSignalHistory,
  linkDirectory,
  messageUrls,
  prepareGraphitiHistory,
  parseSignalExportJsonl,
  physicalAttachmentIndex,
  plaintextHashHex,
  publicInspection,
  prepareSignalHistory,
  readJson,
  readJsonl,
  recipientDescriptor,
  sha256File,
  signalHistoryOverallCoverage,
  stableMessageId,
  uploadFileInChild,
  walkFiles,
  writeJsonl,
};
