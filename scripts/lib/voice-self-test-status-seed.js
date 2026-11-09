'use strict';

const crypto = require('node:crypto');

const SEED_EVENT = 'voice-self-test-status-seed';
const CLEAR_EVENT = 'voice-self-test-status-clear';
const SEED_CALL_ID_RE = /^self_test_seed_[a-z0-9_-]{6,80}$/i;
const MAX_TOPIC_CHARS = 160;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const activeSeeds = new Map();

function cleanTopic(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TOPIC_CHARS);
}

function taskIdForSeed(seedId) {
  const digest = crypto.createHash('sha256').update(String(seedId || '')).digest('hex').slice(0, 24);
  return `spine-voice-self-test-${digest}`;
}

function handleVoiceSelfTestStatusEvent(message = {}, callObj = {}, opts = {}) {
  const eventType = String(message.type || '');
  if (eventType !== SEED_EVENT && eventType !== CLEAR_EVENT) return null;

  const seedId = String(message.seedId || callObj.id || '').trim();
  const callerPhone = String(opts.callerPhone || callObj?.customer?.number || '');
  const ownerAuthorized =
    typeof opts.isOwnerPhone === 'function' && opts.isOwnerPhone(callerPhone) === true;
  if (!SEED_CALL_ID_RE.test(seedId) || !ownerAuthorized) {
    return { status: 403, body: { error: 'self-test seed not authorized' } };
  }

  const taskId = taskIdForSeed(seedId);
  if (eventType === CLEAR_EVENT) {
    activeSeeds.delete(taskId);
    return { status: 200, body: { received: true, cleared: true, taskId } };
  }

  const topic = cleanTopic(message.topic);
  if (!topic) return { status: 400, body: { error: 'self-test seed topic required' } };
  const nowMs = Number(opts.nowMs || Date.now());
  const expiresAt = new Date(nowMs + Number(opts.ttlMs || DEFAULT_TTL_MS)).toISOString();
  activeSeeds.set(taskId, {
    id: taskId,
    // Keep the title equal to the spoken lookup subject. Prefixing it with a
    // diagnostic label diluted the live check_spine title score enough that a
    // correctly seeded proof could return a false "not active" answer.
    title: topic,
    status: 'running',
    ageHours: 0,
    origin: 'voice-self-test',
    createdAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
    expiresAt,
  });
  return {
    status: 200,
    body: { received: true, seeded: true, taskId, expiresAt },
  };
}

function getActiveVoiceSelfTestStatuses(limit = 8, opts = {}) {
  const nowMs = Number(opts.nowMs || Date.now());
  for (const [taskId, task] of activeSeeds) {
    if (Date.parse(task.expiresAt) <= nowMs) activeSeeds.delete(taskId);
  }
  return [...activeSeeds.values()]
    .sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt))
    .slice(0, Math.max(0, Number(limit) || 0))
    .map(({ expiresAt: _expiresAt, ...task }) => task);
}

module.exports = {
  CLEAR_EVENT,
  DEFAULT_TTL_MS,
  SEED_EVENT,
  cleanTopic,
  getActiveVoiceSelfTestStatuses,
  handleVoiceSelfTestStatusEvent,
  taskIdForSeed,
};
