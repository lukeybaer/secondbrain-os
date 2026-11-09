'use strict';

const crypto = require('crypto');

function stableValue(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key], seen)]),
  );
}

function hashKeyArgs(args) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(args ?? {})))
    .digest('hex')
    .slice(0, 16);
}

function errorSignature(error, maxLength = 180) {
  const raw = String(error?.message || error || 'unknown error').toLowerCase();
  return raw
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\b(?:req|run|job|task|session)[-_][a-z0-9_-]+\b/gi, '<id>')
    .replace(/(?:[a-z]:)?[\\/](?:[^\s:]+[\\/])*[^\s:]+/gi, '<path>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

class DoomLoopDetector {
  constructor({ threshold = 3, windowSize = 12, history = [] } = {}) {
    this.threshold = Math.max(2, Number(threshold) || 3);
    this.windowSize = Math.max(this.threshold, Number(windowSize) || 12);
    this.history = Array.isArray(history) ? history.slice(-this.windowSize) : [];
  }

  recordFailure(toolName, keyArgs, error) {
    const entry = {
      tool: String(toolName || 'unknown'),
      argsHash: hashKeyArgs(keyArgs),
      error: errorSignature(error),
      at: new Date().toISOString(),
    };
    this.history.push(entry);
    this.history = this.history.slice(-this.windowSize);
    return entry;
  }

  beforeStep(toolName, keyArgs, { consume = false } = {}) {
    const tool = String(toolName || 'unknown');
    const argsHash = hashKeyArgs(keyArgs);
    const candidates = this.history.filter(
      (entry) => entry.tool === tool && entry.argsHash === argsHash,
    );
    const counts = new Map();
    for (const entry of candidates) {
      counts.set(entry.error, (counts.get(entry.error) || 0) + 1);
    }
    const repeated = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!repeated || repeated[1] < this.threshold) {
      return { doomLoop: false, repetitions: repeated?.[1] || 0 };
    }
    const [error, repetitions] = repeated;
    if (consume) {
      this.history = this.history.filter(
        (entry) => !(entry.tool === tool && entry.argsHash === argsHash && entry.error === error),
      );
    }
    return {
      doomLoop: true,
      tool,
      argsHash,
      error,
      repetitions,
      correctivePrompt:
        `DOOM LOOP DETECTED: ${tool} failed ${repetitions} times with the same arguments ` +
        `and error pattern (${error}). Do not repeat this call unchanged. Change the input, ` +
        'choose a different tool or tactic, or skip this item and surface the blocker.',
    };
  }

  // Additive, and deliberately separate from beforeStep(): beforeStep counts
  // matches ANYWHERE in the window, so two genuinely different attempts
  // separated by an identical-looking retry still trip it. trailingStreak
  // instead walks from the most recent entry BACKWARD and only counts an
  // UNBROKEN run of the same {tool, argsHash, error}, stopping at the first
  // entry that breaks the run. A caller whose history is already reset on
  // every clear (as briefing-card-controller.js's doom-loop history builder
  // does) gets "N identical attempts in a row since the last clear" for
  // free. beforeStep's own semantics and every existing caller are
  // unchanged; this is a new read path over the same history array.
  trailingStreak(toolName, keyArgs, { consume = false } = {}) {
    const tool = String(toolName || 'unknown');
    const argsHash = hashKeyArgs(keyArgs);
    let streak = 0;
    let streakError = null;
    let cutIndex = this.history.length;
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      const entry = this.history[i];
      if (!entry || entry.tool !== tool || entry.argsHash !== argsHash) break;
      if (streakError === null) streakError = entry.error;
      else if (entry.error !== streakError) break;
      streak += 1;
      cutIndex = i;
    }
    if (streak < this.threshold) {
      return { doomLoop: false, repetitions: streak };
    }
    if (consume) {
      this.history = this.history.slice(0, cutIndex);
    }
    return {
      doomLoop: true,
      tool,
      argsHash,
      error: streakError,
      repetitions: streak,
      correctivePrompt:
        `DOOM LOOP DETECTED: ${tool} failed ${streak} times in a row with the same arguments ` +
        `and error pattern (${streakError}). Do not repeat this call unchanged. Change the input, ` +
        'choose a different tool or tactic, or skip this item and surface the blocker.',
    };
  }

  toJSON() {
    return {
      threshold: this.threshold,
      windowSize: this.windowSize,
      history: this.history,
    };
  }
}

module.exports = { DoomLoopDetector, errorSignature, hashKeyArgs };
