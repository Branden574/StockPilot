import { describe, expect, it } from 'vitest';

import { describeNewRackPlacement, findRackNearMatches } from './rack-near-match';

/**
 * The real warehouse from the 2026-07-23 incident (org
 * 63c13e64-92a6-4ea4-9936-6a2c26a85b4a). "100-A" is the lone rack in the 100
 * range; every other rack is a low number with an A/B/C row. The rule is tuned
 * against these actual names, not invented ones.
 */
const REAL_LABELS = [
  '1-A', '1-C', '2-A', '2-C', '3-A', '3-C', '4-C',
  '15-A', '16-A', '16-B', '17-A', '17-B', '18-A', '19-A', '20', '20-A',
  '21-A', '22-A', '22-B', '22-C', '35', '35-A', '35-B', '36-A', '36-C',
  '37-B', '37-C', '38-B', '38-C', '39-A', '39-B', '39-C', '40-A', '40-B',
  '40-C', '41-C', '42-B', '42-C', '43-B', '43-C', '44-A', '46-A',
];

describe('findRackNearMatches — existence', () => {
  it('reports an exact label as existing, with no suggestions', () => {
    const r = findRackNearMatches('22-B', REAL_LABELS);
    expect(r.exists).toBe(true);
    expect(r.matchedLabel).toBe('22-B');
    expect(r.suggestions).toEqual([]);
  });

  it('matches case-insensitively and tolerant of whitespace', () => {
    expect(findRackNearMatches('22-b ', REAL_LABELS).exists).toBe(true);
    expect(findRackNearMatches('  22 - B', REAL_LABELS).exists).toBe(true);
    expect(findRackNearMatches('37-c', REAL_LABELS).matchedLabel).toBe('37-C');
  });

  it('a number-only rack matches its bare number', () => {
    expect(findRackNearMatches('35', REAL_LABELS).exists).toBe(true);
    expect(findRackNearMatches(' 20 ', REAL_LABELS).exists).toBe(true);
  });

  it('an empty label neither exists nor suggests', () => {
    const r = findRackNearMatches('   ', REAL_LABELS);
    expect(r.exists).toBe(false);
    expect(r.suggestions).toEqual([]);
  });
});

describe('findRackNearMatches — the incident', () => {
  it('surfaces 1-A and 10-A for a slipped "100-A"', () => {
    // 10-A does not exist in the real org, so add it for the exact case the
    // task calls out: typing "100-A" where BOTH 1-A and 10-A exist.
    const r = findRackNearMatches('100-A', ['1-A', '10-A', ...REAL_LABELS]);
    expect(r.exists).toBe(false);
    expect(r.suggestions).toContain('10-A');
    expect(r.suggestions).toContain('1-A');
    // The single-edit "10-A" ranks ahead of the two-edit "1-A".
    expect(r.suggestions.indexOf('10-A')).toBeLessThan(r.suggestions.indexOf('1-A'));
  });

  it('against the REAL labels alone, "100-A" still points at 1-A', () => {
    const r = findRackNearMatches('100-A', REAL_LABELS);
    expect(r.suggestions).toContain('1-A');
    // The digit-soup neighbours that share no run with "100" are NOT offered.
    expect(r.suggestions).not.toContain('40-A');
    expect(r.suggestions).not.toContain('20-A');
  });
});

describe('findRackNearMatches — typo shapes', () => {
  it('wrong row letter surfaces the same number with other rows', () => {
    const r = findRackNearMatches('22-D', REAL_LABELS);
    expect(r.exists).toBe(false);
    expect(r.suggestions).toEqual(expect.arrayContaining(['22-A', '22-B', '22-C']));
  });

  it('a transposed digit is a single edit', () => {
    // "12-A" is not a rack; "21-A" is. One adjacent swap. Controlled label set,
    // because in a dense range many numbers sit one substitution from "12".
    const r = findRackNearMatches('12-A', ['21-A', '99-C']);
    expect(r.suggestions).toEqual(['21-A']);
  });

  it('one wrong digit surfaces the same-row neighbour and drops the unrelated', () => {
    const r = findRackNearMatches('47-A', ['46-A', '12-C']);
    // 46-A is one digit off in the same row; 12-C shares nothing.
    expect(r.suggestions).toEqual(['46-A']);
  });

  it('caps the number of suggestions', () => {
    const r = findRackNearMatches('22-D', REAL_LABELS, { limit: 2 });
    expect(r.suggestions.length).toBeLessThanOrEqual(2);
  });

  it('a genuinely unrelated label offers nothing misleading', () => {
    const r = findRackNearMatches('88-Z', REAL_LABELS);
    expect(r.exists).toBe(false);
    // No existing number is within one edit of "88" with a matching-ish row.
    expect(r.suggestions).toEqual([]);
  });
});

describe('describeNewRackPlacement — shared copy', () => {
  it('returns exists=true and empty copy when the destination already exists', () => {
    const d = describeNewRackPlacement({
      label: '22-b',
      warehouseName: 'Main',
      quantity: 5,
      existingLabels: REAL_LABELS,
    });
    expect(d.exists).toBe(true);
    expect(d.matchedLabel).toBe('22-B');
    expect(d.message).toBe('');
  });

  it('states the rack, warehouse, unit count and the near-match, in one sentence', () => {
    const d = describeNewRackPlacement({
      label: '100-A',
      warehouseName: 'Main Warehouse',
      quantity: 242,
      existingLabels: REAL_LABELS,
    });
    expect(d.exists).toBe(false);
    expect(d.title).toBe('Create new rack 100-A?');
    expect(d.message).toContain('100-A does not exist in Main Warehouse yet');
    expect(d.message).toContain('242 units');
    expect(d.message).toContain('Did you mean');
    expect(d.message).toContain('1-A');
    expect(d.suggestions).toContain('1-A');
  });

  it('singularises a one-unit placement and omits an absent warehouse name', () => {
    const d = describeNewRackPlacement({
      label: '77-A',
      quantity: 1,
      existingLabels: REAL_LABELS,
    });
    expect(d.message).toContain('1 unit into it');
    expect(d.message).not.toContain('1 units');
    expect(d.message).not.toContain(' in  yet');
    expect(d.message).toContain('77-A does not exist yet');
  });

  it('uses the crate noun when asked', () => {
    const d = describeNewRackPlacement({
      label: 'Blue #42',
      quantity: 3,
      existingLabels: [],
      noun: 'crate',
    });
    expect(d.title).toBe('Create new crate Blue #42?');
  });
});
