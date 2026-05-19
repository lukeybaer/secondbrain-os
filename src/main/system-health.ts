import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';
import { getDb } from './database-sqlite';
import { isGraphitiAvailable } from './graphiti-client';
import { getStatus as getWhatsAppStatus } from './whatsapp-web';
import { getTimeMachineStatus, loadTimeMachineConfig } from './timemachine';
import { listSnapshots } from './backups';
import { listToolFailures, type ToolFailure } from './observability/readers';

export type HealthStatus = 'ok' | 'warn' | 'error';

export interface HealthFact {
  label: string;
  value: string;
  status?: HealthStatus;
}

export interface HealthCheck {
  id: string;
  label: string;
  status: HealthStatus;
  summary: string;
  detail?: string;
  facts?: HealthFact[];
}

export interface SystemHealthReport {
  generatedAt: string;
  overallStatus: HealthStatus;
  checks: HealthCheck[];
  recentFailures: ToolFailure[];
}

function overallStatus(checks: HealthCheck[]): HealthStatus {
  if (checks.some((check) => check.status === 'error')) return 'error';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  return 'ok';
}

function present(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : !!value;
}

function presenceFact(label: string, ok: boolean): HealthFact {
  return { label, value: ok ? 'present' : 'missing', status: ok ? 'ok' : 'warn' };
}

function configCompletenessCheck(): HealthCheck {
  const cfg = getConfig();
  const dataDirReady = present(cfg.dataDir) && fs.existsSync(cfg.dataDir);
  const otterReady =
    (present(cfg.otterSessionCookie) && present(cfg.otterUserId)) ||
    (present(cfg.otterEmail) && present(cfg.otterPassword));

  const facts: HealthFact[] = [
    presenceFact('Data directory', dataDirReady),
    presenceFact('OpenAI key', present(cfg.openaiApiKey)),
    presenceFact('OpenAI model', present(cfg.openaiModel)),
    presenceFact('Light model', present(cfg.openaiLightModel)),
    presenceFact('Embedding model', present(cfg.openaiEmbeddingModel)),
    presenceFact('Otter credentials or session', otterReady),
  ];
  const missing = facts.filter((fact) => fact.status !== 'ok');
  const hardMissing = facts.filter(
    (fact) => fact.status !== 'ok' && ['Data directory', 'OpenAI key'].includes(fact.label),
  );

  return {
    id: 'configCompleteness',
    label: 'Config Completeness',
    status: hardMissing.length > 0 ? 'error' : missing.length > 0 ? 'warn' : 'ok',
    summary:
      missing.length === 0
        ? 'Core settings are complete.'
        : `${facts.length - missing.length}/${facts.length} core settings are present.`,
    detail: missing.length > 0 ? `Missing: ${missing.map((fact) => fact.label).join(', ')}` : '',
    facts,
  };
}

function integrationConfigCheck(
  id: string,
  label: string,
  required: Array<[string, boolean]>,
): HealthCheck {
  const missing = required.filter(([, ok]) => !ok);
  return {
    id,
    label,
    status: missing.length > 0 ? 'warn' : 'ok',
    summary: missing.length === 0 ? 'Configured.' : `${missing.length} setting(s) missing.`,
    detail: missing.length > 0 ? `Missing: ${missing.map(([name]) => name).join(', ')}` : '',
    facts: required.map(([name, ok]) => presenceFact(name, ok)),
  };
}

function sqliteCheck(): HealthCheck {
  const dbPath = path.join(app.getPath('userData'), 'data', 'secondbrain.db');
  if (!fs.existsSync(dbPath)) {
    return {
      id: 'sqlite',
      label: 'SQLite',
      status: 'error',
      summary: 'Database file is missing.',
      detail: dbPath,
    };
  }

  try {
    getDb().prepare('SELECT 1 AS ok').get();
    const stat = fs.statSync(dbPath);
    return {
      id: 'sqlite',
      label: 'SQLite',
      status: 'ok',
      summary: 'Database responds to a read probe.',
      facts: [
        { label: 'Path', value: dbPath },
        { label: 'Size', value: `${Math.round(stat.size / 1024)} KB` },
      ],
    };
  } catch (error) {
    return {
      id: 'sqlite',
      label: 'SQLite',
      status: 'error',
      summary: 'Database read probe failed.',
      detail: error instanceof Error ? error.message : String(error),
      facts: [{ label: 'Path', value: dbPath }],
    };
  }
}

async function graphitiCheck(): Promise<HealthCheck> {
  try {
    const ok = await isGraphitiAvailable();
    return {
      id: 'graphiti',
      label: 'Graphiti',
      status: ok ? 'ok' : 'warn',
      summary: ok ? 'Knowledge graph is reachable.' : 'Knowledge graph is not reachable.',
      detail: ok ? '' : 'Local Graphiti tunnel or service did not answer /health.',
    };
  } catch (error) {
    return {
      id: 'graphiti',
      label: 'Graphiti',
      status: 'warn',
      summary: 'Knowledge graph probe failed.',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function whatsappCheck(): HealthCheck {
  const status = getWhatsAppStatus();
  const mapped: HealthStatus =
    status === 'ready' || status === 'authenticated'
      ? 'ok'
      : status === 'auth_failure'
        ? 'error'
        : 'warn';
  return {
    id: 'whatsapp',
    label: 'WhatsApp',
    status: mapped,
    summary: `WhatsApp status: ${status}.`,
  };
}

function timeMachineCheck(): HealthCheck {
  const cfg = loadTimeMachineConfig();
  const status = getTimeMachineStatus();
  const health: HealthStatus = cfg.enabled
    ? status.running
      ? status.paused
        ? 'warn'
        : 'ok'
      : 'error'
    : 'warn';

  return {
    id: 'timeMachine',
    label: 'Time Machine',
    status: health,
    summary: cfg.enabled
      ? status.running
        ? status.paused
          ? 'Enabled but paused.'
          : 'Enabled and capturing.'
        : 'Enabled but not running.'
      : 'Disabled.',
    facts: [
      { label: 'Enabled', value: cfg.enabled ? 'yes' : 'no', status: cfg.enabled ? 'ok' : 'warn' },
      {
        label: 'Running',
        value: status.running ? 'yes' : 'no',
        status: status.running ? 'ok' : cfg.enabled ? 'error' : 'warn',
      },
      { label: 'Paused', value: status.paused ? 'yes' : 'no', status: status.paused ? 'warn' : 'ok' },
      { label: 'Captures since start', value: String(status.captureCount) },
      { label: 'Last capture', value: status.lastCaptureAt ?? 'never' },
      { label: 'Audio recording', value: status.audioRecording ? 'yes' : 'no' },
    ],
  };
}

function ipcFailureCheck(userData: string): { check: HealthCheck; failures: ToolFailure[] } {
  const failures = listToolFailures(userData, 24, 10);
  return {
    failures,
    check: {
      id: 'recentFailures',
      label: 'Recent IPC/Tool Failures',
      status: failures.length > 0 ? 'error' : 'ok',
      summary:
        failures.length === 0
          ? 'No traced failures in the last 24 hours.'
          : `${failures.length} traced failure(s) in the last 24 hours.`,
      facts: failures.slice(0, 5).map((failure) => ({
        label: failure.tool,
        value: `${failure.error} (${failure.durationMs}ms)`,
        status: 'error',
      })),
    },
  };
}

function backupEncryptionCheck(): HealthCheck {
  const snapshots = listSnapshots();
  const latest = snapshots[0];
  const userData = app.getPath('userData');
  const backupsRoot = path.join(userData, 'backups');
  const vaultPath = path.join(userData, 'data', 'vault', 'pii.encrypted.json');
  const backupCliPath = path.join(
    process.env.SECONDBRAIN_ROOT || app.getAppPath(),
    'scripts',
    'backup-cli.ts',
  );
  const backupCliSource = fs.existsSync(backupCliPath)
    ? fs.readFileSync(backupCliPath, 'utf-8')
    : '';
  const cliHasExplicitSse = /--sse/.test(backupCliSource) && /AES256|aws:kms/i.test(backupCliSource);
  const localSnapshotPlaintext =
    !!latest &&
    (fs.existsSync(path.join(backupsRoot, latest.id, 'config.json')) ||
      fs.existsSync(path.join(backupsRoot, latest.id, 'data')));

  const facts: HealthFact[] = [
    {
      label: 'Local snapshots',
      value: localSnapshotPlaintext ? 'plaintext directories' : snapshots.length ? 'metadata only' : 'none',
      status: localSnapshotPlaintext ? 'warn' : snapshots.length ? 'ok' : 'warn',
    },
    {
      label: 'S3 upload encryption flag',
      value: cliHasExplicitSse ? 'explicit SSE flag found' : 'not explicit in backup-cli',
      status: cliHasExplicitSse ? 'ok' : 'warn',
    },
    {
      label: 'PII vault file',
      value: fs.existsSync(vaultPath) ? 'AES-256-GCM encrypted file present' : 'not initialized',
      status: fs.existsSync(vaultPath) ? 'ok' : 'warn',
    },
    {
      label: 'Latest snapshot',
      value: latest ? `${latest.id} (${latest.timestamp})` : 'none',
      status: latest ? 'ok' : 'warn',
    },
  ];

  return {
    id: 'backupEncryption',
    label: 'Backup Encryption',
    status: facts.some((fact) => fact.status === 'warn') ? 'warn' : 'ok',
    summary: localSnapshotPlaintext
      ? 'Local backup snapshots are readable filesystem copies.'
      : snapshots.length
        ? 'Backup encryption posture has no blocking issue.'
        : 'No backup snapshots are recorded.',
    detail: cliHasExplicitSse
      ? 'S3 upload command includes an explicit server-side encryption flag.'
      : 'Bucket default encryption may still protect S3, but the local backup code does not assert it.',
    facts,
  };
}

export async function getSystemHealth(): Promise<SystemHealthReport> {
  const cfg = getConfig();
  const userData = app.getPath('userData');
  const failures = ipcFailureCheck(userData);
  const checks: HealthCheck[] = [
    sqliteCheck(),
    configCompletenessCheck(),
    await graphitiCheck(),
    whatsappCheck(),
    integrationConfigCheck('twilioConfig', 'Twilio Config', [
      ['Account SID', present(cfg.twilioAccountSid)],
      ['Auth token', present(cfg.twilioAuthToken)],
      ['Phone number', present(cfg.twilioPhoneNumber)],
    ]),
    integrationConfigCheck('vapiConfig', 'Vapi Config', [
      ['API key', present(cfg.vapiApiKey)],
      ['Phone number ID', present(cfg.vapiPhoneNumberId)],
      ['Callback assistant ID', present(cfg.callbackAssistantId)],
    ]),
    integrationConfigCheck('telegramConfig', 'Telegram Config', [
      ['Bot token', present(cfg.telegramBotToken)],
      ['Chat ID', present(cfg.telegramChatId)],
    ]),
    timeMachineCheck(),
    failures.check,
    backupEncryptionCheck(),
  ];

  return {
    generatedAt: new Date().toISOString(),
    overallStatus: overallStatus(checks),
    checks,
    recentFailures: failures.failures,
  };
}
