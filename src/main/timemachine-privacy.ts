import type {
  TimeMachinePauseSchedule,
  TimeMachinePrivacySettings,
  TimeMachinePrivacyZone,
} from './timemachine-types';

export interface ActiveWindowInfo {
  title?: string;
  owner?: {
    name?: string;
    processName?: string;
    path?: string;
  };
  url?: string;
}

export interface PrivacyDecision {
  allowed: boolean;
  reason: string | null;
}

function minutesOfDay(time: string): number {
  const [h, m] = time.split(':').map((v) => parseInt(v, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

export function pauseScheduleMatches(
  schedule: TimeMachinePauseSchedule,
  now = new Date(),
): boolean {
  if (!schedule.enabled || schedule.days.length === 0) return false;

  const currentDay = now.getDay();
  const previousDay = (currentDay + 6) % 7;
  const current = now.getHours() * 60 + now.getMinutes();
  const start = minutesOfDay(schedule.startTime);
  const end = minutesOfDay(schedule.endTime);

  if (start === end) return schedule.days.includes(currentDay);
  if (start < end) return schedule.days.includes(currentDay) && current >= start && current < end;

  return (
    (schedule.days.includes(currentDay) && current >= start) ||
    (schedule.days.includes(previousDay) && current < end)
  );
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function includesAny(value: string | undefined, needles: string[]): string | null {
  const haystack = normalize(value || '');
  if (!haystack) return null;
  const match = needles.map(normalize).find((needle) => needle && haystack.includes(needle));
  return match || null;
}

export function domainMatches(url: string | undefined, domains: string[]): string | null {
  if (!url) return null;
  try {
    const hostname = normalize(new URL(url).hostname).replace(/^www\./, '');
    return (
      domains.map(normalize).find((domain) => {
        const bare = domain.replace(/^www\./, '');
        return bare && (hostname === bare || hostname.endsWith(`.${bare}`));
      }) || null
    );
  } catch {
    return includesAny(url, domains);
  }
}

export function titlePatternMatches(title: string | undefined, patterns: string[]): string | null {
  return includesAny(title, patterns);
}

export function appMatches(activeWindow: ActiveWindowInfo | null, apps: string[]): string | null {
  if (!activeWindow) return null;
  return (
    includesAny(activeWindow.owner?.name, apps) ||
    includesAny(activeWindow.owner?.processName, apps) ||
    includesAny(activeWindow.owner?.path, apps)
  );
}

export function decidePrivacyCapture(
  settings: TimeMachinePrivacySettings,
  activeWindow: ActiveWindowInfo | null,
  now = new Date(),
): PrivacyDecision {
  const schedule = settings.pauseSchedules.find((s) => pauseScheduleMatches(s, now));
  if (schedule) return { allowed: false, reason: `Pause schedule: ${schedule.label}` };

  const app = appMatches(activeWindow, settings.excludedApps);
  if (app) return { allowed: false, reason: `Excluded app: ${app}` };

  const domain = domainMatches(activeWindow?.url, settings.excludedDomains);
  if (domain) return { allowed: false, reason: `Excluded domain: ${domain}` };

  const domainTitle = titlePatternMatches(activeWindow?.title, settings.excludedDomains);
  if (domainTitle) return { allowed: false, reason: `Excluded domain title: ${domainTitle}` };

  const title = titlePatternMatches(activeWindow?.title, settings.excludedTitlePatterns);
  if (title) return { allowed: false, reason: `Excluded title: ${title}` };

  return { allowed: true, reason: null };
}

export function buildPrivacyDrawboxFilter(zones: TimeMachinePrivacyZone[]): string | null {
  const filters = zones
    .filter((z) => z.enabled && z.width > 0 && z.height > 0)
    .map(
      (z) =>
        `drawbox=x=${Math.round(z.x)}:y=${Math.round(z.y)}:w=${Math.round(
          z.width,
        )}:h=${Math.round(z.height)}:color=black@1:t=fill`,
    );
  return filters.length > 0 ? filters.join(',') : null;
}

