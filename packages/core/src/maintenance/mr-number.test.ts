import { describe, expect, it } from 'vitest';

import { formatMaintenanceRequestNumber, parseMaintenanceRequestNumber } from './mr-number';

describe('formatMaintenanceRequestNumber', () => {
  it('formats MR-<year>-<6-pad> with the year COSMETIC from created_at', () => {
    expect(formatMaintenanceRequestNumber(123, '2026-08-05T16:15:00Z')).toBe('MR-2026-000123');
    // Counter does NOT reset per year — same number, later year, still valid:
    expect(formatMaintenanceRequestNumber(123, '2027-01-02T00:00:00Z')).toBe('MR-2027-000123');
  });
  it('returns null for missing/invalid input, never a fake handle', () => {
    expect(formatMaintenanceRequestNumber(null, '2026-08-05T00:00:00Z')).toBeNull();
    expect(formatMaintenanceRequestNumber(0, '2026-08-05T00:00:00Z')).toBeNull();
    expect(formatMaintenanceRequestNumber(5, 'not-a-date')).toBeNull();
  });
  it('accepts a Date instance for createdAt, not only a string', () => {
    expect(formatMaintenanceRequestNumber(7, new Date('2026-01-01T00:00:00Z'))).toBe(
      'MR-2026-000007',
    );
  });
  it('returns null for undefined/negative n and null/undefined createdAt', () => {
    expect(formatMaintenanceRequestNumber(undefined, '2026-08-05T00:00:00Z')).toBeNull();
    expect(formatMaintenanceRequestNumber(-1, '2026-08-05T00:00:00Z')).toBeNull();
    expect(formatMaintenanceRequestNumber(5, null)).toBeNull();
    expect(formatMaintenanceRequestNumber(5, undefined)).toBeNull();
  });
  it('pads under a million to exactly 6 digits and does not truncate at or above it (LITERAL pin)', () => {
    expect(formatMaintenanceRequestNumber(1, '2026-08-05T00:00:00Z')).toBe('MR-2026-000001');
    expect(formatMaintenanceRequestNumber(1_000_000, '2026-08-05T00:00:00Z')).toBe(
      'MR-2026-1000000',
    );
  });
});

describe('parseMaintenanceRequestNumber', () => {
  it('parses typed handles back to the bigint for search', () => {
    expect(parseMaintenanceRequestNumber('MR-2026-000123')).toBe(123);
    expect(parseMaintenanceRequestNumber('mr-2026-123')).toBe(123);
    expect(parseMaintenanceRequestNumber('MR-000123')).toBe(123);
    expect(parseMaintenanceRequestNumber('123')).toBe(123);
  });
  it('rejects non-handles', () => {
    expect(parseMaintenanceRequestNumber('SO-000049')).toBeNull();
    expect(parseMaintenanceRequestNumber('hello')).toBeNull();
    expect(parseMaintenanceRequestNumber('')).toBeNull();
  });
  it('is tolerant of surrounding whitespace and mixed case', () => {
    expect(parseMaintenanceRequestNumber('  MR-2026-000045  ')).toBe(45);
    expect(parseMaintenanceRequestNumber('Mr-2026-000045')).toBe(45);
  });
  it('rejects zero and non-numeric handles', () => {
    expect(parseMaintenanceRequestNumber('MR-2026-000000')).toBeNull();
    expect(parseMaintenanceRequestNumber('MR-abcdef')).toBeNull();
    expect(parseMaintenanceRequestNumber('MR-')).toBeNull();
  });
  it('never treats the parsed number as an authorization credential by itself (round-trip only)', () => {
    // The handle round-trips through format/parse but carries no org_id, no
    // signature, and no permission — it is a display convenience, never a key.
    const n = 987;
    const handle = formatMaintenanceRequestNumber(n, '2026-08-05T00:00:00Z');
    expect(handle).not.toBeNull();
    expect(parseMaintenanceRequestNumber(handle as string)).toBe(n);
  });
});
