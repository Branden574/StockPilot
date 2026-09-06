import { describe, expect, it } from 'vitest';
import { nextRunAt } from './recurring';

const base = new Date('2026-06-18T07:00:00.000Z');

describe('nextRunAt', () => {
  it('weekly = +7 days', () => {
    expect(nextRunAt('weekly', base).toISOString()).toBe('2026-06-25T07:00:00.000Z');
  });
  it('biweekly = +14 days', () => {
    expect(nextRunAt('biweekly', base).toISOString()).toBe('2026-07-02T07:00:00.000Z');
  });
  it('monthly = +1 month', () => {
    expect(nextRunAt('monthly', base).toISOString()).toBe('2026-07-18T07:00:00.000Z');
  });
  it('quarterly = +3 months', () => {
    expect(nextRunAt('quarterly', base).toISOString()).toBe('2026-09-18T07:00:00.000Z');
  });
  it('custom uses customDays', () => {
    expect(nextRunAt('custom', base, 10).toISOString()).toBe('2026-06-28T07:00:00.000Z');
  });
  it('custom falls back to weekly when customDays missing/invalid', () => {
    expect(nextRunAt('custom', base).toISOString()).toBe('2026-06-25T07:00:00.000Z');
  });

  // ── month-end anchors (SP-044) ────────────────────────────────────────────
  // Regression: `d.setUTCMonth(m + 1)` on a day-29..31 date ROLLS OVER into the
  // month after next (Jan 31 -> Mar 3), so a monthly template created on the
  // 31st skipped February entirely — and runDueTemplates chains from the
  // drifted value, so the day-of-month kept sliding forever. Clamp to the last
  // day of the target month instead.
  describe('month-end anchors do not roll over into the following month', () => {
    it('monthly from Jan 31 lands on Feb 28 (not Mar 3)', () => {
      expect(nextRunAt('monthly', new Date('2026-01-31T07:00:00.000Z')).toISOString()).toBe(
        '2026-02-28T07:00:00.000Z',
      );
    });
    it('monthly from Mar 31 lands on Apr 30 (not May 1)', () => {
      expect(nextRunAt('monthly', new Date('2026-03-31T07:00:00.000Z')).toISOString()).toBe(
        '2026-04-30T07:00:00.000Z',
      );
    });
    it('quarterly from Nov 30 lands on Feb 28 (not Mar 2)', () => {
      expect(nextRunAt('quarterly', new Date('2025-11-30T07:00:00.000Z')).toISOString()).toBe(
        '2026-02-28T07:00:00.000Z',
      );
    });
    it('monthly from Jan 31 in a LEAP year lands on Feb 29', () => {
      expect(nextRunAt('monthly', new Date('2028-01-31T07:00:00.000Z')).toISOString()).toBe(
        '2028-02-29T07:00:00.000Z',
      );
    });
    it('quarterly from Aug 31 lands on Nov 30 (not Dec 1)', () => {
      expect(nextRunAt('quarterly', new Date('2026-08-31T07:00:00.000Z')).toISOString()).toBe(
        '2026-11-30T07:00:00.000Z',
      );
    });
    it('keeps the day when the target month is long enough (Jan 30 -> Feb 28, Mar 30 -> Apr 30)', () => {
      expect(nextRunAt('monthly', new Date('2026-01-30T07:00:00.000Z')).toISOString()).toBe(
        '2026-02-28T07:00:00.000Z',
      );
      expect(nextRunAt('monthly', new Date('2026-03-30T07:00:00.000Z')).toISOString()).toBe(
        '2026-04-30T07:00:00.000Z',
      );
    });
    it('crosses the year boundary without drifting (Dec 31 -> Jan 31)', () => {
      expect(nextRunAt('monthly', new Date('2026-12-31T07:00:00.000Z')).toISOString()).toBe(
        '2027-01-31T07:00:00.000Z',
      );
      expect(nextRunAt('quarterly', new Date('2026-12-31T07:00:00.000Z')).toISOString()).toBe(
        '2027-03-31T07:00:00.000Z',
      );
    });
    it('preserves the time-of-day across the clamp', () => {
      expect(nextRunAt('monthly', new Date('2026-01-31T23:59:59.123Z')).toISOString()).toBe(
        '2026-02-28T23:59:59.123Z',
      );
    });
  });
});
