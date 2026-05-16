import { describe, it, expect } from 'vitest';
import {
  buildPrivacyDrawboxFilter,
  decidePrivacyCapture,
  domainMatches,
  pauseScheduleMatches,
} from '../timemachine-privacy';
import type { TimeMachinePrivacySettings } from '../timemachine-types';

const baseSettings: TimeMachinePrivacySettings = {
  zones: [],
  pauseSchedules: [],
  excludedApps: [],
  excludedTitlePatterns: [],
  excludedDomains: [],
};

describe('Time Machine privacy', () => {
  it('matches same-day pause schedules', () => {
    expect(
      pauseScheduleMatches(
        { id: 'p1', label: 'Work', days: [1], startTime: '09:00', endTime: '17:00', enabled: true },
        new Date('2026-05-18T13:00:00'),
      ),
    ).toBe(true);
  });

  it('matches overnight pause schedules', () => {
    expect(
      pauseScheduleMatches(
        { id: 'p1', label: 'Night', days: [1], startTime: '22:00', endTime: '06:00', enabled: true },
        new Date('2026-05-19T02:00:00'),
      ),
    ).toBe(true);
  });

  it('matches excluded apps case-insensitively', () => {
    const decision = decidePrivacyCapture(
      { ...baseSettings, excludedApps: ['chrome'] },
      { owner: { name: 'Google Chrome', processName: 'chrome.exe' }, title: 'Search' },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Excluded app');
  });

  it('matches excluded domains by URL and title fallback', () => {
    expect(domainMatches('https://sub.example.com/private', ['example.com'])).toBe('example.com');
    const decision = decidePrivacyCapture(
      { ...baseSettings, excludedDomains: ['bank.com'] },
      { title: 'bank.com account', owner: { name: 'Browser' } },
    );
    expect(decision.allowed).toBe(false);
  });

  it('builds drawbox filters and ignores disabled zones', () => {
    expect(
      buildPrivacyDrawboxFilter([
        { id: 'z1', label: 'Chat', x: 1, y: 2, width: 300, height: 100, enabled: true },
        { id: 'z2', label: 'Off', x: 3, y: 4, width: 50, height: 50, enabled: false },
      ]),
    ).toBe('drawbox=x=1:y=2:w=300:h=100:color=black@1:t=fill');
  });

  it('allows capture when no rule matches', () => {
    expect(decidePrivacyCapture(baseSettings, { title: 'Inbox' }).allowed).toBe(true);
  });

  it('skips capture when schedule or title matches', () => {
    expect(
      decidePrivacyCapture(
        {
          ...baseSettings,
          pauseSchedules: [
            {
              id: 'p1',
              label: 'Lunch',
              days: [6],
              startTime: '12:00',
              endTime: '13:00',
              enabled: true,
            },
          ],
        },
        null,
        new Date('2026-05-16T12:30:00'),
      ).allowed,
    ).toBe(false);
    expect(
      decidePrivacyCapture(
        { ...baseSettings, excludedTitlePatterns: ['secret'] },
        { title: 'Secret notes' },
      ).allowed,
    ).toBe(false);
  });
});

