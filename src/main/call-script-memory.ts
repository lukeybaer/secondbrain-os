import * as fs from 'fs';
import * as path from 'path';

export interface CallPattern {
  call_type: string;
  outcome: 'success' | 'partial' | 'failed';
  opening: string;
  objection_handlers: string[];
  success_signals: string[];
  notes: string;
  weight: number;
  created_at?: string;
}

export interface CallScriptContext {
  call_type: string;
  patterns: CallPattern[];
}

interface Store {
  version: 1;
  patterns: CallPattern[];
}

const MAX_PATTERNS_PER_TYPE = 20;

function storePath(userDataDir: string): string {
  return path.join(userDataDir, 'call-script-memory.json');
}

function emptyStore(): Store {
  return { version: 1, patterns: [] };
}

function readStore(userDataDir: string): Store {
  const file = storePath(userDataDir);
  if (!fs.existsSync(file)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<Store>;
    if (!Array.isArray(parsed.patterns)) return emptyStore();
    return { version: 1, patterns: parsed.patterns };
  } catch {
    return emptyStore();
  }
}

function writeStore(userDataDir: string, store: Store): void {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(storePath(userDataDir), JSON.stringify(store, null, 2), 'utf-8');
}

export function appendCallPattern(userDataDir: string, pattern: CallPattern): void {
  const store = readStore(userDataDir);
  const now = new Date().toISOString();
  const next: CallPattern = {
    ...pattern,
    call_type: pattern.call_type || 'general',
    weight: Math.max(0, Math.min(pattern.weight || 0.1, 1)),
    created_at: pattern.created_at ?? now,
  };

  store.patterns.push(next);

  const grouped = new Map<string, CallPattern[]>();
  for (const item of store.patterns) {
    const key = item.call_type || 'general';
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }

  store.patterns = [...grouped.values()].flatMap((items) =>
    items
      .sort((a, b) => {
        if (b.weight !== a.weight) return b.weight - a.weight;
        return (b.created_at ?? '').localeCompare(a.created_at ?? '');
      })
      .slice(0, MAX_PATTERNS_PER_TYPE),
  );

  writeStore(userDataDir, store);
}

export function getCallScriptContext(
  userDataDir: string,
  callType: string,
  limit = 5,
): CallScriptContext | null {
  const type = callType || 'general';
  const patterns = readStore(userDataDir)
    .patterns.filter((p) => (p.call_type || 'general') === type || p.call_type === 'general')
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return (b.created_at ?? '').localeCompare(a.created_at ?? '');
    })
    .slice(0, Math.max(1, limit));

  if (!patterns.length) return null;
  return { call_type: type, patterns };
}

export function formatCallScriptContextBlock(context: CallScriptContext): string {
  if (!context.patterns.length) return '';
  const lines = [
    '## Learned call patterns',
    `Call type: ${context.call_type}`,
    'Use these as light guidance, not a script.',
    '',
  ];

  context.patterns.forEach((pattern, index) => {
    lines.push(`Pattern ${index + 1} (${pattern.outcome}, weight ${pattern.weight.toFixed(2)})`);
    if (pattern.opening) lines.push(`Opening that worked: ${pattern.opening}`);
    if (pattern.objection_handlers.length) {
      lines.push(`Objection handlers: ${pattern.objection_handlers.join(' | ')}`);
    }
    if (pattern.success_signals.length) {
      lines.push(`Success signals: ${pattern.success_signals.join(' | ')}`);
    }
    if (pattern.notes) lines.push(`Notes: ${pattern.notes}`);
    lines.push('');
  });

  return lines.join('\n').trim();
}
