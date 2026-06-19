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
});
