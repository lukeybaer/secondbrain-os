'use strict';

/**
 * Spine ownership for owner video/thumbnail rejections.
 *
 * owner decision: a rejected video must reach the Task Spine and be carried to
 * a finished, verified result the same way an attended desktop session would.
 * Before this module, the dashboard spawned auto-regen directly, which in turn
 * spawned a detached Claude dispatcher with no lease, no heartbeat and no
 * completion contract, so a vanished or stalled worker dead-lettered the video
 * while nothing owned it.
 *
 * Contract:
 * - One deterministic Task per video + target + rejection revision.
 * - capability `video.regenerate` is task metadata; the EC2 spine worker picks
 *   the runner (spine invariant 5).
 * - Each attempt is bounded at 120 minutes; at most two retries (three attempts).
 * - The Task closes only when the live manifest proves the outcome: new bytes,
 *   rejection cleared, item back in pending_approval for the owner's decision.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { proposalLanguageGate } = require('./clip-language-gate.js');
// owner decision: two of the day's builds open on Sadie (sadie-split-open),
// the third is the usual source cut; the format rides the task meta.
const {
  SOURCE_CUT,
  SADIE_SPLIT_OPEN,
  SADIE_SYNTHETIC_LABEL,
  SADIE_TEMPLATE_DIR,
  SADIE_REFERENCE,
  SADIE_KIT_DIR,
  SHORT_MAX_SECONDS,
  SADIE_TAKE_OPEN,
  SADIE_FORMATS,
  SADIE_TAKE_OPEN_MAX_SECONDS,
  SADIE_SPLIT_OPEN_MAX_SECONDS,
  SADIE_SPLIT_CLOSE_MAX_SECONDS,
  isSadieProposal,
  viralClipFormatOf,
} = require('./viral-clip-formats.js');
const { isLongformProposal } = require('./longform-video.js');

const CAPABILITY = 'video.regenerate';
// owner decision one standard: dashboard "Approve for clip queue" and "Build
// with feedback" are the same spine video work as a rejection, a model session
// on EC2 run by scripts/video-regen-task-runner.js. `video.build` shares the
// lease, heartbeat, attempt bound, card closure and runner; only the inputs
// (the approved proposal) and the acceptance check differ.
const BUILD_CAPABILITY = 'video.build';
const BUILD_MAX_ATTEMPTS = 2;
const ATTEMPT_TIMEOUT_MS = 120 * 60 * 1000;
const MAX_RETRIES = 2;
const MAX_ATTEMPTS = 1 + MAX_RETRIES;
const HEARTBEAT_LEASE_MS = 10 * 60 * 1000;

// Sep 29 2026: six video rebuild sessions started at 9:22 PM kept EC2 CPU at
// 99.8% through the 11:00 PM briefing refresh. A new video attempt waits from
// 22:30 CT until that night's briefing settles, with 05:30 CT as a hard end.
const NIGHT_HOLD_START_MINUTE_CT = 22 * 60 + 30;
const NIGHT_HOLD_END_MINUTE_CT = 5 * 60 + 30;

function ctParts(nowMs) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(nowMs)).map((part) => [part.type, part.value]),
  );
}

function briefingNightHoldsVideoWork(nowMs = Date.now(), { dataDir, readTerminalStateFn } = {}) {
  const parts = ctParts(nowMs);
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  if (minute < NIGHT_HOLD_START_MINUTE_CT && minute > NIGHT_HOLD_END_MINUTE_CT) return false;
  if (minute === NIGHT_HOLD_END_MINUTE_CT) return false;
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  let briefingDate = today;
  if (minute >= NIGHT_HOLD_START_MINUTE_CT) {
    const [y, m, d] = today.split('-').map(Number);
    briefingDate = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  }
  const root = dataDir || process.env.SECONDBRAIN_DATA_DIR || '/opt/secondbrain/data';
  // The canonical reader validates schema, date, state and delivery proof; a
  // missing or malformed receipt keeps the hold (fail closed).
  const read = readTerminalStateFn || require('./briefing-terminal-state.js').readTerminalState;
  const receipt = read({ dataDir: root, date: briefingDate });
  return !(receipt && ['settling', 'frozen', 'delivered'].includes(String(receipt.state || '')));
}
const OPEN_STATUSES = new Set(['queued', 'running']);
const VIDEO_CARD_ID = 'video_approval_queue';
const CARD_CLOSURE_TIMEOUT_MS = 15 * 60 * 1000;
const OWNER_DECIDED_STATUSES = new Set(['approved', 'posted', 'uploading', 'scheduled']);

function dataDir(env = process.env) {
  return (
    env.SECONDBRAIN_DATA_DIR ||
    (process.platform === 'linux'
      ? '/opt/secondbrain/data'
      : path.join(
          env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
          'secondbrain',
          'data',
        ))
  );
}

function tasksDir(env = process.env) {
  return env.SECONDBRAIN_SPINE_TASKS_DIR || path.join(dataDir(env), 'tasks');
}

function slug(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function videoRegenTaskId(videoId, target, revision) {
  const digest = crypto
    .createHash('sha256')
    .update(`${videoId}\n${target}\n${revision}`)
    .digest('hex')
    .slice(0, 10);
  return `video-regen-${slug(videoId).slice(0, 80)}-${target}-${digest}`;
}

function sha256File(file) {
  try {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(1024 * 1024);
      let read;
      while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        hash.update(buf.subarray(0, read));
      }
    } finally {
      fs.closeSync(fd);
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

// Atomic deploys prune old release trees, so a task that recorded its
// manifest through /opt/secondbrain-releases/<sha>/ loses it after a later
// deploy while the manifest itself lives on in the durable tree behind the
// stable /opt/secondbrain link (2026-09-29: three bedtime regen tasks read an
// ENOENT manifest every attempt and never reached the retired-channel check).
const RELEASES_ROOT = '/opt/secondbrain-releases';
const LIVE_ROOT = '/opt/secondbrain';

function liveManifestPath(manifestPath, { releasesRoot = RELEASES_ROOT, liveRoot = LIVE_ROOT } = {}) {
  if (!manifestPath) return manifestPath;
  const rel = path.relative(releasesRoot, String(manifestPath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return manifestPath;
  const [release, ...rest] = rel.split(path.sep);
  // Only the pending manifest of an exact release tree (a commit SHA,
  // optionally with a reland suffix) is rewritten; any other shape is
  // returned untouched rather than mapped to a wrong live path.
  if (!/^[0-9a-f]{40}([._-][A-Za-z0-9._-]+)?$/.test(release)) return manifestPath;
  if (rest.join('/') !== 'content-review/pending/manifest.json') return manifestPath;
  // The live root is a Linux path on EC2; join it the same way on every host.
  return (String(liveRoot).startsWith('/') ? path.posix : path).join(liveRoot, ...rest);
}

function artifactPath(manifestPath, video, target) {
  const dir = path.dirname(manifestPath);
  const file =
    target === 'thumbnail'
      ? video.thumbnail_file || `${video.id}_thumb.jpg`
      : video.video_file || `${video.id}.mp4`;
  return path.join(dir, file);
}

function rejectionRevision(video = {}, target = 'video') {
  const stamp =
    target === 'thumbnail'
      ? video.thumbnail_rejected_at || video.rejected_at
      : video.video_rejected_at || video.rejected_at;
  return String(stamp || '').trim() || null;
}

function rejectionNote(video = {}, target = 'video') {
  return String(
    (target === 'thumbnail' ? video.thumbnail_rejection_note : video.video_rejection_note) ||
      video.rejection_note ||
      '',
  ).trim();
}

const SKILL_ROOT = 'skills/work/video-production';

// Domain references inside the evolving video-production skill. Each rule adds
// a reference only when the video's own metadata or the owner's feedback calls for
// it, so the worker loads the relevant method instead of the whole library.
const REFERENCE_RULES = [
  {
    file: 'references/examplechannel-narrator-themes.md',
    when: ({ meta }) => /examplechannel|viral_clip|podcast|interview|narrator|short/i.test(meta),
  },
  {
    file: 'references/examplechannel-benchmark-motion.md',
    when: ({ meta }) => /examplechannel|viral_clip|benchmark|source.cut|podcast|interview/i.test(meta),
  },
  {
    // Sadie's split cold open (The owner): her kit, prompts and rules.
    file: 'references/sadie-ai-presenter.md',
    when: ({ meta }) => /sadie|split.open|take.open/i.test(meta),
  },
  {
    file: 'references/cloud-youtube-source-acquisition.md',
    when: ({ meta }) => /viral_clip|youtube|youtu\.be|clip_source|source_url/i.test(meta),
  },
  {
    file: 'references/audio.md',
    when: ({ feedback }) =>
      /\b(audio|voice|narrat|music|sound|mix|loud|quiet|volume|speech|spoken|word|glitch)/i.test(
        feedback,
      ),
  },
  {
    file: 'references/runtime-cutdown.md',
    when: ({ feedback }) =>
      /\b(too long|shorter|longer|cut|trim|pacing|pause|timing|seconds?|runtime|drag|slow)\b/i.test(
        feedback,
      ),
  },
  {
    file: 'references/presenter-reenactment.md',
    when: ({ feedback, meta }) => /\b(presenter|lip|avatar|reenact|mouth)\b/i.test(`${feedback} ${meta}`),
  },
  {
    file: 'references/owner-ai-presenter.md',
    when: ({ feedback, meta }) => /\bExampleCo\b.*\b(presenter|avatar|office)\b/i.test(`${feedback} ${meta}`),
  },
  {
    file: 'references/asset-prep.md',
    when: ({ feedback, target }) =>
      target === 'thumbnail' || /\b(logo|brand|photo|image|thumbnail|picture)\b/i.test(feedback),
  },
  { file: 'references/ExampleCo.md', when: ({ meta }) => /\bExampleCo\b/i.test(meta) },
  { file: 'references/startup.md', when: ({ meta }) => /\bstartup\b|ExampleCo/i.test(meta) },
  { file: 'references/venture.md', when: ({ meta }) => /\bventure\b/i.test(meta) },
  {
    file: 'references/monthly-finance-updates.md',
    when: ({ meta }) => /finance/i.test(meta),
  },
  {
    file: 'references/personal-vision.md',
    when: ({ meta }) => /PRIVATE_NAME|personal.vision/i.test(meta),
  },
];

function selectVideoSkills({ video = {}, target = 'video', feedback = '', repoRoot } = {}) {
  const meta = [video.id, video.title, video.channel, video.source, video.format, video.style, video.build_format]
    .filter(Boolean)
    .join(' ');
  const ctx = { meta, feedback: String(feedback || ''), target };
  const selected = [
    `${SKILL_ROOT}/SKILL.md`,
    `${SKILL_ROOT}/LEARNINGS.md`,
    ...REFERENCE_RULES.filter((rule) => rule.when(ctx)).map((rule) => `${SKILL_ROOT}/${rule.file}`),
    'skills/cards/video_approval_queue/SKILL.md',
  ];
  if (!repoRoot) return selected;
  return selected.filter((rel) => fs.existsSync(path.join(repoRoot, rel)));
}

function readTask(dir, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function writeTaskAtomic(dir, task) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${task.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

// Every spine video task (rejection regen or dashboard build) runs through
// the same runner, lease and closure machinery.
function isVideoRegenTask(task) {
  return task?.meta?.capability === CAPABILITY || task?.meta?.capability === BUILD_CAPABILITY;
}

function isVideoBuildTask(task) {
  return task?.meta?.capability === BUILD_CAPABILITY;
}

function listVideoRegenTasks(dir, videoId) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith('video-regen-') && name.endsWith('.json'))
    .map((name) => readTask(dir, name.slice(0, -5)))
    .filter(
      (task) =>
        task?.meta?.capability === CAPABILITY && (!videoId || task.meta.videoId === videoId),
    );
}

function findOpenVideoRegenTask({ dir = tasksDir(), videoId } = {}) {
  return (
    listVideoRegenTasks(dir, videoId).find((task) => OPEN_STATUSES.has(String(task.status))) ||
    null
  );
}

/**
 * Write the one spine Task for a rejection round. Idempotent by id; a newer
 * round cancels older open rounds for the same video so two workers never
 * edit the same film.
 */
function createVideoRegenTask({
  dir = tasksDir(),
  video,
  target = 'video',
  manifestPath,
  source = 'briefing_dashboard',
  nowMs = Date.now(),
  // Durable proof the owner asked for this rebuild, required for a held row.
  ownerRequest = null,
} = {}) {
  if (!video || !video.id) throw new Error('createVideoRegenTask needs a manifest video');
  if (!manifestPath) throw new Error('createVideoRegenTask needs the live manifest path');
  manifestPath = liveManifestPath(manifestPath);
  const revision = rejectionRevision(video, target);
  if (!revision) throw new Error(`video ${video.id} has no ${target} rejection revision`);
  const id = videoRegenTaskId(video.id, target, revision);
  const existing = readTask(dir, id);
  if (existing) return { task: existing, created: false };

  const ts = new Date(nowMs).toISOString();
  for (const older of listVideoRegenTasks(dir, video.id)) {
    if (!OPEN_STATUSES.has(String(older.status))) continue;
    const cancelled = {
      ...older,
      status: 'cancelled',
      updatedAt: ts,
      completedAt: ts,
      resultSummary: 'Superseded by newer feedback on the same video.',
      history: [
        ...(older.history || []),
        { status: 'cancelled', ts, note: `superseded by ${id}` },
      ],
    };
    delete cancelled.lease;
    writeTaskAtomic(dir, cancelled);
  }

  const feedback = rejectionNote(video, target);
  const baselineSha = sha256File(artifactPath(manifestPath, video, target));
  const title = `Regenerate ${target} for "${String(video.title || video.id).slice(0, 80)}"`;
  const task = {
    id,
    kind: 'action',
    origin: 'briefing',
    title,
    prompt: `${title} from the owner's feedback: ${feedback}`,
    status: 'queued',
    approved: true,
    createdAt: ts,
    updatedAt: ts,
    attempts: 0,
    source: { type: 'video-rejection', ref: `${video.id}@${revision}`, via: source },
    meta: {
      capability: CAPABILITY,
      explicitRequest: true,
      completionEvidenceType: 'artifact',
      maxAttempts: MAX_ATTEMPTS,
      attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
      videoId: video.id,
      target,
      revision,
      feedback,
      baselineSha,
      heldMissingFinal: video.status === 'held_missing_final',
      manifestPath,
      // Codex 19ded1278880 (F6): a rejected Sadie row is rebuilt as a Sadie
      // build in its own format (split open or take open, owner decision),
      // never as the benchmark-motion source cut.
      ...(video.build_format ? { buildFormat: isSadieProposal(video) ? viralClipFormatOf(video) : SOURCE_CUT } : {}),
      ...(ownerRequest ? { ownerRequest } : {}),
    },
    execution: { launches: 0 },
    history: [{ status: 'queued', ts, note: `owner ${target} rejection via ${source}` }],
  };
  writeTaskAtomic(dir, task);
  return { task, created: true };
}

function videoBuildTaskId(proposalId, revision) {
  const digest = crypto
    .createHash('sha256')
    .update(`${proposalId}\n${revision}`)
    .digest('hex')
    .slice(0, 10);
  return `video-build-${slug(proposalId).slice(0, 80)}-${digest}`;
}

/**
 * Write the one spine Task that builds an owner-approved clip proposal
 * (Approve for clip queue, or Build with feedback). Idempotent per proposal +
 * approval stamp; a re-approval with a new stamp cancels an older open build
 * for the same proposal so two sessions never produce the same short.
 */
function createVideoBuildTask({
  dir = tasksDir(),
  proposal,
  proposalPath,
  proposalDate,
  viralClipRoot,
  mode = 'approve',
  source = 'briefing_dashboard',
  nowMs = Date.now(),
} = {}) {
  if (!proposal || !proposal.id) throw new Error('createVideoBuildTask needs an approved proposal');
  if (String(proposal.status || '') !== 'approved') {
    throw new Error(`proposal ${proposal.id} is not approved`);
  }
  // owner decision: English-only channel; a proposal without a positive
  // English receipt never becomes build work.
  const language = proposalLanguageGate(proposal);
  if (!language.ok) throw new Error(`proposal ${proposal.id} refused: ${language.reason}`);
  if (!proposalPath) throw new Error('createVideoBuildTask needs the proposal file path');
  if (!viralClipRoot) throw new Error('createVideoBuildTask needs the clip runtime root');
  if (!proposal.video_theme) throw new Error(`proposal ${proposal.id} has no selected theme`);
  const revision = String(proposal.approved_at || '').trim();
  if (!revision) throw new Error(`proposal ${proposal.id} has no approval stamp`);
  const id = videoBuildTaskId(proposal.id, revision);
  const existing = readTask(dir, id);
  if (existing) return { task: existing, created: false };

  const ts = new Date(nowMs).toISOString();
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('video-build-') || !name.endsWith('.json')) continue;
      const older = readTask(dir, name.slice(0, -5));
      if (!isVideoBuildTask(older) || older.meta.proposalId !== proposal.id) continue;
      if (!OPEN_STATUSES.has(String(older.status))) continue;
      const cancelled = {
        ...older,
        status: 'cancelled',
        updatedAt: ts,
        completedAt: ts,
        resultSummary: 'Superseded by a newer approval of the same proposal.',
        history: [...(older.history || []), { status: 'cancelled', ts, note: `superseded by ${id}` }],
      };
      delete cancelled.lease;
      writeTaskAtomic(dir, cancelled);
    }
  }

  const manifestPath = liveManifestPath(path.join(viralClipRoot, 'content-review', 'pending', 'manifest.json'));
  let baselineSha = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const row = (manifest.videos || []).find((v) => v && v.id === proposal.id);
    if (row && row.video_file) baselineSha = sha256File(artifactPath(manifestPath, row, 'video'));
  } catch {}
  const directive =
    proposal.build_directive && proposal.build_directive.text ? proposal.build_directive : null;
  const segments = Array.isArray(proposal.segments) ? proposal.segments : [];
  const title = `Build approved short "${String(proposal.insight || proposal.source_title || proposal.id).slice(0, 80)}"`;
  const task = {
    id,
    kind: 'action',
    origin: source === 'owner-channel' ? 'owner-channel' : 'briefing',
    title,
    prompt: `${title} with the model-session standard${directive ? ` and the owner's directive: ${directive.text}` : ''}`,
    status: 'queued',
    approved: true,
    createdAt: ts,
    updatedAt: ts,
    attempts: 0,
    source: { type: 'video-build', ref: `${proposal.id}@${revision}`, via: source },
    meta: {
      capability: BUILD_CAPABILITY,
      explicitRequest: true,
      completionEvidenceType: 'artifact',
      maxAttempts: BUILD_MAX_ATTEMPTS,
      attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
      videoId: proposal.id,
      proposalId: proposal.id,
      proposalDate: proposalDate || '',
      proposalPath,
      viralClipRoot,
      target: 'video',
      revision,
      mode,
      theme: proposal.video_theme,
      buildFormat: viralClipFormatOf(proposal),
      longform: isLongformProposal(proposal),
      buildDirective: directive,
      feedback: directive ? directive.text : '',
      segments,
      bridges: Array.isArray(proposal.bridges) ? proposal.bridges : [],
      sourceUrl: proposal.source_url || '',
      sourceUrls: Array.isArray(proposal.source_urls) ? proposal.source_urls : [],
      ownerRequest: proposal.owner_request || null,
      approxTimestamp: proposal.approx_timestamp || '',
      baselineSha,
      manifestPath,
    },
    execution: { launches: 0 },
    history: [{ status: 'queued', ts, note: `owner ${mode} via ${source}` }],
  };
  writeTaskAtomic(dir, task);
  return { task, created: true };
}

/** True when the proposal records a build by this exact task after its request. */
function taskBuiltProposal(task, { readProposal } = {}) {
  const meta = task?.meta || {};
  let doc;
  try {
    doc = readProposal ? readProposal(meta.proposalPath) : JSON.parse(fs.readFileSync(meta.proposalPath, 'utf8'));
  } catch {
    return false;
  }
  const list = Array.isArray(doc) ? doc : (doc && (doc.proposals || doc.clips)) || [];
  const proposal = list.find((p) => p && p.id === meta.proposalId);
  if (!proposal || proposal.built_build_task_id !== task.id) return false;
  const builtMs = Date.parse(proposal.built_at || '');
  const createdMs = Date.parse(task.createdAt || '');
  return Number.isFinite(builtMs) && Number.isFinite(createdMs) && builtMs >= createdMs;
}

/**
 * The owner's dashboard approval of a queued video, from the append-only briefing
 * action log. Only an approval recorded after the build request counts, so an
 * approval of an earlier version never closes a newer build.
 */
function findOwnerVideoApproval(videoId, sinceIso, { readActions, readXPosts } = {}) {
  const sinceMs = Date.parse(sinceIso || '');
  // Fail closed: without an id and a request time, no approval can be bound.
  if (!videoId || !Number.isFinite(sinceMs)) return null;
  const read = (reader, file) => {
    try {
      return reader ? String(reader() || '') : fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };
  const rows = (text) =>
    text
      .split('\n')
      .filter((line) => line.includes(videoId))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  const after = (iso) => {
    const ms = Date.parse(iso || '');
    return Number.isFinite(ms) && ms >= sinceMs;
  };
  const approvals = rows(read(readActions, path.join(dataDir(), 'agent', 'briefing-actions.jsonl'))).filter(
    (row) => row.kind === 'approve-video' && row.itemRef === videoId && after(row.ts),
  );
  if (approvals.length) return approvals[approvals.length - 1];
  // Approval also posts the video to X; a posted receipt is the same decision.
  const posts = rows(read(readXPosts, path.join(dataDir(), 'x', 'approved-video-posts.jsonl'))).filter(
    (row) => row.videoId === videoId && row.status === 'posted' && after(row.at),
  );
  return posts.length ? { kind: 'x-posted', itemRef: videoId, ts: posts[0].at } : null;
}

// The source receipts `--promote` validated and stamped on the queue row
// (paths relative to the clip runtime root), as the effects receipt's
// sanctioned list for source-footage accents.
function rowSourceAcquisitions(video, root) {
  const rels = Array.isArray(video.source_acquisition_receipts) ? video.source_acquisition_receipts : [];
  return rels
    .map((rel) => {
      const abs = path.resolve(root || '.', String(rel));
      let receipt = null;
      try {
        receipt = JSON.parse(fs.readFileSync(abs, 'utf8'));
      } catch {
        return null;
      }
      if (!receipt || receipt.status !== 'succeeded') return null;
      return { path: abs, sha256: String((receipt.media && receipt.media.sha256) || '').toLowerCase() };
    })
    .filter(Boolean);
}

/**
 * Build acceptance: the live manifest row for this proposal is back in
 * pending_approval with new bytes queued AFTER this task was created, carries
 * the gates every source-cut short needs (authentic_source_only, the selected
 * theme, the owner directive when one was given, a recorded build standard),
 * is not tombstoned, and passes the same SHA-bound text-fit gate the approve
 * button uses.
 */
function evaluateVideoBuildOutcome(
  task,
  { readManifest, hashFile = sha256File, textFitGate, effectsGate, isDeleted, readActions, readXPosts, readProposal } = {},
) {
  const meta = task?.meta || {};
  const deleted =
    isDeleted || ((row) => require('./video-delete-state.js').isVideoDeleted(row));
  if (deleted({ id: meta.videoId })) return { state: 'superseded', reason: 'The owner deleted the video' };
  let manifest;
  try {
    manifest = readManifest
      ? readManifest(liveManifestPath(meta.manifestPath))
      : JSON.parse(fs.readFileSync(liveManifestPath(meta.manifestPath), 'utf8'));
  } catch (err) {
    return { state: 'open', reason: `manifest unreadable: ${err.message}` };
  }
  const video = (manifest?.videos || []).find((v) => v && v.id === meta.videoId);
  if (!video) {
    // A lost manifest row must not relaunch a build of work the owner already
    // approved (2026-09-26: a stale manifest overwrite dropped the posted row
    // of vtc-0a3d597cb26c and the spine started a second production).
    // Only a build this task already produced can have lost its row. The
    // proposal's built_* receipt proves that; without it nothing was built.
    if (!taskBuiltProposal(task, { readProposal })) {
      return { state: 'open', reason: 'built clip not in the approval manifest yet' };
    }
    const approval = findOwnerVideoApproval(meta.videoId, task.createdAt, { readActions, readXPosts });
    if (!approval) {
      return {
        state: 'superseded',
        reason: 'this build already landed but its approval-queue row was lost; not rebuilding',
      };
    }
    return {
      state: 'complete',
      ownerDecided: true,
      reason: `The owner already approved the video at ${approval.ts}; its manifest row is missing`,
      evidence: { type: 'artifact', ref: `video:${meta.videoId}:video@approved:${approval.ts}` },
    };
  }
  if (String(video.status) === 'deleted') {
    return { state: 'superseded', reason: 'The owner deleted the video' };
  }
  if (OWNER_DECIDED_STATUSES.has(String(video.status))) {
    return {
      state: 'complete',
      ownerDecided: true,
      reason: `The owner already moved the video to ${video.status}`,
      evidence: { type: 'artifact', ref: `video:${meta.videoId}:video@status:${video.status}` },
    };
  }
  if (String(video.status) !== 'pending_approval') {
    return { state: 'open', reason: `status is ${video.status}, not pending_approval` };
  }
  const builtMs = Date.parse(video.synced_at || '');
  const createdMs = Date.parse(task.createdAt || '');
  if (Number.isFinite(createdMs) && !(Number.isFinite(builtMs) && builtMs >= createdMs)) {
    return { state: 'open', reason: 'queue row predates this build request' };
  }
  // owner decision: a Sadie split-open build completes only with a labeled
  // synthetic-media row. The labeled deterministic fallback renders the usual
  // source cut whatever format was selected, so its row is checked as one.
  const sadie = sadieBuildExpected(meta, video);
  if (sadie) {
    const problem = sadieRowProblem(video, meta.buildFormat);
    if (problem) return { state: 'open', reason: problem };
  } else if (isSadieProposal(video)) {
    return { state: 'open', reason: `row is a Sadie row (${video.build_format}), this build is the usual source cut` };
  } else if (video.authentic_source_only !== true) {
    return { state: 'open', reason: 'row lost authentic_source_only' };
  }
  if (meta.theme && video.video_theme !== meta.theme) {
    return { state: 'open', reason: `theme is ${video.video_theme}, the owner selected ${meta.theme}` };
  }
  if (meta.buildDirective && meta.buildDirective.text) {
    const got = video.build_directive && video.build_directive.text;
    if (got !== meta.buildDirective.text) {
      return { state: 'open', reason: "The owner's build directive is not bound to the queued clip" };
    }
  }
  if (!['model-session', 'deterministic-fallback'].includes(String(video.build_standard || ''))) {
    return { state: 'open', reason: 'queued clip does not record its build standard' };
  }
  const videoPath = artifactPath(liveManifestPath(meta.manifestPath), video, 'video');
  const sha = hashFile(videoPath);
  if (!sha) return { state: 'open', reason: 'built artifact missing' };
  if (meta.baselineSha && sha === meta.baselineSha) {
    return { state: 'open', reason: 'artifact bytes unchanged from before the build' };
  }
  let gate;
  try {
    const verify =
      textFitGate || require('./video-text-fit-receipt.js').verifyVideoTextFitReleaseGate;
    gate = verify({ videoPath, manifestEntry: video });
  } catch (err) {
    gate = { ok: false, reason: `check threw: ${err.message}` };
  }
  if (!gate || gate.ok !== true) {
    return {
      state: 'open',
      reason: `text-fit release gate: ${(gate && (gate.reason || gate.code)) || 'not verified'}`,
    };
  }
  // owner decision v4 package: a model-session clip completes only with the
  // SHA-bound effects receipt beside its bytes. The labeled fallback renders
  // none and records that on the row, so it is exempt here. A Sadie
  // split-open build (The owner) renders no accents, cutaways or added
  // sound effects and carries no effects receipt; promote already held it to
  // the frame, length, Kling-line and text-fit gates.
  if (!sadie && String(video.build_standard) === 'model-session') {
    let effects;
    try {
      const verifyEffects = effectsGate || require('./clip-effects-receipt.js').verifyClipEffectsReceipt;
      effects = verifyEffects({
        videoPath,
        manifestEntry: video,
        themeVersion: video.video_theme_version || undefined,
        sourceAcquisitions: rowSourceAcquisitions(video, meta.viralClipRoot),
        // A long-form highlights row (format/youtube_format "longform") was
        // promoted against the long-form receipt profile; verifying it as a
        // Short refuses every long-form build (2026-10-24 vtc-ee0589871aba).
        format: require('./longform-video.js').isLongformProposal(video) ? 'longform' : 'short',
      });
    } catch (err) {
      effects = { ok: false, reason: `check threw: ${err.message}` };
    }
    if (!effects || effects.ok !== true) {
      return { state: 'open', reason: `effects receipt: ${(effects && effects.reason) || 'not verified'}` };
    }
  }
  return {
    state: 'complete',
    buildStandard: video.build_standard,
    reason: `built clip is in pending approval (${video.build_standard})`,
    evidence: { type: 'artifact', ref: `video:${meta.videoId}:video@sha256:${sha}` },
  };
}

/**
 * The acceptance check. `complete` only when the live manifest shows this
 * exact rejection round resolved with new bytes back in the owner's approval queue.
 */
function evaluateVideoRegenOutcome(task, opts = {}) {
  if (isVideoBuildTask(task)) return evaluateVideoBuildOutcome(task, opts);
  const { readManifest, hashFile = sha256File, textFitGate, isDeleted } = opts;
  const meta = task?.meta || {};
  const manifestPath = liveManifestPath(meta.manifestPath);
  // Deletion is terminal by identity (tombstone ledger), not only by the
  // replaceable manifest status: a resurrected row of a deleted video must
  // settle, never rebuild (2026-09-26: five deleted rows were held as
  // missing finals and dispatched as regen tasks).
  const deleted =
    isDeleted || ((row) => require('./video-delete-state.js').isVideoDeleted(row));
  if (deleted({ id: meta.videoId })) return { state: 'superseded', reason: 'The owner deleted the video' };
  // Publication is durable by identity too: a manifest row overwritten back to
  // pending_approval never turns published work into an accepted rebuild.
  const published =
    opts.isPublished ||
    ((row) => Boolean(require('./video-delete-state.js').findPublishedVideoRecord(row)));
  // Sep 29 2026: a held missing-final row is a machine finding. Its task runs
  // only with the owner's recorded rebuild request; legacy machine-created tasks
  // settle here before any model session (Codex deploy review, high).
  if (isHeldMissingFinalTask(meta) && !ownerRequestedRebuild(meta)) {
    return {
      state: 'superseded',
      reason: 'awaiting owner decision: the final file is missing and the owner has not asked for a rebuild',
    };
  }
  if (published({ id: meta.videoId })) {
    return {
      state: 'complete',
      ownerDecided: true,
      reason: 'the video is already published',
      evidence: { type: 'artifact', ref: `video:${meta.videoId}:${meta.target}@status:posted` },
    };
  }
  let manifest;
  try {
    manifest = readManifest
      ? readManifest(manifestPath)
      : JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    // Without the row its channel cannot be checked, so it might belong to a
    // retired channel: never launch a rebuild on this state. A manifest can
    // become readable again, so the task waits rather than blocks.
    return {
      state: 'open',
      channelUnresolved: true,
      transient: true,
      reason: `manifest unreadable: ${err.message}`,
    };
  }
  const video = (manifest?.videos || []).find((v) => v && v.id === meta.videoId);
  if (!video) return { state: 'superseded', reason: 'video no longer in the approval manifest' };
  if (String(video.status) === 'deleted') {
    return { state: 'superseded', reason: 'The owner deleted the video' };
  }
  const retired =
    opts.isRetiredChannel ||
    ((row) => require('./video-delete-state.js').findRetiredVideoChannel(row));
  const retiredChannel = retired(video);
  if (retiredChannel && retiredChannel.unresolved) {
    return {
      state: 'open',
      channelUnresolved: true,
      transient: Boolean(retiredChannel.transient),
      reason: `channel unresolved, not accepting a rebuild: ${retiredChannel.reason}`,
    };
  }
  if (retiredChannel) {
    return {
      state: 'superseded',
      reason: `The owner retired the ${retiredChannel.channel} channel on ${retiredChannel.retiredOn}`,
    };
  }
  const liveRevision = rejectionRevision(video, meta.target);
  const flag = meta.target === 'thumbnail' ? 'thumbnail_needs_regen' : 'video_needs_regen';
  if (liveRevision && liveRevision !== meta.revision && video[flag] === true) {
    return { state: 'superseded', reason: 'newer feedback replaced this round' };
  }
  if (video[flag] === true) return { state: 'open', reason: 'rejection still open' };
  // The owner already acted on the revised video: the work is done and the card
  // no longer needs this task to close it.
  if (OWNER_DECIDED_STATUSES.has(String(video.status))) {
    return {
      state: 'complete',
      ownerDecided: true,
      reason: `The owner already moved the video to ${video.status}`,
      evidence: { type: 'artifact', ref: `video:${meta.videoId}:${meta.target}@status:${video.status}` },
    };
  }
  if (String(video.status) !== 'pending_approval') {
    return { state: 'open', reason: `status is ${video.status}, not pending_approval` };
  }
  const sha = hashFile(artifactPath(manifestPath, video, meta.target));
  if (!sha) return { state: 'open', reason: 'replacement artifact missing' };
  if (meta.baselineSha && sha === meta.baselineSha) {
    return { state: 'open', reason: 'artifact bytes unchanged from the rejected version' };
  }
  // The dashboard refuses approval without a text-fit receipt bound to these
  // exact bytes (video-generation invariant 10). "Done" uses the same gate, so
  // the spine never closes work the approve button would reject (2026-09-22:
  // a promoted video kept the previous file's receipt and the card stayed red).
  if (meta.target !== 'thumbnail') {
    let gate;
    try {
      const verify =
        textFitGate || require('./video-text-fit-receipt.js').verifyVideoTextFitReleaseGate;
      gate = verify({ videoPath: artifactPath(manifestPath, video, meta.target), manifestEntry: video });
    } catch (err) {
      gate = { ok: false, reason: `check threw: ${err.message}` };
    }
    if (!gate || gate.ok !== true) {
      return {
        state: 'open',
        reason: `text-fit release gate: ${(gate && (gate.reason || gate.code)) || 'not verified'}`,
      };
    }
  }
  // Codex 19ded1278880 (F6): a rebuilt Sadie row keeps its format and its
  // synthetic-media disclosure, or the round stays open.
  if (meta.target !== 'thumbnail' && sadieBuildExpected(meta, video)) {
    const problem = sadieRowProblem(video, meta.buildFormat);
    if (problem) return { state: 'open', reason: problem };
  }
  return {
    state: 'complete',
    reason: 'new artifact is back in pending approval',
    evidence: { type: 'artifact', ref: `video:${meta.videoId}:${meta.target}@sha256:${sha}` },
  };
}

/**
 * The owner-visible half of "done" (The owner): after the video is back
 * in pending approval, refresh ONLY the Video Approval Queue card through the
 * standard single-card path and prove the regenerated live verdict is clean.
 * The live verdict carries no per-video list, so "clean" is the only honest
 * proof; a card held red by something else retries, then blocks with that
 * reason instead of claiming a green the owner cannot see. The refresh runs
 * synchronously (up to CARD_CLOSURE_TIMEOUT_MS); the caller holds the lease.
 */
function runVideoCardClosure(task, deps = {}) {
  const { spawnSync } = require('child_process');
  const spawnSyncFn = deps.spawnSyncFn || spawnSync;
  const repoRoot = deps.repoRoot || path.resolve(__dirname, '..', '..');
  const now = deps.now || Date.now;
  const readBoard =
    deps.readBoard || (() => null);
  const findCard = () => {
    try {
      const board = readBoard();
      return ((board && board.artifact && board.artifact.cards) || []).find(
        (row) => row && (row.id === VIDEO_CARD_ID || row.cardId === VIDEO_CARD_ID),
      );
    } catch {
      return null;
    }
  };
  const before = findCard();
  const startedAt = now();
  const run = spawnSyncFn(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'refresh-card.js'), VIDEO_CARD_ID, '--publish', '--verify'],
    {
      cwd: repoRoot,
      env: scrubInheritedControllerEnv(deps.env || process.env),
      encoding: 'utf8',
      timeout: deps.timeoutMs || CARD_CLOSURE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const card = findCard();
  const asOfMs = Date.parse((card && card.asOf) || '');
  const refreshed = Boolean(
    card &&
      ((card.generationId && card.generationId !== (before && before.generationId)) ||
        (Number.isFinite(asOfMs) && asOfMs >= startedAt)),
  );
  const clean = Boolean(card && card.status === 'clean');
  const result = {
    // refresh-card exits nonzero when OTHER cards are red (2026-09-23: system
    // health, self-heal, recorder). This unit's proof is its own regenerated,
    // clean verdict; a crash or timeout leaves the card unrefreshed and fails.
    ok: refreshed && clean,
    exitCode: run.status,
    cardStatus: card ? card.status : null,
    cardDefects: card ? card.defectKinds || [] : [],
    cardAsOf: card ? card.asOf : null,
    refreshed,
    videoId: String(task?.meta?.videoId || ''),
    release: deps.release || currentReleaseRoot(),
    checkedAt: new Date(now()).toISOString(),
  };
  if (!result.ok) {
    result.reason =
      !card
          ? 'card missing from the live board verdict'
          : !refreshed
            ? `live card verdict was not refreshed after the video completed (refresh exit ${run.status}${run.error ? `: ${run.error.message}` : ''})`
            : `live card is ${card.status}${(card.defectKinds || []).length ? ` (${card.defectKinds.join(', ')})` : ''}`;
    result.tail = String(run.stderr || run.stdout || '').slice(-1500);
  }
  return result;
}

// The PM2 spine worker can inherit a card-controller run's environment
// (scope token, lease token, work unit). Passing that to a child makes the
// single-card refresh act as the other run and the mutation fence refuses it
// (2026-09-22: "scope-token-not-current"). Spine video work owns no
// controller lease, so children start without those keys.
function scrubInheritedControllerEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (/^(CARD_CONTROLLER_|BRIEFING_CONTROLLER_)/.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

function currentReleaseRoot() {
  try {
    return fs.realpathSync(path.resolve(__dirname, '..', '..'));
  } catch {
    return path.resolve(__dirname, '..', '..');
  }
}

// A task blocked only by its card step gets one fresh card-step budget per
// deployed release, so a shipped fix retries it without a new owner action
// and a broken release cannot hot-loop it.
function cardClosureRetryableOnRelease(task, release = currentReleaseRoot()) {
  const last = task?.execution?.lastCardClosure;
  return Boolean(
    isVideoRegenTask(task) &&
      String(task.status) === 'blocked' &&
      last &&
      !task.execution.cardClosure &&
      last.release !== release,
  );
}

function needsCardClosure(task) {
  return isVideoRegenTask(task) && !task?.execution?.cardClosure?.verifiedAt;
}

// A Sadie build (or the rebuild of a Sadie row) completes only with a labeled
// synthetic-media row; the labeled deterministic fallback renders the usual
// source cut whatever format was selected, so its row is checked as one.
function sadieBuildExpected(meta = {}, video = {}) {
  return SADIE_FORMATS.includes(meta.buildFormat) && String(video.build_standard) !== 'deterministic-fallback';
}

// The row must carry the exact Sadie format this build was asked for (The owner
// 2026-10-28: a split open and a take open are different Shorts).
function sadieRowProblem(video = {}, expectedFormat = SADIE_SPLIT_OPEN) {
  if (!isSadieProposal(video) || viralClipFormatOf(video) !== expectedFormat) {
    return `build_format is ${video.build_format || 'unset'}, this build is ${expectedFormat}`;
  }
  if (video.synthetic_media !== true || video.synthetic_media_label !== SADIE_SYNTHETIC_LABEL) {
    return 'Sadie row lost synthetic_media or its Kling label';
  }
  if (video.authentic_source_only !== false) {
    return 'Sadie row must record authentic_source_only false';
  }
  return null;
}

// owner decision (beta A/B shipped the same day): the Sadie split cold open.
// owner decision: the Sadie take open (the claim right out of the gate, then
// her take, at most 12 s on camera, no Sadie close) and music under every
// Sadie build. The benchmark-motion package and the v5 effects receipt do not
// apply; Sadie and the claim card are the open and the authentic source
// segments are the proof.
function sadieBuildPromptLines(meta) {
  const kit = 's3://your-account-secondbrain-backups/video-productions/_characters/sadie/';
  const takeOpen = meta.buildFormat === SADIE_TAKE_OPEN;
  const kitRules = `Read ${SADIE_REFERENCE} first: Sadie is rebuilt only from her private kit (approved footage, voice and plates), never from a fresh text prompt; nothing is drawn over her picture and Kling's corner mark stays. The kit's backup is ${kit}, but the EC2 instance role can neither list nor read that bucket, so the operator stages the kit on this host at ${SADIE_KIT_DIR}; copy it into the production directory (cp -r ${SADIE_KIT_DIR}/. <production dir>/kit/) and run sha256sum -c MANIFEST.sha256 inside kit/ before any frame renders. If the staged kit is missing or the manifest fails, stop and report it: never rebuild Sadie from a text prompt and never download a model, font or tool for her.`;
  return [
    takeOpen
      ? `This is a Sadie take open (build_format ${SADIE_TAKE_OPEN}, owner decision): Sadie says the claim right out of the gate, then her own take on it (why it matters, why it is BS, why it is not the full story, what is missing, what comes next, or a question or debate she cannot settle), all on camera in at most ${SADIE_TAKE_OPEN_MAX_SECONDS} seconds; then the source segments run full frame to the end and the source's last line closes the Short. There is no Sadie close: leave the timeline's "close" null. ${kitRules}`
      : `This is a Sadie split cold open (build_format ${SADIE_SPLIT_OPEN}). ${kitRules}`,
    `Render with ${SADIE_TEMPLATE_DIR}/ (compose.cjs drives the timeline JSON, whose "format" names the build format; README.md lists the EC2 dependencies). Frame one is the claim card with the concrete number and its consequence over Sadie's plate; ${
      takeOpen
        ? `Sadie speaks the claim and her take for at most ${SADIE_TAKE_OPEN_MAX_SECONDS} seconds over the muted source preview, then the source segments play full frame with the attribution overlay (the only Examplechannel branding, never over Sadie) to the end and the source's last line closes the Short`
        : `Sadie speaks the claim for at most about ${SADIE_SPLIT_OPEN_MAX_SECONDS} seconds over the muted source preview; the source segments play full frame with the attribution overlay (the only Examplechannel branding, never over Sadie) and carry the proof; Sadie closes in at most ${SADIE_SPLIT_CLOSE_MAX_SECONDS} seconds on a take or a question`
    }. The whole Short is 1080x1920 and runs at most ${SHORT_MAX_SECONDS} seconds.`,
    `Sadie's lines come from her ElevenLabs voice (resolveCredential('elevenlabs', 'apiKey') in scripts/lib/credential-broker.js; the voice id is in her reference) and sync.so lip-sync by API with the SSM key secondbrain.SYNC_SO_API_KEY (${SADIE_TEMPLATE_DIR}/syncso.sh). Every Sadie build carries music (The owner): pick the approved registry track whose mood fits the story (config/approved-music.json, no vocals under her voice; mystery_ambient for a mysterious discovery), copy its master from content-review/pending/_music_approved/ under the clip runtime root into the production directory, name it in the timeline's "music" field ({ src, gain }, default gain 0.075, well under her voice), and the template mixes it under the whole Short before loudnorm and writes bed.wav and music_bed.wav into capture/build-<id>/ for the stems export. Keep the source audio under the segments. Set SADIE_CHROME_PATH only when the bundled Playwright Chromium is unavailable.`,
    `Write no effects receipt: a Sadie build has no image accents, flip-over cutaways or added sound effects. The text-fit receipt is still required (claim card and attribution overlay, ${SADIE_TEMPLATE_DIR}/textfit-receipt.cjs). The YouTube description must end with the exact line "${SADIE_SYNTHETIC_LABEL}" and promote refuses it otherwise; the queued row is synthetic media and the uploader declares it. Builds are propose-only: the owner approves every post.`,
  ];
}

function buildVideoBuildPrompt(task, { skills = [], attempt = 1 } = {}) {
  const meta = task.meta || {};
  const sadie = SADIE_FORMATS.includes(meta.buildFormat);
  const takeOpen = meta.buildFormat === SADIE_TAKE_OPEN;
  const minutes = Math.round((meta.attemptTimeoutMs || ATTEMPT_TIMEOUT_MS) / 60000);
  const directive = meta.buildDirective && meta.buildDirective.text;
  const how = meta.mode === 'build-with-feedback' ? 'Build with feedback' : 'Approve for clip queue';
  const ownerRequest = meta.ownerRequest && meta.ownerRequest.text ? meta.ownerRequest : null;
  return [
    `# Spine task ${task.id}: build the approved short ${meta.proposalId}`,
    '',
    ownerRequest
      ? `The owner requested this short directly; the request text is the approved brief and the required directive below. This is attempt ${attempt} of ${meta.maxAttempts || BUILD_MAX_ATTEMPTS}, bounded at ${minutes} minutes.`
      : `The owner approved this clip proposal from the briefing dashboard (${how}). This is attempt ${attempt} of ${meta.maxAttempts || BUILD_MAX_ATTEMPTS}, bounded at ${minutes} minutes.`,
    ...(ownerRequest
      ? [
          "No scanner picked these sources. Research the authentic primary sources yourself (official posts, event replays, original interviews), treat the owner's factual leads as leads to verify, and label any quote or footage with its real date and context. Before acquiring each source, add its URL to the proposal's source_urls array (and set source_url to the first) so promotion can bind its receipt. If a required moment cannot be sourced authentically, build what is verified and state exactly what is missing in the summary; never invent footage, audio or quotes.",
          ...(ownerRequest.notes ? [`Research notes from the request: ${JSON.stringify(ownerRequest.notes)}`] : []),
        ]
      : []),
    'Produce it to the ONE standard the owner approved on 2026-09-23: the video-production skill plus the benchmark-motion method, exactly as the approved reference short was made. The deterministic ffmpeg composite in scripts/build-viral-clip.js is NOT this standard; do not run it as the build. The spine runs it only as a labeled fallback if this session fails.',
    '',
    `Proposal file: ${meta.proposalPath} (id ${meta.proposalId}, date ${meta.proposalDate}). Read the whole proposal first.`,
    `Selected theme: ${meta.theme}`,
    `Build format: ${meta.buildFormat || 'source-cut'}${sadie ? (takeOpen ? ' (Sadie take open, owner decision: the claim right out of the gate, then her take, at most 12 s on camera, no Sadie close)' : ' (Sadie split cold open, owner decision)') : meta.longform ? ' (Moonshots long-form highlights, owner decision: 1920x1080 landscape, 150 to 210 s, claim on frame one, close on a take or a question; never a Short)' : ' (the usual source cut: claim on frame one, under 45 s, close on a take or a question)'}.`,
    `Source: ${meta.sourceUrl || (ownerRequest ? 'none yet; research it' : 'see proposal')}${meta.approxTimestamp ? ` (${meta.approxTimestamp})` : ''}`,
    ...(Array.isArray(meta.segments) && meta.segments.length
      ? [
          `Woven segments (complete sentences, in order): ${JSON.stringify(meta.segments)}`,
          `Bridge lines: ${JSON.stringify(meta.bridges || [])}`,
        ]
      : []),
    ...(directive
      ? [
          `REQUIRED owner build directive (The owner's words; honor it and make it verifiable in the result): ${JSON.stringify(directive)}`,
        ]
      : []),
    ...(Array.isArray(meta.ownerFollowUps) && meta.ownerFollowUps.length
      ? [
          `The owner's later instructions on this build (when one conflicts with the directive above, the later instruction wins): ${JSON.stringify(meta.ownerFollowUps)}`,
        ]
      : []),
    ...(task.execution?.lastAttemptEnd
      ? [`Previous attempt ended: ${task.execution.lastAttemptEnd}. Fix that exact gap.`]
      : []),
    `Clip runtime root: ${meta.viralClipRoot} (proposal, approval queue and source cache live there; this checkout is source only).`,
    '',
    '## Skills to use (read these first, in order)',
    ...skills.map((rel) => `- ${rel}`),
    '',
    'Follow the video-production skill exactly: complete its LEARNINGS.md preflight (final ten entries plus file SHA-256) before any media action. Acquire the authentic source through the EC2 source boundary in scripts/build-viral-clip.js (downloadRange: residential proxy plus PoToken, receipt written); never use stock or decorative B-roll (authentic_source_only).',
    ...(sadie
      ? sadieBuildPromptLines(meta)
      : [
        'Render in an isolated production directory under the durable data path of the clip runtime root (data/video-production/<id>-<date>; the root itself is a release symlink that a deploy can swap mid-render) with skills/work/video-production/templates/benchmark-motion/{film.html,produce.cjs} (Playwright frame-addressed render with the same-invocation SHA-bound text-fit receipt). Keep the locked package: no header text at the top (pure video clip, owner decision), 90 px logo and halo, approved music scope (but add no music bed when the source audio already carries its own music, so two songs never play at once, owner decision), water-wind cues, a few 0.7 s image accents on the fun, funny or happy beats that accentuate the message and never fear or pain, a few tasteful flip-over cutaway screens that return to the source, on a claim beat that names a physical thing or a concrete figure, one 0.7 to 1.5 s cutaway to a real shot of that exact thing (source_footage from the acquired source when it is on screen there, else a lit 3D render from templates/accent-3d or a DOM-rendered figure card with the real number; never a Pexels or stock stand-in for the subject; skip it when neither exists, and on a feedback rebuild add it only when the note asks; narrator themes item 10a), a couple of subtle sound effects, no CTA ending. Accent and cutaway pictures are high definition and visually beautiful, never hand-drawn flat shapes: fetch real photography or footage with `node scripts/fetch-accent-media.js --query "<concrete subject>" --out <production dir>/source/accents [--kind video]` (Pexels, free license), or design a lit 3D render with skills/work/video-production/templates/accent-3d (read its README art direction, start from scenes/rocket.js, write <production dir>/scenes/<beat>.js, run `node skills/work/video-production/templates/accent-3d/render.js --scene-file <that file> --out <production dir>/source/accents`). A designed render must reach the bar of the Collatz film: lit solid geometry, real materials, shadows, depth, a moving camera and a full-frame environment, never a lone icon on an empty field. Show the picture full-bleed with a gentle push, a grade matched to the clip and a soft light bloom, and never draw SVG shapes, clip art, icons or emoji as an accent (owner decision: "a dumb rocket that a 10 year old could have drawn with paint"; later: "you can draw stuff, just not lame"). Keep the beat choice and timing exactly as before.',
        'Before promoting, write `<final.mp4>.effects.json` beside the final video: schema clip-effects-receipt@1, video_sha256 of the exact final bytes, theme_version (the current VIRAL_CLIP_THEME_VERSION), clip_seconds, and the accents (about 0.7 s each; mood fun, funny, happy, message or good-news; the beat, the image, and its media block from fetch-accent-media.js, or for a 3D render `{kind: designed, file, sha256, render_receipt}` from render.js), cutaways (screen, returns_to_source true, media block; a DOM-rendered chart or headline names a PNG still of that rendered screen; source footage names its source_acquisition receipt and start_seconds) and sound_effects (name, bound_to accent, cutaway or transition) you actually rendered, each with at_seconds and duration_seconds. Promotion refuses a clip without a passing receipt: it checks each picture against its Pexels provenance sidecar or acquisition receipt and matches it against the decoded final frame at its cue, so a drawn shape or an unused picture fails. Listing an effect you did not render is fabrication.',
        ]),
    `Before promoting, save the audio stems so a later music-level note never needs a re-render (The owner): SECONDBRAIN_ROOT=${meta.viralClipRoot} node scripts/video-audio-remix.js --export --id ${meta.proposalId} --date ${meta.proposalDate} --video <final.mp4> --bed <voice plus sound effects, before final loudness normalization, wav> --music-bed <the processed music at gain 1, wav> --thumbnail <thumb.jpg> --music <track file> --music-gain <gain> --loudnorm-i <I> --loudnorm-tp <TP> --loudnorm-lra <LRA> (the final loudnorm targets your mix used).`,
    `Promote only through the sanctioned path: SECONDBRAIN_ROOT=${meta.viralClipRoot} node scripts/build-viral-clip.js --promote --id ${meta.proposalId} --date ${meta.proposalDate} --video <final.mp4> --thumbnail <thumb.jpg> --source-receipts <only the succeeded data/viral-clip-builds/<id>/*.source-acquisition.json receipts your own downloadRange calls wrote, comma-separated> --music <approved track file> --music-gain <gain>${sadie ? ' (both required: every Sadie Short carries an approved registry track, owner decision)' : ' (omit both when you added no music)'}. It copies the exact bytes with their text-fit receipt, applies the release gates and records this model session as the build standard. Do not approve, upload or post.`,
    'If the automation itself blocks the result, fix and test it in an isolated worktree of this source checkout, land it with scripts/land.js and deploy through the sanctioned release path, then finish the video.',
    'After the result, append one dated learning to the video-production LEARNINGS.md per the skill learning loop.',
    '',
    `The spine verifies the outcome from the live manifest when you exit: the row for this proposal in pending_approval, queued after this task began, ${
      sadie
        ? `build_format ${meta.buildFormat} with synthetic_media true, its Kling label and authentic_source_only false`
        : 'authentic_source_only'
    }, the selected theme, the directive bound when given, a recorded build standard, a passing text-fit release receipt bound to those exact bytes${
      sadie
        ? ''
        : ', and a passing v5 effects receipt (`<final.mp4>.effects.json`, schema clip-effects-receipt@1, with an HD media block per accent and cutaway) bound to the same bytes'
    }. It then refreshes the Video Approval Queue card and requires it clean. Anything else is a failed attempt.`,
    'End with a short executive summary and one `TLDR:` line.',
  ].join('\n');
}

// Tasks created before heldMissingFinal was persisted still carry the fixed
// hold reason as their feedback.
function ownerRequestedRebuild(meta = {}) {
  const receipt = meta.ownerRequest;
  return Boolean(receipt && receipt.requestedBy === 'owner' && String(receipt.via || '').trim() && String(receipt.at || '').trim());
}

function isHeldMissingFinalTask(meta = {}) {
  if (typeof meta.heldMissingFinal === 'boolean') return meta.heldMissingFinal;
  return /final video file remained missing beyond the repair grace window/i.test(String(meta.feedback || ''));
}

function buildVideoRegenPrompt(task, { skills = [], attempt = 1, liveRoot = '/opt/secondbrain' } = {}) {
  if (isVideoBuildTask(task)) return buildVideoBuildPrompt(task, { skills, attempt });
  const meta = task.meta || {};
  const minutes = Math.round((meta.attemptTimeoutMs || ATTEMPT_TIMEOUT_MS) / 60000);
  return [
    `# Spine task ${task.id}: regenerate the ${meta.target} for video ${meta.videoId}`,
    '',
    // A held missing-final row is a machine finding, never the owner's rejection.
    isHeldMissingFinalTask(meta)
      ? `This video was held automatically because its final file stayed missing; the owner did not reject it. The owner asked for this rebuild (${(meta.ownerRequest && meta.ownerRequest.via) || 'no recorded request'}). This is attempt ${attempt} of ${meta.maxAttempts || MAX_ATTEMPTS}, bounded at ${minutes} minutes.`
      : `The owner rejected this ${meta.target} from the briefing dashboard and asked for a revised version. This is attempt ${attempt} of ${meta.maxAttempts || MAX_ATTEMPTS}, bounded at ${minutes} minutes.`,
    '',
    isHeldMissingFinalTask(meta)
      ? `Automatic hold reason (revision ${meta.revision}), not owner feedback:`
      : `The owner's feedback (rejection revision ${meta.revision}):`,
    JSON.stringify(meta.feedback || ''),
    '',
    `Rejected artifact SHA-256: ${meta.baselineSha || 'unknown'}`,
    ...(meta.target === 'video' && isHeldMissingFinalTask(meta) && !meta.baselineSha
      ? [
          'No rejected bytes exist when the row is held_missing_final. Stage the rebuilt final through production_revision_file with `baseline_sha256: null` and `baseline_missing: true`, register it on the held row, then run the exact --force --id retry so the SHA-bound promoter releases the hold.',
        ]
      : []),
    ...(task.execution?.lastAttemptEnd || task.execution?.lastCardClosure?.reason
      ? [
          `Previous attempt ended: ${task.execution.lastAttemptEnd || task.execution.lastCardClosure.reason}. Fix that exact gap; if the video already looks right, only the missing proof may need rebuilding.`,
        ]
      : []),
    `Live manifest: ${liveManifestPath(meta.manifestPath)}`,
    `Live runtime root: ${liveRoot} (queue, manifest and pending artifacts live there; this checkout is source only).`,
    '',
    '## Skills to use (read these first, in order)',
    ...skills.map((rel) => `- ${rel}`),
    '',
    'Follow the video-production skill exactly: complete its LEARNINGS.md preflight (final ten entries plus file SHA-256) before any media action, load only the listed domain references, apply its Revision Rule to diagnose which layer the feedback is about, and preserve every approved layer and the authentic-source lineage unless the feedback explicitly changes them.',
    ...(meta.target === 'video'
      ? [
          `When the feedback changes only the music level (for example "make the music 40% lower"), first run the audio-only fast path from the live runtime root: cd ${liveRoot} && node scripts/video-audio-remix.js --id ${meta.videoId} --music-scale <factor, 0.6 for 40% lower> (or --music-gain <g>)${meta.baselineSha ? ` --baseline-sha ${meta.baselineSha}` : ''}. It remixes the saved stems, keeps every video frame byte-identical (proven by the video-stream hash), re-binds the text-fit and effects receipts and promotes through the official path in minutes. Exit 3 (no_stems, stems_stale, stems_invalid, receipts_invalid, no_music) means rebuild in full; any change to picture, voice, words or timing always needs the full rebuild.`,
        ]
      : []),
    `For a generated (not authentic-source) video or a thumbnail, first try the official generic path from the live runtime root: node scripts/auto-regen-rejected-videos.js --force --id ${meta.videoId}. It is allowed for this task only. Use the full skill workflow when it fails closed or cannot address the feedback.`,
    // Codex 19ded1278880 (F6): a rejected Sadie row is rebuilt as a Sadie
    // build in its own format with her kit rules, never as the benchmark-motion cut.
    ...(SADIE_FORMATS.includes(meta.buildFormat)
      ? [
          `This video is a ${meta.buildFormat === SADIE_TAKE_OPEN ? `Sadie take open (build_format ${SADIE_TAKE_OPEN})` : `Sadie split cold open (build_format ${SADIE_SPLIT_OPEN})`}: rebuild it as one, never as the benchmark-motion source cut, and promote with node scripts/build-viral-clip.js --promote --id ${meta.videoId} --date <proposal date> --video <final.mp4> --thumbnail <thumb.jpg> --music <approved registry track file> --music-gain <gain>.`,
          ...sadieBuildPromptLines(meta),
        ]
      : [
          `For an Examplechannel source-cut short (source viral_clip), use the same one standard as a dashboard build (The owner): rebuild with the benchmark-motion method (skills/work/video-production/references/examplechannel-benchmark-motion.md) rather than the scripts/build-viral-clip.js composite, and promote with node scripts/build-viral-clip.js --promote --id ${meta.videoId} --date <proposal date> --video <final.mp4> --thumbnail <thumb.jpg>.`,
        ]),
    'Build in an isolated production directory. Keep the current MP4 until the replacement passes. Never route an authentic-source film through the generic stock renderer and never weaken a fail-closed quality gate.',
    'Every full rebuild saves its audio stems with node scripts/video-audio-remix.js --export (see its usage) before promoting, so the next music-level note takes the fast path.',
    'Finish through the official promotion path: fresh SHA-bound text-fit, directive-fidelity, rubric and thumbnail receipts for the exact final bytes, then return this item to pending_approval. Do not approve, upload or post it: when the owner\'s note says to post once fixed, the server releases the verified rebuild through the Approve path itself (owner_post_after_fix).',
    'If the automation itself blocks the result, fix and test it in an isolated worktree of this source checkout, land it with scripts/land.js and deploy through the sanctioned release path, then finish the video.',
    'After the result, append one dated learning to the video-production LEARNINGS.md per the skill learning loop.',
    '',
    'The spine verifies the outcome from the live manifest when you exit: this exact rejection cleared, status pending_approval, artifact bytes different from the rejected SHA, and a passing text-fit release receipt bound to those exact bytes (the same gate the approve button uses). It then refreshes the Video Approval Queue card and requires it clean. Anything else is a failed attempt.',
    'End with a short executive summary and one `TLDR:` line.',
  ].join('\n');
}

module.exports = {
  ownerRequestedRebuild,
  briefingNightHoldsVideoWork,
  liveManifestPath,
  findOwnerVideoApproval,
  BUILD_CAPABILITY,
  BUILD_MAX_ATTEMPTS,
  buildVideoBuildPrompt,
  createVideoBuildTask,
  evaluateVideoBuildOutcome,
  isVideoBuildTask,
  videoBuildTaskId,
  ATTEMPT_TIMEOUT_MS,
  CARD_CLOSURE_TIMEOUT_MS,
  VIDEO_CARD_ID,
  cardClosureRetryableOnRelease,
  currentReleaseRoot,
  needsCardClosure,
  scrubInheritedControllerEnv,
  runVideoCardClosure,
  CAPABILITY,
  HEARTBEAT_LEASE_MS,
  MAX_ATTEMPTS,
  MAX_RETRIES,
  artifactPath,
  buildVideoRegenPrompt,
  createVideoRegenTask,
  evaluateVideoRegenOutcome,
  findOpenVideoRegenTask,
  isVideoRegenTask,
  listVideoRegenTasks,
  rejectionRevision,
  selectVideoSkills,
  sha256File,
  tasksDir,
  videoRegenTaskId,
};
