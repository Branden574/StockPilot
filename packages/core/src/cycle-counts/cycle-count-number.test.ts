import { describe, expect, it } from 'vitest';

import {
  CYCLE_COUNT_REFERENCE_UNAVAILABLE,
  CYCLE_COUNT_SEARCH_MAX_LENGTH,
  cycleCountReferenceLabel,
  formatCycleCountNumber,
  normalizeCycleCountSearch,
  parseCycleCountSearch,
} from './cycle-count-number';

describe('formatCycleCountNumber', () => {
  it('pads to six digits with the CC- prefix', () => {
    expect(formatCycleCountNumber(1)).toBe('CC-000001');
    expect(formatCycleCountNumber(42)).toBe('CC-000042');
    expect(formatCycleCountNumber(999999)).toBe('CC-999999');
  });

  it('keeps every digit past six instead of truncating', () => {
    expect(formatCycleCountNumber(1000000)).toBe('CC-1000000');
    expect(formatCycleCountNumber(123456789012)).toBe('CC-123456789012');
  });

  it('accepts a digit string (a bigint that arrived as text)', () => {
    expect(formatCycleCountNumber('42')).toBe('CC-000042');
  });

  it('returns null for anything that is not a positive whole number', () => {
    for (const bad of [null, undefined, 0, -3, 1.5, Number.NaN, Infinity, '', 'abc', '4a', '-2']) {
      expect(formatCycleCountNumber(bad as never)).toBeNull();
    }
    expect(formatCycleCountNumber(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });
});

describe('cycleCountReferenceLabel', () => {
  it('shows the reference, or the truthful fallback, never a made-up number', () => {
    expect(cycleCountReferenceLabel(7)).toBe('CC-000007');
    expect(cycleCountReferenceLabel(null)).toBe(CYCLE_COUNT_REFERENCE_UNAVAILABLE);
    expect(cycleCountReferenceLabel(undefined)).toBe('Reference unavailable');
  });
});

describe('parseCycleCountSearch', () => {
  it('reads every supported form of a reference as the same exact number', () => {
    for (const q of ['CC-000042', 'cc-000042', 'CC-42', '000042', '42', ' CC-42 ', 'cc42', 'CC 42', '#42', 'CC-#42']) {
      expect(parseCycleCountSearch(q)).toMatchObject({ kind: 'number', number: 42 });
    }
  });

  it('folds full-width input and pasted dashes', () => {
    expect(parseCycleCountSearch('ＣＣ－００００４２')).toMatchObject({ kind: 'number', number: 42 });
    expect(parseCycleCountSearch('CC–42')).toMatchObject({ kind: 'number', number: 42 });
    expect(parseCycleCountSearch('CC−42')).toMatchObject({ kind: 'number', number: 42 });
  });

  it('ignores invisible characters a paste carries along', () => {
    for (const q of ['CC-000042\u200B', '\u200ECC-000042', 'CC-000042\u2060', 'CC\u00AD-42', '\uFEFF42']) {
      expect(parseCycleCountSearch(q)).toMatchObject({ kind: 'number', number: 42 });
    }
  });

  it('keeps numbers above six digits intact', () => {
    expect(parseCycleCountSearch('CC-1234567')).toMatchObject({ kind: 'number', number: 1234567 });
  });

  it('treats a reference that cannot exist as a lookup that matches nothing', () => {
    expect(parseCycleCountSearch('0')).toMatchObject({ kind: 'number', number: 0 });
    expect(parseCycleCountSearch('CC-000000')).toMatchObject({ kind: 'number', number: 0 });
    expect(parseCycleCountSearch('9'.repeat(16))).toMatchObject({ kind: 'number', number: 0 });
  });

  it('treats blank input as no search', () => {
    for (const q of [null, undefined, '', '   ', '\t\n']) {
      expect(parseCycleCountSearch(q)).toEqual({ kind: 'all' });
    }
  });

  it('treats everything else as literal text', () => {
    expect(parseCycleCountSearch('Main warehouse')).toEqual({ kind: 'text', text: 'Main warehouse' });
    expect(parseCycleCountSearch('42 boxes')).toEqual({ kind: 'text', text: '42 boxes' });
    expect(parseCycleCountSearch('CC')).toEqual({ kind: 'text', text: 'CC' });
    expect(parseCycleCountSearch('CC-42-1')).toEqual({ kind: 'text', text: 'CC-42-1' });
  });

  it('passes punctuation through untouched for the server to match literally', () => {
    for (const q of ['50% off', 'SKU_1', "O'Brien", '"quoted"', '(a,b)', 'a.b:c', 'x\\y', '*']) {
      expect(parseCycleCountSearch(q)).toEqual({ kind: 'text', text: q });
    }
  });

  it('caps the length without splitting a character', () => {
    const long = '🧮'.repeat(CYCLE_COUNT_SEARCH_MAX_LENGTH + 20);
    const parsed = parseCycleCountSearch(long);
    expect(parsed.kind).toBe('text');
    if (parsed.kind === 'text') {
      expect(Array.from(parsed.text)).toHaveLength(CYCLE_COUNT_SEARCH_MAX_LENGTH);
      expect(parsed.text).toBe('🧮'.repeat(CYCLE_COUNT_SEARCH_MAX_LENGTH));
    }
  });
});

describe('normalizeCycleCountSearch', () => {
  it('collapses whitespace and strips control characters', () => {
    expect(normalizeCycleCountSearch('  main\u0000  \n warehouse ')).toBe('main warehouse');
  });
});
