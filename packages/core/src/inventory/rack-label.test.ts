import { describe, it, expect } from 'vitest';

import {
  formatRackLabel,
  isCompositeRackNumber,
  normalizeRackFields,
  parseRackLabel,
} from './rack-label';

describe('parseRackLabel', () => {
  it('bare number has no row', () => {
    expect(parseRackLabel('22')).toEqual({ number: '22', row: null });
  });

  it('number-row splits on the dash', () => {
    expect(parseRackLabel('22-B')).toEqual({ number: '22', row: 'B' });
  });

  it('multi-dash splits on the LAST dash', () => {
    // A rack legitimately named "E2E-RACK" with row 1 — splitting on the FIRST
    // dash would turn it into E2E / RACK-1 and lose the rack.
    expect(parseRackLabel('E2E-RACK-1')).toEqual({ number: 'E2E-RACK', row: '1' });
  });

  it('no dash at all is all number', () => {
    expect(parseRackLabel('MEZZANINE')).toEqual({ number: 'MEZZANINE', row: null });
  });

  it('empty string yields an empty number and no row', () => {
    expect(parseRackLabel('')).toEqual({ number: '', row: null });
  });

  it('whitespace-only yields an empty number and no row', () => {
    expect(parseRackLabel('   ')).toEqual({ number: '', row: null });
  });

  it('trims surrounding whitespace on both halves', () => {
    expect(parseRackLabel('  22 - B  ')).toEqual({ number: '22', row: 'B' });
  });

  it('preserves a lowercase row verbatim (casing normalisation is the writer\'s job)', () => {
    // The read path filters with an exact eq against stored values, so
    // uppercasing here would stop matching any row stored lowercase.
    expect(parseRackLabel('22-b')).toEqual({ number: '22', row: 'b' });
  });

  it('handles a numeric row', () => {
    expect(parseRackLabel('22-3')).toEqual({ number: '22', row: '3' });
  });

  it('handles a multi-character row', () => {
    expect(parseRackLabel('22-AB12')).toEqual({ number: '22', row: 'AB12' });
  });

  it('ignores a trailing dash rather than inventing an empty row', () => {
    expect(parseRackLabel('22-')).toEqual({ number: '22', row: null });
  });

  it('ignores a leading dash', () => {
    expect(parseRackLabel('-22')).toEqual({ number: '22', row: null });
  });

  it('does not leave a stray dash in the number half of a doubled dash', () => {
    expect(parseRackLabel('22--B')).toEqual({ number: '22', row: 'B' });
  });

  it('accepts null/undefined', () => {
    expect(parseRackLabel(null)).toEqual({ number: '', row: null });
    expect(parseRackLabel(undefined)).toEqual({ number: '', row: null });
  });
});

describe('formatRackLabel', () => {
  it('joins number and row with a dash', () => {
    expect(formatRackLabel({ number: '22', row: 'B' })).toBe('22-B');
  });

  it('renders a number-only rack unchanged', () => {
    expect(formatRackLabel({ number: '22', row: null })).toBe('22');
    expect(formatRackLabel({ number: '22' })).toBe('22');
    expect(formatRackLabel({ number: '22', row: '  ' })).toBe('22');
  });

  it('renders nothing without a number', () => {
    expect(formatRackLabel({ number: '', row: 'B' })).toBe('');
    expect(formatRackLabel({ number: null, row: 'B' })).toBe('');
  });

  it('round-trips every parse (the label a user sees never changes)', () => {
    for (const label of ['22', '22-B', 'E2E-RACK-1', 'MEZZANINE', '22-3', '22-AB12']) {
      expect(formatRackLabel(parseRackLabel(label))).toBe(label);
    }
  });
});

describe('isCompositeRackNumber', () => {
  it('flags a whole label parked in the number column', () => {
    expect(isCompositeRackNumber('22-B')).toBe(true);
    expect(isCompositeRackNumber('100-A')).toBe(true);
    expect(isCompositeRackNumber('E2E-RACK-1')).toBe(true);
  });

  it('does not flag a legitimate bare number', () => {
    expect(isCompositeRackNumber('22')).toBe(false);
    expect(isCompositeRackNumber('Z9')).toBe(false);
    expect(isCompositeRackNumber('')).toBe(false);
    expect(isCompositeRackNumber(null)).toBe(false);
    expect(isCompositeRackNumber(undefined)).toBe(false);
  });
});

describe('normalizeRackFields', () => {
  it('splits a full label typed into the number field', () => {
    expect(normalizeRackFields({ number: '22-B' })).toEqual({ number: '22', row: 'B' });
    expect(normalizeRackFields({ number: '22-B', row: null })).toEqual({ number: '22', row: 'B' });
    expect(normalizeRackFields({ number: '22-B', row: '' })).toEqual({ number: '22', row: 'B' });
  });

  it('leaves an already-decomposed pair alone', () => {
    expect(normalizeRackFields({ number: '22', row: 'B' })).toEqual({ number: '22', row: 'B' });
  });

  it('trusts an explicit row over splitting a dashed rack name', () => {
    expect(normalizeRackFields({ number: 'E2E-RACK', row: '1' })).toEqual({
      number: 'E2E-RACK',
      row: '1',
    });
  });

  it('drops a duplicated row when the user typed the label AND picked the row', () => {
    expect(normalizeRackFields({ number: '22-B', row: 'B' })).toEqual({ number: '22', row: 'B' });
    expect(normalizeRackFields({ number: '22-b', row: 'B' })).toEqual({ number: '22', row: 'B' });
  });

  it('keeps a number-only rack number-only', () => {
    expect(normalizeRackFields({ number: '20' })).toEqual({ number: '20', row: null });
  });

  it('never returns a composite number', () => {
    for (const input of [
      { number: '22-B' },
      { number: '100-A', row: '' },
      { number: '3-C', row: null },
      { number: ' 22 - B ' },
    ]) {
      expect(isCompositeRackNumber(normalizeRackFields(input).number)).toBe(false);
    }
  });
});
