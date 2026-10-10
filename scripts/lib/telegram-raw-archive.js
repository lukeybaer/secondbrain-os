'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function writeAndSync(file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeAndSyncIdempotent(file, buffer) {
  try {
    writeAndSync(file, buffer);
    return;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const existing = fs.readFileSync(file);
  if (!existing.equals(buffer)) {
    throw new Error(`Telegram archive replay did not match existing evidence at ${file}`);
  }
}

function safeName(value, fallback) {
  const normalized = path.basename(String(value || fallback)).replace(/[^a-zA-Z0-9._-]/g, '_');
  return normalized || fallback;
}

function archiveTelegramUpdate({ update, dataDir, attachments = [] }) {
  if (!dataDir) throw new Error('archiveTelegramUpdate requires dataDir');
  if (!update || update.update_id == null) throw new Error('archiveTelegramUpdate requires update_id');
  const message = update.message || update.edited_message || update.callback_query?.message || {};
  const root = path.join(
    dataDir,
    'telegram',
    'raw',
    `${String(update.update_id)}-${String(message.message_id || 'callback')}`,
  );
  const updatePath = path.join(root, 'update.json');
  writeAndSyncIdempotent(updatePath, Buffer.from(`${JSON.stringify(update, null, 2)}\n`, 'utf8'));

  const archivedAttachments = attachments.map((attachment, index) => {
    const source = String(attachment?.local_path || attachment?.path || '');
    if (!source || !fs.existsSync(source)) {
      throw new Error(`Telegram attachment ${index} has no readable local source`);
    }
    const bytes = fs.readFileSync(source);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const ext = path.extname(source);
    const name = safeName(attachment.file_name, `attachment-${index + 1}${ext}`);
    const destination = path.join(root, 'attachments', `${index + 1}-${sha256.slice(0, 12)}-${name}`);
    writeAndSyncIdempotent(destination, bytes);
    return {
      ...attachment,
      local_path: destination,
      source_local_path: undefined,
      sha256,
      size_bytes: bytes.length,
      archived: true,
    };
  });

  return {
    schema: 'amy.telegram-raw-archive.v1',
    update_id: update.update_id,
    message_id: message.message_id ?? null,
    update_path: updatePath,
    attachments: archivedAttachments,
  };
}

module.exports = { archiveTelegramUpdate };
