import { describe, expect, it } from 'vitest';
import { formatUsage } from '../src/usage.js';

const now = new Date('2026-11-26T22:00:00Z');
const tz = 'America/Toronto';

describe('formatUsage', () => {
  it('lists each limit with severity, reset time and extra usage', () => {
    const text = formatUsage(
      {
        limits: [
          { kind: 'session', percent: 27, severity: 'normal', resets_at: '2026-11-27T05:30:00.022478+00:00', scope: null },
          { kind: 'weekly_all', percent: 84, severity: 'warning', resets_at: '2026-12-01T07:00:00.022497+00:00', scope: null },
          { kind: 'weekly_scoped', percent: 7, severity: 'normal', resets_at: '2026-12-01T07:00:00Z', scope: { model: { display_name: 'Fable' }, surface: null } },
        ],
        spend: { used: { amount_minor: 10242, currency: 'CAD', exponent: 2 }, limit: { amount_minor: 20000, currency: 'CAD', exponent: 2 }, percent: 51, enabled: true },
      },
      now,
      tz,
    );
    expect(text).toBe(
      [
        'Session (5h): 27%, resets Fri, Nov 27, 12:30 AM EST (in 7h 30m)',
        'Weekly (all models): 84% [warning], resets Tue, Dec 1, 2:00 AM EST (in 4d 9h)',
        'Weekly (Fable): 7%, resets Tue, Dec 1, 2:00 AM EST (in 4d 9h)',
        'Extra usage: 102.42 of 200.00 CAD (51%)',
      ].join('\n'),
    );
  });

  it('falls back to the five_hour and seven_day windows', () => {
    const text = formatUsage({ five_hour: { utilization: 10, resets_at: '2026-11-26T22:45:00Z' }, seven_day: { utilization: 50, resets_at: null } }, now, tz);
    expect(text).toBe('Session (5h): 10%, resets Thu, Nov 26, 5:45 PM EST (in 45m)\nWeekly (all models): 50%');
  });

  it('says so when nothing is reported', () => {
    expect(formatUsage({}, now, tz)).toBe('No usage limits reported for this account.');
  });
});
