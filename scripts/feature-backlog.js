#!/usr/bin/env node
// feature-backlog.js
//
// Manages the ranked feature backlog for SecondBrain improvements.
// Stored git-tracked at data/agent/feature-backlog.json (pushed to GitHub).
//
// Scoring rules:
//   Pain event:              +15 to +25 depending on severity
//   Research confirmation:   +5 to +15 depending on relevance
//   Daily decay:             -5 per day with no new signal
//   Floor: 0 (removed), ceiling: 100, max 10 items

const fs = require('fs');
const path = require('path');

const REPO = process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..');
const BACKLOG_PATH = path.join(REPO, 'data', 'agent', 'feature-backlog.json');

// Scoring constants
const PAIN_SEVERITY = {
  rejection: 20,        // video rejected by owner
  health_red: 20,       // health check red status
  gap_trigger: 25,      // explicit #gap from the owner
  bug_fix_commit: 15,   // git commit fixing a bug
  health_yellow: 10,    // health check yellow status
  recurring_rejection: 25, // same video, same issue, again
};

const RESEARCH_RELEVANCE = {
  high: 15,    // directly applicable pattern
  medium: 10,  // related but needs adaptation
  low: 5,      // tangentially relevant
};

const DAILY_DECAY = 5;
const SCORE_FLOOR = 0;
const SCORE_CEILING = 100;
const MAX_ITEMS = 10;

function loadBacklog() {
  try {
    const raw = fs.readFileSync(BACKLOG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { version: 1, last_updated: new Date().toISOString(), features: [] };
  }
}

function saveBacklog(backlog) {
  backlog.version = (backlog.version || 0) + 1;
  backlog.last_updated = new Date().toISOString();
  fs.mkdirSync(path.dirname(BACKLOG_PATH), { recursive: true });
  fs.writeFileSync(BACKLOG_PATH, JSON.stringify(backlog, null, 2) + '\n');
}

function clampScore(score) {
  return Math.max(SCORE_FLOOR, Math.min(SCORE_CEILING, score));
}

function addPainEvent(backlog, featureId, { source, detail, severity }) {
  const feature = backlog.features.find(f => f.id === featureId);
  if (!feature) return false;

  const delta = PAIN_SEVERITY[severity] || PAIN_SEVERITY.bug_fix_commit;
  const today = new Date().toISOString().slice(0, 10);

  feature.pain_events.push({ date: today, source, detail });
  feature.score_history.push({ date: today, delta, reason: `pain: ${detail}` });
  feature.priority_score = clampScore(feature.priority_score + delta);
  feature.last_signal_date = today;
  return true;
}

function addResearchConfirmation(backlog, featureId, { repo, finding, relevance }) {
  const feature = backlog.features.find(f => f.id === featureId);
  if (!feature) return false;

  const delta = RESEARCH_RELEVANCE[relevance] || RESEARCH_RELEVANCE.medium;
  const today = new Date().toISOString().slice(0, 10);

  feature.research_confirmations.push({ date: today, repo, finding });
  feature.score_history.push({ date: today, delta, reason: `research: ${repo} -- ${finding}` });
  feature.priority_score = clampScore(feature.priority_score + delta);
  feature.last_signal_date = today;
  return true;
}

function applyDailyDecay(backlog) {
  const today = new Date().toISOString().slice(0, 10);
  for (const feature of backlog.features) {
    if (feature.last_signal_date !== today) {
      feature.score_history.push({ date: today, delta: -DAILY_DECAY, reason: 'decay: no signal today' });
      feature.priority_score = clampScore(feature.priority_score - DAILY_DECAY);
    }
  }
}

function createFeature(backlog, { id, title, description, category, initialScore }) {
  const today = new Date().toISOString().slice(0, 10);
  const score = clampScore(initialScore || 10);
  backlog.features.push({
    id,
    title,
    description,
    category,
    proposed_date: today,
    priority_score: score,
    score_history: [{ date: today, delta: score, reason: 'initial creation' }],
    pain_events: [],
    research_confirmations: [],
    last_signal_date: today,
    status: 'proposed',
  });
}

function rankAndTrim(backlog) {
  // Remove items at floor
  backlog.features = backlog.features.filter(f => f.priority_score > SCORE_FLOOR);
  // Sort descending by score
  backlog.features.sort((a, b) => b.priority_score - a.priority_score);
  // Trim to max
  if (backlog.features.length > MAX_ITEMS) {
    backlog.features = backlog.features.slice(0, MAX_ITEMS);
  }
}

function getBacklogForBriefing(backlog) {
  if (!backlog.features.length) {
    return { items: [], summary: 'Feature backlog is empty.' };
  }

  const items = backlog.features.map((f, i) => {
    const latest = f.score_history.length
      ? f.score_history[f.score_history.length - 1]
      : null;
    return {
      rank: i + 1,
      score: f.priority_score,
      title: f.title,
      latestSignal: latest ? `${latest.delta > 0 ? '+' : ''}${latest.delta} ${latest.reason}` : 'none',
      category: f.category,
    };
  });

  return {
    items,
    count: items.length,
    lastUpdated: backlog.last_updated,
    summary: `${items.length} items tracked, top: ${items[0].title} (${items[0].score})`,
  };
}

function findFeatureByKeywords(backlog, keywords) {
  const kw = keywords.map(k => k.toLowerCase());
  return backlog.features.find(f => {
    const text = `${f.id} ${f.title} ${f.description} ${f.category}`.toLowerCase();
    return kw.some(k => text.includes(k));
  });
}

module.exports = {
  BACKLOG_PATH,
  PAIN_SEVERITY,
  RESEARCH_RELEVANCE,
  DAILY_DECAY,
  SCORE_FLOOR,
  SCORE_CEILING,
  MAX_ITEMS,
  loadBacklog,
  saveBacklog,
  clampScore,
  addPainEvent,
  addResearchConfirmation,
  applyDailyDecay,
  createFeature,
  rankAndTrim,
  getBacklogForBriefing,
  findFeatureByKeywords,
};
