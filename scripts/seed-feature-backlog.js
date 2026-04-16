#!/usr/bin/env node
// seed-feature-backlog.js
//
// One-time script to create the initial feature-backlog.json from existing
// rejection data, health-heal logs, and known pain points.
// Run once, then the nightly enhancement task maintains it going forward.

const path = require('path');
const backlog = require('./feature-backlog');

const REPO = process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..');

function main() {
  const bl = backlog.loadBacklog();

  // Only seed if empty
  if (bl.features.length > 0) {
    console.log(`Backlog already has ${bl.features.length} items, skipping seed.`);
    return;
  }

  console.log('Seeding feature backlog from existing pain data...');

  // Feature 1: Multi-shot B-roll composition
  // Evidence: 4 rejections citing single-loop stock footage
  backlog.createFeature(bl, {
    id: 'multi-shot-broll',
    title: 'Multi-shot B-roll composition in video generation',
    description: 'build_video.py loops single stock footage file to full voice duration. Need dynamic multi-shot composition with varied scenes, transitions, and visual variety.',
    category: 'video-pipeline',
    initialScore: 30,
  });
  // Backdate pain events from rejections.jsonl
  const broll = bl.features.find(f => f.id === 'multi-shot-broll');
  broll.proposed_date = '2026-04-04';
  broll.pain_events = [
    { date: '2026-04-04', source: 'rejection', detail: 'mit_30_agents_v2: thumbnail sucks, video does not play' },
    { date: '2026-04-09', source: 'rejection', detail: 'mit_30_agents_v2: robot moving around whole time, improve strategy' },
    { date: '2026-04-13', source: 'rejection', detail: 'mit_30_agents_v2: one robot on loop, no music, no visual effects' },
    { date: '2026-04-13', source: 'rejection', detail: 'anthropic_leak: one stock footage whole time, boring, no music' },
  ];
  broll.score_history = [
    { date: '2026-04-04', delta: 30, reason: 'initial: multiple B-roll rejections' },
    { date: '2026-04-09', delta: 25, reason: 'pain: mit_30_agents_v2 rejected again for monotonous footage' },
    { date: '2026-04-13', delta: 25, reason: 'pain: 2 more rejections citing stock footage loops' },
  ];
  broll.priority_score = backlog.clampScore(80);

  // Feature 2: Silent start detection + aggressive strip
  // Evidence: nine_free_ai_tools rejected for late voice start
  backlog.createFeature(bl, {
    id: 'silent-start-strip',
    title: 'Aggressive silent start detection and removal',
    description: 'strip_leading_silence() in build_video.py uses -45dB threshold which still leaves gaps. Voice must start within 1-2 seconds.',
    category: 'video-pipeline',
    initialScore: 15,
  });
  const silent = bl.features.find(f => f.id === 'silent-start-strip');
  silent.proposed_date = '2026-03-31';
  silent.pain_events = [
    { date: '2026-03-31', source: 'rejection', detail: 'nine_free_ai_tools: starts too late, pause before talking' },
  ];
  silent.score_history = [
    { date: '2026-03-31', delta: 15, reason: 'initial: voice start too late' },
    { date: '2026-03-31', delta: 20, reason: 'pain: nine_free_ai_tools rejected for late start' },
  ];
  silent.priority_score = backlog.clampScore(35);

  // Feature 3: Music variety and background mixing
  // Evidence: ai_agent_income_formula rejected for same song, anthropic_leak "no music"
  backlog.createFeature(bl, {
    id: 'music-variety',
    title: 'Dynamic music selection and background mix levels',
    description: 'MUSIC_MAP in build_video.py has only 3 tracks. Need larger library and per-video selection. Also music volume too low (masked by voice).',
    category: 'video-pipeline',
    initialScore: 15,
  });
  const music = bl.features.find(f => f.id === 'music-variety');
  music.proposed_date = '2026-03-31';
  music.pain_events = [
    { date: '2026-03-31', source: 'rejection', detail: 'ai_agent_income_formula: same song, diversify' },
    { date: '2026-04-13', source: 'rejection', detail: 'mit_30_agents_v2: no music behind' },
    { date: '2026-04-13', source: 'rejection', detail: 'anthropic_leak: no music' },
  ];
  music.score_history = [
    { date: '2026-03-31', delta: 15, reason: 'initial: music variety complaints' },
    { date: '2026-03-31', delta: 20, reason: 'pain: same song rejection' },
    { date: '2026-04-13', delta: 20, reason: 'pain: no music behind in 2 more videos' },
  ];
  music.priority_score = backlog.clampScore(55);

  // Feature 4: Feedback-driven video regen loop
  // Evidence: 4 videos stuck at video_needs_regen:true for weeks
  backlog.createFeature(bl, {
    id: 'feedback-regen-loop',
    title: 'Automatic video regen from rejection feedback',
    description: 'Videos flagged video_needs_regen:true in manifest sit indefinitely. Need automated loop: read rejection feedback, apply fixes, regen, re-QC, re-queue.',
    category: 'video-pipeline',
    initialScore: 20,
  });
  const regen = bl.features.find(f => f.id === 'feedback-regen-loop');
  regen.proposed_date = '2026-04-04';
  regen.pain_events = [
    { date: '2026-04-04', source: 'rejection', detail: '2 videos stuck in regen queue since March 31' },
    { date: '2026-04-13', source: 'rejection', detail: '4 videos now stuck, some for 2+ weeks' },
  ];
  regen.score_history = [
    { date: '2026-04-04', delta: 20, reason: 'initial: videos stuck without auto-regen' },
    { date: '2026-04-13', delta: 25, reason: 'pain: 4 videos stuck, queue growing not shrinking' },
  ];
  regen.priority_score = backlog.clampScore(45);

  // Feature 5: S3 parity persistence
  // Evidence: health-heal shows s3Parity yellow repeatedly
  backlog.createFeature(bl, {
    id: 's3-parity-sync',
    title: 'Reliable S3 parity sync for local backups',
    description: 'backup-cli.ts --sync-orphaned fails with ts-node errors. 7 local snapshots (~83GB) never synced to S3.',
    category: 'infrastructure',
    initialScore: 15,
  });
  const s3 = bl.features.find(f => f.id === 's3-parity-sync');
  s3.proposed_date = '2026-04-10';
  s3.pain_events = [
    { date: '2026-04-10', source: 'health_check', detail: 's3Parity yellow: 7 orphan snapshots' },
    { date: '2026-04-15', source: 'health_check', detail: 's3Parity yellow persists, sync still failing' },
  ];
  s3.score_history = [
    { date: '2026-04-10', delta: 15, reason: 'initial: s3 sync failing' },
    { date: '2026-04-15', delta: 10, reason: 'pain: s3Parity still yellow after 5 days' },
  ];
  s3.priority_score = backlog.clampScore(25);

  // Feature 6: Thumbnail quality generation (not just detection)
  // Evidence: multiple thumbnail rejections, rubric detects but generator doesn't improve
  backlog.createFeature(bl, {
    id: 'thumbnail-generation',
    title: 'High-quality thumbnail generation with face/text overlays',
    description: 'Rubric detects thumbnail quality at 75% accuracy but Grok Aurora thumbnails consistently fail review. Need better generation, not just detection.',
    category: 'video-pipeline',
    initialScore: 15,
  });
  const thumb = bl.features.find(f => f.id === 'thumbnail-generation');
  thumb.proposed_date = '2026-04-04';
  thumb.pain_events = [
    { date: '2026-04-04', source: 'rejection', detail: 'mit_30_agents_v2: thumbnail sucks' },
    { date: '2026-04-04', source: 'rejection', detail: 'anthropic_leak: thumbnail same rejection' },
  ];
  thumb.score_history = [
    { date: '2026-04-04', delta: 15, reason: 'initial: thumbnail quality failing review' },
    { date: '2026-04-04', delta: 20, reason: 'pain: 2 thumbnail rejections same day' },
  ];
  thumb.priority_score = backlog.clampScore(35);

  backlog.rankAndTrim(bl);
  backlog.saveBacklog(bl);

  console.log(`Seeded ${bl.features.length} features:`);
  for (const f of bl.features) {
    console.log(`  ${f.priority_score.toString().padStart(3)} | ${f.id} | ${f.title}`);
  }
  console.log(`\nSaved to ${backlog.BACKLOG_PATH}`);
}

main();
