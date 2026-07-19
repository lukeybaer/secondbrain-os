#!/usr/bin/env node
/**
 * Lightweight post-click backpropagation for Daily Briefing voice confirmations.
 *
 * This is intentionally small and sequential so the web endpoint can fire it in
 * the background after ExampleCo clicks Confirm / Not them / Correct name.
 */

const { spawnSync } = require('child_process');

function isSoftResolverFailure(label, status, stdout, stderr) {
  if (label !== 'wavlm_resolver' || status !== 2 || String(stderr || '').trim()) return false;
  try {
    const report = JSON.parse(stdout);
    const errors = Array.isArray(report?.errors) ? report.errors : [];
    return (
      report?.schema === 'life_archive_otter_speaker_resolver.v2' &&
      errors.length > 0 &&
      errors.every((error) => error?.error === 'embedding_unusable')
    );
  } catch {
    return false;
  }
}

function run(label, args) {
  const timeoutByLabel = {
    apply: 300000,
    apply_cluster_resolutions: 300000,
    voice_confirmed_match_sanity: 300000,
    promote_confirmed_acoustic: 300000,
    apply_promoted_cluster_resolutions: 300000,
    wavlm_resolver: 900000,
    refresh: 180000,
  };
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      SKIP_EC2_PUBLISH: '1',
      SPEAKER_IDENTITY_CHANGE_SYNC: '0',
      // The refresh step runs refresh-briefing-generated-sections.js, whose
      // whole-document write is lease-gated (scripts/lib/briefing-write-guard.js).
      // This backprop pipeline is a sanctioned automated spawner, so it passes
      // the scheduler lease through; every other step ignores the variable.
      ...(label === 'refresh' ? { BRIEFING_SCHEDULED_RUN: '1' } : {}),
    },
    timeout: timeoutByLabel[label] || 120000,
  });
  const softFailure = isSoftResolverFailure(label, result.status, result.stdout, result.stderr);
  return {
    label,
    args,
    status: result.status,
    ok: result.status === 0 || softFailure,
    soft_failure: softFailure,
    stdout: String(result.stdout || '').slice(-4000),
    stderr: String(result.stderr || '').slice(-4000),
  };
}

function main() {
  const steps = [
    ['apply', ['scripts/apply-voice-confirmation-actions.js', '--write']],
    [
      'apply_cluster_resolutions',
      ['scripts/apply-voice-cluster-resolutions.js', '--write', '--json'],
    ],
    [
      'wavlm_resolver',
      [
        'scripts/otter-wavlm-speaker-resolver.js',
        '--write',
        '--limit',
        process.env.VOICE_BACKPROP_WAVLM_LIMIT || '80',
      ],
    ],
    [
      'speaker_identity_completeness',
      ['scripts/otter-speaker-identity-completeness.js', '--write'],
    ],
    ['voice_confirmed_match_sanity', ['scripts/voice-confirmed-match-sanity-check.js', '--write']],
    [
      'promote_confirmed_acoustic',
      ['scripts/voice-promote-confirmed-acoustic-matches.js', '--write'],
    ],
    [
      'apply_promoted_cluster_resolutions',
      ['scripts/apply-voice-cluster-resolutions.js', '--write', '--json'],
    ],
    [
      'speaker_identity_completeness_after_promotion',
      ['scripts/otter-speaker-identity-completeness.js', '--write'],
    ],
    ['life_relevance', ['scripts/otter-life-relevance-enricher.js', '--write']],
    ['speaker_intelligence_report', ['scripts/otter-speaker-intelligence-report.js', '--write']],
    [
      'speaker_people_sync',
      ['scripts/sync-otter-speaker-intelligence-to-people-files.js', '--write'],
    ],
    [
      'sync_people',
      ['scripts/sync-voiceprints-to-people-files.js', '--write', '--all-contacts', '--json'],
    ],
    ['queue', ['scripts/voice-confirmation-queue-build.js', '--write']],
    [
      'audio',
      [
        'scripts/otter-audio-download.js',
        'queue',
        '--queue',
        'data/life-archive/people/briefing-voice-queue-latest.json',
        '--limit',
        process.env.VOICE_CONFIRMATION_AUDIO_LIMIT || '60',
        '--json',
      ],
    ],
    ['refresh', ['scripts/refresh-briefing-generated-sections.js', '--no-publish', '--skip-gate']],
  ];
  const results = [];
  for (const [label, args] of steps) {
    const result = run(label, args);
    results.push(result);
    if (!result.ok && label !== 'audio') break;
  }
  const report = {
    schema: 'life_archive_voice_confirmation_backprop.v1',
    generated_at: new Date().toISOString(),
    ok: results.every((row) => row.ok || row.label === 'audio'),
    results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

main();
