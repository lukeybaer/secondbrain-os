// credential-broker.js
//
// One resolution path for every credential Amy uses, with lifecycle state.
//
// Built from dev-plans/pc-migration-secrets-consolidation-2026-07-19.html
// section 4 (feature-backlog id credential-broker-layer). The problem it
// closes: credentials were scattered across .env files, disk token blobs, and
// SSM with no lifecycle monitoring, so YouTube OAuth tokens expired silently,
// ElevenLabs keys hit quota without warning, and Gmail tokens failed mid-scan.
// Nothing detected a stale credential BEFORE the run that needed it.
//
// Three invariants this module exists to hold:
//
//   1. A raw secret is returned to the caller and nowhere else. Logs,
//      telemetry, the connected-accounts artifact, and anything that could
//      reach LLM context get describeCredential() metadata or redact()ed text.
//      A secret must never reach a command line either, because process args
//      are world-readable via ps.
//   2. Credential health is observed, not assumed. recordOutcome() is driven by
//      real API results, so "a string was present" never reads as connected.
//   3. Health is tracked per ACCOUNT, not per service. YouTube has three
//      channels; one healthy channel must never mask another expired one.
//
// Resolution order is env, then SSM, then disk fallback, governed per service
// by sourcePolicy. SSM is the durable source of truth, but both hosts run off
// .env and disk today, so making SSM authoritative on day one would turn a
// missing parameter into a live outage of the briefing, uploads, and the Gmail
// scan. 'legacy-env-first' is the non-breaking migration order. Because a
// populated env var means SSM is never read, env-first alone can never prove
// the cutover condition, so verifySsm() reads SSM independently and records
// ssm_readable, and promotion to 'ssm-required' is gated on that proof
// (Codex review 94ced983604c).
//
// The aws CLI is shelled out to rather than @aws-sdk/client-ssm because the SDK
// is not installed and node_modules is shared/junctioned across worktrees, so
// installing into it is forbidden (feedback_never_npm_install_against_shared_node_modules.md).
// Precedent: scripts/health-self-heal.js already shells out for the Cloudflare token.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REGION = 'us-east-1';
const DEFAULT_TTL_MS = 300000;
const STALE_STATE_MS = 24 * 60 * 60 * 1000;

// Source policy per service:
//   legacy-env-first  env, then SSM, then disk. The migration default.
//   ssm-required      SSM only. Set once verifySsm() has proven the parameter
//                     is readable on every host that needs it.
const POLICY_ENV_FIRST = 'legacy-env-first';
const POLICY_SSM_REQUIRED = 'ssm-required';

// Credential registry. `env` is the process.env key, `param` the SSM parameter.
// `{ACCOUNT}` is substituted for account-scoped credentials (YouTube channels).
const SERVICES = {
  youtube: {
    sourcePolicy: POLICY_ENV_FIRST,
    accountScoped: true,
    // The canonical channel list. ec2-server.js builds YOUTUBE_TOKENS from this
    // and health-self-heal probes it, so the two can never drift again. It used
    // to be a hardcoded pair in the probe against three channels in the server,
    // which left the brand channel unprobed (Codex review 94ced983604c).
    // AILifeHacksByExampleCoyExampleCo is the brand channel UCnCUvNwfV9Sivf30xy_MyRg,
    // distinct from the personal channel.
    accounts: ['AILifeHacks', 'AILifeHacksByExampleCoyExampleCo', 'BedtimeStories'],
    credentials: {
      clientId: { env: 'YOUTUBE_CLIENT_ID', param: 'secondbrain.YOUTUBE_CLIENT_ID' },
      clientSecret: { env: 'YOUTUBE_CLIENT_SECRET', param: 'secondbrain.YOUTUBE_CLIENT_SECRET' },
      refreshToken: {
        env: 'YOUTUBE_REFRESH_TOKEN_{ACCOUNT}',
        param: 'secondbrain.YOUTUBE_REFRESH_TOKEN_{ACCOUNT}',
        accountScoped: true,
        disk: youtubeTokenFromDisk,
      },
    },
  },
  gmail: {
    sourcePolicy: POLICY_ENV_FIRST,
    credentials: {
      clientId: { env: 'GMAIL_CLIENT_ID', param: 'secondbrain.GMAIL_CLIENT_ID' },
      clientSecret: { env: 'GMAIL_CLIENT_SECRET', param: 'secondbrain.GMAIL_CLIENT_SECRET' },
      refreshToken: { env: 'GMAIL_REFRESH_TOKEN', param: 'secondbrain.GMAIL_REFRESH_TOKEN' },
    },
  },
  elevenlabs: {
    sourcePolicy: POLICY_ENV_FIRST,
    credentials: {
      apiKey: { env: 'ELEVENLABS_API_KEY', param: 'secondbrain.ELEVENLABS_API_KEY' },
    },
  },
  telegram: {
    sourcePolicy: POLICY_ENV_FIRST,
    credentials: {
      botToken: { env: 'TELEGRAM_BOT_TOKEN', param: 'secondbrain.TELEGRAM_BOT_TOKEN' },
    },
  },
  vapi: {
    sourcePolicy: POLICY_ENV_FIRST,
    credentials: {
      apiKey: { env: 'VAPI_API_KEY', param: 'secondbrain.VAPI_API_KEY' },
    },
  },
  cloudflare: {
    sourcePolicy: POLICY_ENV_FIRST,
    credentials: {
      // Pre-existing parameter name, already used by health-self-heal.js.
      apiToken: { env: 'CLOUDFLARE_API_TOKEN', param: 'pixscenestadium.CLOUDFLARE_API_TOKEN' },
    },
  },
};

// A 401/403-class failure means the credential itself is bad, which is a
// different operational state from the provider being down. Only the former
// is something ExampleCo can fix by rotating a secret.
const AUTH_FAILURE =
  /\b(401|403)\b|unauthorized|forbidden|invalid_ExampleCo|invalid[_ ]credentials|token (has )?expired|expired token/i;

// Statuses. pending_owner_secret_entry marks the deliberate human boundary:
// Amy generated the put-parameter command, ExampleCo has not pasted the value yet.
const STATUS = {
  CONNECTED: 'connected',
  DEGRADED: 'degraded',
  EXPIRED: 'expired',
  MISSING: 'missing',
  PENDING_OWNER: 'pending_owner_secret_entry',
  ExampleCo: 'ExampleCo',
};

function youtubeTokenFromDisk({ root, opts, fsApi, tokenDirs }) {
  const account = opts && opts.account;
  if (!account) return null;
  // The EC2 production path first, then the repo-relative path, then any host
  // specific directory the caller injected (the desktop resolves YouTube tokens
  // under APPDATA via runtimeDataPath, not under the repo).
  const dirs = [
    '/opt/secondbrain/data/youtube',
    path.join(root, 'data', 'youtube'),
    ...(tokenDirs || []),
  ];
  for (const dir of dirs) {
    try {
      const parsed = JSON.parse(
        fsApi.readFileSync(path.join(dir, `${account}_token.json`), 'utf8'),
      );
      if (parsed && parsed.refresh_token) return parsed.refresh_token;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// A dotenv file is a credential SOURCE, not a framework concern, so the broker
// reads it rather than assuming some caller already did. Scheduled entrypoints
// (the 2:45 AM diagnostic, the 3:00 AM self-heal) run under cron/PM2 without a
// loaded .env; only PM2's own env ExampleCod it before. The removed hardcoded
// fallbacks were masking exactly that gap, so without this the nightly probe
// goes yellow every night. Never overrides a real process env value.
function readEnvFile(file, fsApi) {
  const out = {};
  let text;
  try {
    text = fsApi.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) out[key] = value;
  }
  return out;
}

function fingerprintOf(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

function escapeForRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createBroker(deps = {}) {
  const root = deps.root || process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..', '..');
  // Honour the same data-root override health-self-heal.js uses, or the broker
  // receipt lands somewhere the live runtime never reads.
  const dataDir = deps.dataDir || process.env.SECONDBRAIN_DATA_DIR || path.join(root, 'data');
  const env = deps.env || process.env;
  const fsApi = deps.fsApi || fs;
  const now = deps.now || Date.now;
  const ttlMs = deps.ttlMs === undefined ? DEFAULT_TTL_MS : deps.ttlMs;
  const host = deps.host || require('os').hostname();
  // execFile, not exec: no shell, and the parameter name is an argv element
  // rather than an interpolated string.
  const runAws =
    deps.runAws ||
    ((args) => execFileSync('aws', args, { encoding: 'utf8', timeout: 15000, windowsHide: true }));

  const cache = new Map();
  // Every secret this broker has ever resolved, so redact() can scrub a value
  // out of text even when the caller does not know which credential leaked.
  const knownSecrets = new Map();

  // Lazily merged so constructing a broker costs no disk read.
  let fileEnv = null;
  function envLookup(key) {
    if (env[key]) return env[key];
    if (fileEnv === null) {
      const files = deps.envFiles || [path.join(root, '.env'), '/opt/secondbrain/.env'];
      fileEnv = {};
      for (const f of files) Object.assign(fileEnv, readEnvFile(f, fsApi));
    }
    return fileEnv[key] || null;
  }

  function spec(service, key) {
    const svc = SERVICES[service];
    if (!svc) throw new Error(`credential-broker: ExampleCo service "${service}"`);
    const cred = svc.credentials[key];
    if (!cred) throw new Error(`credential-broker: ExampleCo credential "${service}.${key}"`);
    return { svc, cred };
  }

  function nameFor(template, opts) {
    if (!template) return null;
    const account = opts && opts.account ? String(opts.account).toUpperCase() : '';
    return template.replace('{ACCOUNT}', account);
  }

  function ssmRead(cred, opts) {
    const param = nameFor(cred.param, opts);
    if (!param) return null;
    try {
      const out = String(
        runAws([
          'ssm',
          'get-parameter',
          '--name',
          param,
          '--with-decryption',
          '--region',
          REGION,
          '--query',
          'Parameter.Value',
          '--output',
          'text',
        ]) || '',
      ).trim();
      // The aws CLI prints the literal string "None" for an empty parameter.
      if (!out || out === 'None') return null;
      return out;
    } catch {
      // A missing parameter, an absent aws CLI, or an instance role without
      // ssm:GetParameter all land here. None of them should be fatal: the
      // caller still has the disk fallback, and the miss shows up in state.
      return null;
    }
  }

  function resolveCredential(service, key, opts = {}) {
    const { svc, cred } = spec(service, key);
    const account = opts.account || null;
    const cacheKey = `${service}:${key}:${account || ''}`;

    const hit = cache.get(cacheKey);
    if (hit && now() - hit.resolved_ms < ttlMs) return hit.result;

    const policy = svc.sourcePolicy || POLICY_ENV_FIRST;
    let value = null;
    let source = 'none';

    if (policy !== POLICY_SSM_REQUIRED) {
      const envKey = nameFor(cred.env, opts);
      const fromEnv = envKey ? envLookup(envKey) : null;
      if (fromEnv) {
        value = fromEnv;
        source = 'env';
      }
    }

    if (!value) {
      const fromParam = ssmRead(cred, opts);
      if (fromParam) {
        value = fromParam;
        source = 'ssm';
      }
    }

    if (!value && policy !== POLICY_SSM_REQUIRED && typeof cred.disk === 'function') {
      const fromDisk = cred.disk({ root, opts, fsApi, tokenDirs: deps.tokenDirs });
      if (fromDisk) {
        value = fromDisk;
        source = 'disk';
      }
    }

    const result = {
      service,
      key,
      account,
      value: value || null,
      present: Boolean(value),
      source,
      policy,
      fingerprint: value ? fingerprintOf(value) : null,
      resolved_at: new Date(now()).toISOString(),
    };

    if (value) {
      knownSecrets.set(value, `${service}.${key}`);
      // Only a hit is cached. Caching a miss would hide a credential that
      // arrives moments later, which is exactly the recovery case that matters.
      cache.set(cacheKey, { resolved_ms: now(), result });
    }

    return result;
  }

  // Metadata only. This is the shape that is safe to log, persist, or put
  // anywhere an LLM can read.
  function describeCredential(service, key, opts = {}) {
    const { value, ...meta } = resolveCredential(service, key, opts);
    void value;
    return meta;
  }

  // Reads SSM even when env already satisfies the credential, so the cutover
  // from legacy-env-first to ssm-required can be proven rather than assumed.
  // Returns metadata only.
  function verifySsm(service, key, opts = {}) {
    const { cred } = spec(service, key);
    const value = ssmRead(cred, opts);
    return {
      service,
      key,
      account: opts.account || null,
      param: nameFor(cred.param, opts),
      ssm_readable: Boolean(value),
      fingerprint: value ? fingerprintOf(value) : null,
      checked_at: new Date(now()).toISOString(),
    };
  }

  // The command ExampleCo runs to populate a parameter. The value is read from a
  // file, never passed as an argument: an argv form would put the secret in
  // shell history and in the process table for every user on the box, and a
  // bare `<placeholder>` would be parsed as shell redirection rather than a
  // prompt to substitute (Codex review of the implementation diff).
  function putParameterCommand(service, key, opts = {}) {
    const { cred } = spec(service, key);
    const param = nameFor(cred.param, opts);
    return [
      `printf %s 'THE_SECRET' > /tmp/sb-secret && chmod 600 /tmp/sb-secret`,
      `aws ssm put-parameter --name ${param} --type SecureString --value file:///tmp/sb-secret --region ${REGION} --overwrite`,
      `shred -u /tmp/sb-secret`,
    ].join(' && ');
  }

  function redact(text) {
    let out = String(text === undefined || text === null ? '' : text);
    for (const [secret, label] of knownSecrets) {
      if (!secret) continue;
      out = out.replace(new RegExp(escapeForRegex(secret), 'g'), `[redacted:${label}]`);
    }
    return out;
  }

  function statePath() {
    return path.join(dataDir, 'agent', 'connected-accounts.json');
  }

  function readState() {
    try {
      return JSON.parse(fsApi.readFileSync(statePath(), 'utf8'));
    } catch {
      return { updated_at: null, host, services: {} };
    }
  }

  function writeStateAtomic(state) {
    const file = statePath();
    fsApi.mkdirSync(path.dirname(file), { recursive: true });
    // Atomic: a concurrent reader sees either the old file or the new one,
    // never a half-written artifact the probe would call unreadable-and-red.
    const tmp = `${file}.${process.pid}.tmp`;
    fsApi.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fsApi.renameSync(tmp, file);
  }

  function classify(ok, errorText, outcome) {
    if (ok) return STATUS.CONNECTED;
    if (outcome.pendingOwnerSecretEntry) return STATUS.PENDING_OWNER;
    // An absent credential is not a degraded provider. Without this, a channel
    // whose refresh token cannot be resolved at all reads the same as a
    // transient 503 and the probe stays yellow instead of red.
    if (outcome.missing) return STATUS.MISSING;
    if (errorText && AUTH_FAILURE.test(errorText)) return STATUS.EXPIRED;
    return STATUS.DEGRADED;
  }

  // Called after a REAL API call, so status reflects observed health.
  // Pass `account` for an account-scoped service so one healthy channel cannot
  // mask another expired one.
  function recordOutcome(service, outcome = {}) {
    if (!SERVICES[service]) throw new Error(`credential-broker: ExampleCo service "${service}"`);
    const state = readState();
    if (!state.services) state.services = {};
    state.host = host;

    const nowIso = new Date(now()).toISOString();
    const ok = Boolean(outcome.ok);
    // Redacted before it is ever persisted: a provider error can echo the
    // credential it rejected.
    const errorText = outcome.error ? redact(String(outcome.error)).slice(0, 300) : null;
    const status = classify(ok, errorText, outcome);

    const entry = state.services[service] || {};
    const target = outcome.account
      ? ((entry.accounts = entry.accounts || {}), entry.accounts[outcome.account] || {})
      : entry;
    const prev = { ...target };

    const next = {
      status,
      source: outcome.source || prev.source || null,
      // Cutover proof: env-first short-circuits the SSM read, so without an
      // explicit verifySsm() result recorded here, nothing can ever show that a
      // service is ready to be promoted to ssm-required.
      ssm_readable:
        outcome.ssmReadable === undefined
          ? (prev.ssm_readable ?? null)
          : Boolean(outcome.ssmReadable),
      fingerprint: outcome.fingerprint || prev.fingerprint || null,
      // Preserved across failures so "how long has this been broken" is answerable.
      last_ok: ok ? nowIso : prev.last_ok || null,
      last_error: ok ? null : errorText,
      expires_at: outcome.expiresAt || prev.expires_at || null,
      checked_at: nowIso,
    };

    if (outcome.account) {
      entry.accounts[outcome.account] = next;
      // The service rolls up to its worst account so a service-level read is
      // never rosier than reality.
      entry.status = rollUp(Object.values(entry.accounts).map((a) => a.status));
      entry.checked_at = nowIso;
    } else {
      Object.assign(entry, next);
    }

    state.services[service] = entry;
    state.updated_at = nowIso;
    writeStateAtomic(state);
    return outcome.account ? entry.accounts[outcome.account] : entry;
  }

  // The self-heal contract says a probe needs a remediation path, and the
  // remediation for a credential Amy is not permitted to hold is a durable
  // handoff to ExampleCo, not a log line that scrolls away. Deduped per service, key
  // and UTC day so a nightly run cannot spam the ledger.
  function recordOwnerAction(service, key, opts = {}) {
    const file = path.join(dataDir, 'agent', 'credential-owner-actions.jsonl');
    const day = new Date(now()).toISOString().slice(0, 10);
    const dedupeKey = `${service}.${key}.${opts.account || ''}.${day}`;
    try {
      const existing = fsApi.readFileSync(file, 'utf8');
      if (existing.includes(`"dedupe_key":"${dedupeKey}"`)) return { recorded: false, dedupeKey };
    } catch {
      /* first entry */
    }
    const row = {
      ts: new Date(now()).toISOString(),
      dedupe_key: dedupeKey,
      host,
      service,
      key,
      account: opts.account || null,
      reason: opts.reason || 'credential unresolvable from env, SSM, or disk',
      // The command only, never the value. Amy cannot complete this step.
      action: putParameterCommand(service, key, opts),
    };
    fsApi.mkdirSync(path.dirname(file), { recursive: true });
    fsApi.appendFileSync(file, `${JSON.stringify(row)}\n`);
    return { recorded: true, dedupeKey };
  }

  return {
    resolveCredential,
    describeCredential,
    verifySsm,
    putParameterCommand,
    recordOutcome,
    recordOwnerAction,
    readState,
    redact,
    statePath,
    services: SERVICES,
  };
}

// Worst-wins so a rollup never reads healthier than its worst member.
const SEVERITY = [
  STATUS.MISSING,
  STATUS.EXPIRED,
  STATUS.PENDING_OWNER,
  STATUS.DEGRADED,
  STATUS.ExampleCo,
  STATUS.CONNECTED,
];
function rollUp(statuses) {
  for (const s of SEVERITY) if (statuses.includes(s)) return s;
  return STATUS.ExampleCo;
}

// Flattens service and account entries into one list of {label, status, source}.
function flatten(services) {
  const rows = [];
  for (const [name, entry] of Object.entries(services || {})) {
    if (entry && entry.accounts && Object.keys(entry.accounts).length) {
      for (const [account, a] of Object.entries(entry.accounts)) {
        rows.push({ label: `${name}/${account}`, status: a.status, source: a.source });
      }
      // A service-level failure (a client secret pending owner entry, say) is
      // recorded on the parent and would otherwise be dropped the moment the
      // service also has per-account rows.
      if (
        entry.status &&
        entry.status !== rollUp(Object.values(entry.accounts).map((a) => a.status))
      ) {
        rows.push({ label: name, status: entry.status, source: entry.source });
      }
    } else {
      rows.push({ label: name, status: entry && entry.status, source: entry && entry.source });
    }
  }
  return rows;
}

// Sync probe, matching the contract the other pre-briefing probes use:
// { status: 'green' | 'yellow' | 'red', detail: string }.
// It reads the artifact rather than live-testing credentials, because probes
// run inline in the 2:45 AM diagnostic and a live OAuth round trip per service
// would add minutes. Liveness comes from recordOutcome() on the real calls.
function probeCredentialBroker(opts = {}) {
  const root = opts.root || process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..', '..');
  const dataDir = opts.dataDir || process.env.SECONDBRAIN_DATA_DIR || path.join(root, 'data');
  const fsApi = opts.fsApi || fs;
  const now = opts.now || Date.now;
  const file = path.join(dataDir, 'agent', 'connected-accounts.json');

  let raw;
  try {
    raw = fsApi.readFileSync(file, 'utf8');
  } catch {
    return {
      status: 'yellow',
      detail: 'no credential state yet; the broker has not recorded an outcome on this host',
    };
  }

  let state;
  try {
    state = JSON.parse(raw);
  } catch (e) {
    return { status: 'red', detail: `connected-accounts.json is unreadable: ${e.message}` };
  }

  const rows = flatten(state && state.services);
  if (!rows.length) {
    return { status: 'yellow', detail: 'no credential state yet; no service has been recorded' };
  }

  const broken = rows.filter((r) => [STATUS.EXPIRED, STATUS.MISSING].includes(r.status));
  if (broken.length) {
    const detail = broken.map((r) => `${r.label} ${r.status}`).join(', ');
    return { status: 'red', detail: `credential needs rotation: ${detail}` };
  }

  const pending = rows.filter((r) => r.status === STATUS.PENDING_OWNER);
  if (pending.length) {
    return {
      status: 'yellow',
      detail: `awaiting owner secret entry: ${pending.map((r) => r.label).join(', ')}`,
    };
  }

  const degraded = rows.filter((r) => r.status === STATUS.DEGRADED);
  if (degraded.length) {
    return {
      status: 'yellow',
      detail: `credential degraded: ${degraded.map((r) => r.label).join(', ')}`,
    };
  }

  const updatedMs = Date.parse(state.updated_at || 0);
  const ageMs = now() - updatedMs;
  if (!Number.isFinite(updatedMs) || ageMs > STALE_STATE_MS) {
    const ageH = Math.round(ageMs / 3600000);
    return {
      status: 'yellow',
      detail: `credential state is stale (${ageH}h old); no service reported an outcome`,
    };
  }

  const summary = rows.map((r) => `${r.label} via ${r.source || 'ExampleCo'}`).join(', ');
  return { status: 'green', detail: `${rows.length} credentials connected: ${summary}` };
}

// Default instance for ordinary callers. Tests use createBroker() with
// injected deps so they stay network-free.
let defaultBroker = null;
function broker() {
  if (!defaultBroker) defaultBroker = createBroker();
  return defaultBroker;
}

module.exports = {
  SERVICES,
  STATUS,
  createBroker,
  probeCredentialBroker,
  rollUp,
  resolveCredential: (...args) => broker().resolveCredential(...args),
  describeCredential: (...args) => broker().describeCredential(...args),
  verifySsm: (...args) => broker().verifySsm(...args),
  putParameterCommand: (...args) => broker().putParameterCommand(...args),
  recordOutcome: (...args) => broker().recordOutcome(...args),
  redact: (...args) => broker().redact(...args),
};
