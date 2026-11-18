export function textValue(value: unknown, fallback = ''): string {
  if (value == null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const rendered = value.map((item) => textValue(item)).filter(Boolean).join('\n');
    return rendered || fallback;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['note', 'message', 'error', 'fix_summary', 'title']) {
      const rendered = textValue(record[key]);
      if (rendered) return rendered;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function noteText(value: unknown, fallback = '(no note)'): string {
  const rendered = textValue(value).trim();
  return rendered || fallback;
}

export function dateText(value: unknown): string {
  const rendered = textValue(value).trim();
  return rendered ? rendered.slice(0, 10) : '';
}
