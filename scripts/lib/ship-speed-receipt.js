'use strict';
// ship-speed-receipt.js
//
// The owner's ship-jam S-7 (2026-11-16): missing the land or deploy speed targets
// shows red on the briefing. Pure read of agent/ship-speed-latest.json, written
// by the speed recorder (schema ship-speed@1). Nothing runs here.
//
// Colors: red when the file is missing or unreadable ("never proven") or its
// status is red; yellow when generated_at is older than 7 days; green otherwise.

const fs = require('node:fs');
const path = require('node:path');

const SHIP_SPEED_SCHEMA = 'ship-speed@1';
const SHIP_SPEED_BASENAME = 'ship-speed-latest.json';
const STALE_MS = 7 * 24 * 3600 * 1000;
const ROW_LABEL = 'Ship speed';

function readJson(file) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}

function minutes(ms) {
  return `${(Number(ms) / 60000).toFixed(1)} min`;
}

function part(label, section) {
  const n = section && Number.isFinite(Number(section.count)) ? Number(section.count) : 0;
  const med = section && section.median_ms != null && Number.isFinite(Number(section.median_ms)) ? minutes(section.median_ms) : 'no data';
  return `${label} ${med} (n=${n})`;
}

function shipSpeedVerdict({ dataDir, nowMs = Date.now() } = {}) {
  const json = readJson(path.join(dataDir || '', 'agent', SHIP_SPEED_BASENAME));
  if (!json || json.schema !== SHIP_SPEED_SCHEMA) {
    return { status: 'red', detail: 'never proven: no readable ship speed receipt has been written here yet' };
  }
  const reason = String(json.reason || '').trim();
  if (json.status === 'red') {
    return { status: 'red', detail: reason || 'a land or deploy median missed its speed target' };
  }
  const at = Date.parse(json.generated_at);
  if (!Number.isFinite(at)) {
    return { status: 'red', detail: 'never proven: the ship speed receipt has no valid time' };
  }
  if (nowMs - at > STALE_MS) {
    const days = Math.floor((nowMs - at) / (24 * 3600 * 1000));
    return { status: 'yellow', detail: `stale: the ship speed receipt is ${days} days old (written ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC)` };
  }
  if (json.status !== 'green') {
    return { status: 'red', detail: reason || 'never proven: the ship speed receipt has no verdict' };
  }
  return { status: 'green', detail: `median ${part('land', json.land)}, ${part('deploy', json.deploy)}` };
}

function shipSpeedRow({ dataDir, nowMs } = {}) {
  const verdict = shipSpeedVerdict({ dataDir, nowMs });
  const glyph = verdict.status === 'green' ? '✓' : verdict.status === 'yellow' ? '⚠' : '✗';
  return { ...verdict, line: `${glyph} ${ROW_LABEL}: ${verdict.detail}.` };
}

module.exports = { ROW_LABEL, SHIP_SPEED_BASENAME, SHIP_SPEED_SCHEMA, STALE_MS, shipSpeedRow, shipSpeedVerdict };
