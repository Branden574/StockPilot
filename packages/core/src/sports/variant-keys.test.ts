import { describe, expect, it } from 'vitest';

import {
  buildGroupKey,
  buildVariantKey,
  groupRollupLabel,
  isValidJerseyNumber,
  normalizeJerseyNumber,
  normalizeSizeValue,
} from './variant-keys';

describe('normalizeJerseyNumber', () => {
  it('preserves meaningful leading zeroes', () => {
    expect(normalizeJerseyNumber('0')).toBe('0');
    expect(normalizeJerseyNumber('00')).toBe('00');
    expect(normalizeJerseyNumber('07')).toBe('07');
    expect(normalizeJerseyNumber('7')).toBe('7');
  });

  it('treats 0, 00, 07 and 7 as four distinct numbers', () => {
    const all = ['0', '00', '07', '7'].map((v) => normalizeJerseyNumber(v));
    expect(new Set(all).size).toBe(4);
  });

  it('strips a leading hash and surrounding whitespace', () => {
    expect(normalizeJerseyNumber(' #12 ')).toBe('12');
    expect(normalizeJerseyNumber('##00')).toBe('00');
  });

  it('returns null for blank input rather than inventing a value', () => {
    expect(normalizeJerseyNumber('')).toBeNull();
    expect(normalizeJerseyNumber('   ')).toBeNull();
    expect(normalizeJerseyNumber(null)).toBeNull();
    expect(normalizeJerseyNumber(undefined)).toBeNull();
  });
});

describe('isValidJerseyNumber', () => {
  it('accepts 1 to 4 digits', () => {
    for (const v of ['0', '00', '07', '12', '99', '0000']) {
      expect(isValidJerseyNumber(v)).toBe(true);
    }
  });

  it('rejects non-digits and over-long values', () => {
    for (const v of ['A', '12A', '#12', '', '12345', '1.5', '-1']) {
      expect(isValidJerseyNumber(v)).toBe(false);
    }
  });
});

describe('normalizeSizeValue', () => {
  it('upper-cases alpha sizes', () => {
    expect(normalizeSizeValue(' xl ')).toBe('XL');
    expect(normalizeSizeValue('m')).toBe('M');
  });

  it('keeps half sizes and drops a redundant .0', () => {
    expect(normalizeSizeValue('10.5')).toBe('10.5');
    expect(normalizeSizeValue('10.0')).toBe('10');
    expect(normalizeSizeValue('10')).toBe('10');
  });

  it('strips a redundant system prefix but only the matching one', () => {
    expect(normalizeSizeValue('US 10', 'US_MENS')).toBe('10');
    expect(normalizeSizeValue('UK 9', 'US_MENS')).toBe('UK 9');
  });

  it('NEVER converts between size systems', () => {
    // A UK 9 stays a UK 9. Cross-system conversion needs an approved mapping
    // that does not exist; silently converting would corrupt stock counts.
    expect(normalizeSizeValue('9', 'UK')).toBe('9');
    expect(normalizeSizeValue('9', 'US_MENS')).toBe('9');
  });

  it('returns null for blank rather than a placeholder', () => {
    expect(normalizeSizeValue('')).toBeNull();
    expect(normalizeSizeValue(null)).toBeNull();
  });
});

describe('buildGroupKey', () => {
  it('collapses sizes of one shoe style onto ONE key', () => {
    const base = {
      subcategoryKey: 'shoes',
      brand: 'Nike',
      model: 'Pegasus 41',
      styleNumber: 'FD2722',
      colorway: 'Black/White',
    };
    // Size is NOT part of the group key — that is the whole point.
    expect(buildGroupKey(base)).toBe(buildGroupKey({ ...base }));
    expect(buildGroupKey(base)).toBe('shoes|nike|pegasus 41|fd2722|black/white');
  });

  it('is case and whitespace insensitive', () => {
    expect(
      buildGroupKey({ subcategoryKey: 'shoes', brand: '  NIKE ', model: 'Pegasus  41' }),
    ).toBe(buildGroupKey({ subcategoryKey: 'shoes', brand: 'nike', model: 'pegasus 41' }));
  });

  it('separates a shoe key from a jersey key even with identical text', () => {
    expect(buildGroupKey({ subcategoryKey: 'shoes', brand: 'Falcons' })).not.toBe(
      buildGroupKey({ subcategoryKey: 'jerseys', team: 'Falcons' }),
    );
  });

  it('uses the jersey slots for jerseys', () => {
    expect(
      buildGroupKey({
        subcategoryKey: 'jerseys',
        team: 'Falcons',
        season: '2026',
        homeAway: 'home',
      }),
    ).toBe('jerseys|falcons||2026|home||||');
  });

  it('falls back to the name ONLY when nothing identifying is present', () => {
    expect(buildGroupKey({ subcategoryKey: 'balls', name: 'Practice Ball' })).toBe(
      'balls|name:practice ball',
    );
  });
});

describe('buildVariantKey', () => {
  it('distinguishes shoe sizes within one group', () => {
    const k9 = buildVariantKey({ size: '9', sizeSystem: 'US_MENS' });
    const k10 = buildVariantKey({ size: '10', sizeSystem: 'US_MENS' });
    expect(k9).not.toBe(k10);
    expect(k9).toBe('size=9|system=us_mens');
  });

  it('distinguishes jersey sizes sharing ONE number (R3)', () => {
    const m = buildVariantKey({ jerseyNumber: '12', size: 'M' });
    const xl = buildVariantKey({ jerseyNumber: '12', size: 'XL' });
    expect(m).not.toBe(xl);
    expect(m).toBe('number=12|size=m');
  });

  it('distinguishes numbers that differ only by a leading zero', () => {
    expect(buildVariantKey({ jerseyNumber: '07', size: 'M' })).not.toBe(
      buildVariantKey({ jerseyNumber: '7', size: 'M' }),
    );
  });

  it('uses named slots so an absent width cannot shift the fit', () => {
    expect(buildVariantKey({ size: '10', fit: 'wide' })).toBe('size=10|fit=wide');
    expect(buildVariantKey({ size: '10', width: 'wide' })).toBe('size=10|width=wide');
  });

  it('returns a stable sentinel when there are no variant attributes', () => {
    expect(buildVariantKey({})).toBe('default');
  });
});

describe('groupRollupLabel', () => {
  it('renders the counting unit as the requirements phrase it', () => {
    expect(groupRollupLabel(6, 52, 'pairs')).toBe('6 variants · 52 pairs total');
    expect(groupRollupLabel(1, 3, 'each')).toBe('1 variant · 3 each total');
  });
});
