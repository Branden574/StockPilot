import { describe, expect, it } from 'vitest';

import {
  SERIAL_BATCH_CAP,
  SERIAL_MAX_LENGTH,
  SERIAL_STATUSES,
  SERIAL_STATUS_LABELS,
  canDeleteSerial,
  duplicateSerialFromDbError,
  formatSerialDate,
  isSerialStatus,
  serialSourceLabel,
  serialStatusColor,
  validateSerialInput,
} from './serials';

describe('validateSerialInput', () => {
  it('splits lines, trims whitespace, and drops empty lines', () => {
    const { serials, errors } = validateSerialInput('  SN-001  \n\nSN-002\r\n   \nSN-003');
    expect(serials).toEqual(['SN-001', 'SN-002', 'SN-003']);
    expect(errors).toEqual([]);
  });

  it('collapses duplicate lines to the first occurrence silently', () => {
    const { serials, errors } = validateSerialInput('SN-001\nSN-002\nSN-001\n  SN-002 ');
    expect(serials).toEqual(['SN-001', 'SN-002']);
    expect(errors).toEqual([]);
  });

  it('empty / whitespace-only input yields no serials and no errors', () => {
    expect(validateSerialInput('')).toEqual({ serials: [], errors: [] });
    expect(validateSerialInput('  \n \n')).toEqual({ serials: [], errors: [] });
  });

  it(`errors on a line over ${SERIAL_MAX_LENGTH} chars (1-based line number) and excludes it`, () => {
    const long = 'X'.repeat(SERIAL_MAX_LENGTH + 1);
    const { serials, errors } = validateSerialInput(`SN-001\n${long}\nSN-002`);
    expect(serials).toEqual(['SN-001', 'SN-002']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Line 2');
    expect(errors[0]).toContain(String(SERIAL_MAX_LENGTH));
  });

  it(`accepts a serial of exactly ${SERIAL_MAX_LENGTH} chars`, () => {
    const max = 'X'.repeat(SERIAL_MAX_LENGTH);
    expect(validateSerialInput(max)).toEqual({ serials: [max], errors: [] });
  });

  it(`caps the batch at ${SERIAL_BATCH_CAP} unique serials and reports the overflow`, () => {
    const input = Array.from({ length: SERIAL_BATCH_CAP + 3 }, (_, i) => `SN-${i}`).join('\n');
    const { serials, errors } = validateSerialInput(input);
    expect(serials).toHaveLength(SERIAL_BATCH_CAP);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(String(SERIAL_BATCH_CAP));
  });

  it('duplicates do not count toward the cap', () => {
    const uniq = Array.from({ length: SERIAL_BATCH_CAP }, (_, i) => `SN-${i}`);
    const input = [...uniq, ...uniq].join('\n'); // 1000 lines, 500 unique
    const { serials, errors } = validateSerialInput(input);
    expect(serials).toHaveLength(SERIAL_BATCH_CAP);
    expect(errors).toEqual([]);
  });
});

describe('serialSourceLabel / canDeleteSerial', () => {
  it('receipt-captured rows label as PO receipt and are not deletable', () => {
    expect(serialSourceLabel('11111111-2222-3333-4444-555555555555')).toBe('PO receipt');
    expect(canDeleteSerial('11111111-2222-3333-4444-555555555555')).toBe(false);
  });

  it('manually added rows (null receipt_line_id) label as Manual and are deletable', () => {
    expect(serialSourceLabel(null)).toBe('Manual');
    expect(canDeleteSerial(null)).toBe(true);
  });
});

describe('status list, labels, and guard', () => {
  it('has a human label for every DB status', () => {
    for (const s of SERIAL_STATUSES) {
      expect(SERIAL_STATUS_LABELS[s]).toBeTruthy();
    }
    expect(Object.keys(SERIAL_STATUS_LABELS).sort()).toEqual([...SERIAL_STATUSES].sort());
  });

  it('isSerialStatus narrows DB strings and rejects unknowns', () => {
    expect(isSerialStatus('available')).toBe(true);
    expect(isSerialStatus('rma')).toBe(true);
    expect(isSerialStatus('scrapped')).toBe(false);
    expect(isSerialStatus(null)).toBe(false);
    expect(isSerialStatus(42)).toBe(false);
  });
});

describe('serialStatusColor', () => {
  it('returns a complete tone (fg/bg/border) for every status in both modes', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const s of SERIAL_STATUSES) {
        const tone = serialStatusColor(s, mode);
        expect(tone.fg).toBeTruthy();
        expect(tone.bg).toBeTruthy();
        expect(tone.border).toBeTruthy();
      }
    }
  });

  it('available maps onto the mint accent, rejected onto crit', () => {
    const avail = serialStatusColor('available', 'light');
    expect(avail.bg).toContain('165'); // mint hue
    const rej = serialStatusColor('rejected', 'light');
    expect(rej.fg).toBe('#b03a3a'); // ACCENT.crit
  });

  it('sold (neutral) follows the palette per mode', () => {
    expect(serialStatusColor('sold', 'light').fg).not.toBe(
      serialStatusColor('sold', 'dark').fg,
    );
  });
});

describe('duplicateSerialFromDbError', () => {
  it('extracts the serial from a Postgres 23505 DETAIL string', () => {
    expect(
      duplicateSerialFromDbError(
        'Key (organization_id, item_id, serial_number)=(0f8fad5b-d9cb-469f-a165-70867728950e, 7c9e6679-7425-40de-944b-e07fc1f90ae7, SN-001) already exists.',
      ),
    ).toBe('SN-001');
  });

  it('handles serials containing commas and parens', () => {
    expect(
      duplicateSerialFromDbError(
        'Key (organization_id, item_id, serial_number)=(a, b, SN (rev 2), final) already exists.',
      ),
    ).toBe('SN (rev 2), final');
  });

  it('returns null for non-matching or missing detail', () => {
    expect(duplicateSerialFromDbError('duplicate key value violates unique constraint')).toBeNull();
    expect(duplicateSerialFromDbError(null)).toBeNull();
    expect(duplicateSerialFromDbError(undefined)).toBeNull();
  });
});

describe('formatSerialDate', () => {
  it('renders a short date containing the year', () => {
    // Midday UTC so any test-runner timezone stays on the same calendar day.
    expect(formatSerialDate('2026-07-08T12:00:00Z')).toContain('2026');
  });
});
