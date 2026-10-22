// Desktop runtime path for the Electron-side provider-ladder attempt ledger.
//
// Runtime state stays outside Git worktrees (dev-plans/core/session-isolation.md,
// rule 5). Until 2026-09-29 both writers appended to
// <repo>/data/agent/electron-ladder-attempts.jsonl inside the shared checkout,
// which left it permanently dirty and held the Laws of Amy Gravity g10 row red.
// The ledger now lives beside the other desktop runtime data under
// %APPDATA%\secondbrain\data\agent. No electron import, so task-service stays
// importable in tests.
import * as os from 'os';
import * as path from 'path';

export const ELECTRON_LADDER_LEDGER_FILE = 'electron-ladder-attempts.jsonl';

export function electronLadderLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir =
    env.SECONDBRAIN_DATA_DIR ||
    path.join(env.APPDATA || path.join(os.homedir(), '.secondbrain'), 'secondbrain', 'data');
  return path.join(dataDir, 'agent', ELECTRON_LADDER_LEDGER_FILE);
}
