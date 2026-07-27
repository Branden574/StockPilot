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

/**
 * Split on UNESCAPED occurrences of `delim`, leaving the escape sequences in
 * the returned segments (so a second pass can split on the other delimiter).
 * Deliberately written from scratch here rather than imported: a round-trip
 * test that reuses the production splitter would pass even if both sides were
 * wrong together.
 */
function splitUnescaped(s: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (ch === '\\') {
      cur += ch + (s[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (ch === delim) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function unescapeSlot(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

/** The same normalization the builders apply, so tests can predict the slots. */
function norm(v: string | null | undefined): string {
  if (v == null) return '';
  return v.toLowerCase().replace(/\s+/g, ' ').trim();
}

describe('key escaping — delimiter injection', () => {
  it('does NOT let a delimiter inside a size forge another variant slot', () => {
    // Proven collision before the fix: both produced 'size=10|width=w'.
    const forged = buildVariantKey({ size: '10|width=w' });
    const real = buildVariantKey({ size: '10', width: 'w' });
    expect(forged).not.toBe(real);
    expect(real).toBe('size=10|width=w');
    expect(forged).toBe('size=10\\|width\\=w');
  });

  it('does NOT let a pipe inside a team shift the jersey group slots', () => {
    // Proven collision before the fix: both produced 'jerseys|a|b|||||||'.
    const forged = buildGroupKey({ subcategoryKey: 'jerseys', team: 'a|b' });
    const real = buildGroupKey({ subcategoryKey: 'jerseys', team: 'a', league: 'b' });
    expect(forged).not.toBe(real);
    // 9 fields: the subcategory plus the 8 jersey slots.
    expect(real).toBe('jerseys|a|b||||||');
    expect(forged).toBe('jerseys|a\\|b|||||||');
  });

  it('escapes the escape character itself, so a literal backslash cannot forge one', () => {
    // 'x\|y' typed literally must not decode as the delimiter.
    const forged = buildVariantKey({ size: 'x\\|y' });
    const real = buildVariantKey({ size: 'x\\', width: 'y' });
    expect(forged).not.toBe(real);
    expect(splitUnescaped(forged, '|')).toHaveLength(1);
    expect(splitUnescaped(real, '|')).toHaveLength(2);
  });

  it('leaves clean values byte-identical (existing keys stay stable)', () => {
    expect(buildVariantKey({ size: '10.5', sizeSystem: 'US_MENS' })).toBe(
      'size=10.5|system=us_mens',
    );
    expect(
      buildGroupKey({
        subcategoryKey: 'shoes',
        brand: 'Nike',
        model: 'Pegasus 41',
        styleNumber: 'FD2722',
        colorway: 'Black/White',
      }),
    ).toBe('shoes|nike|pegasus 41|fd2722|black/white');
  });

  it('round-trips every nasty value back out of a variant key', () => {
    for (const v of ['10|W', 'a=b', 'x\\y', '\\', '|', '=', 'a|b=c\\d', 'plain 10']) {
      const key = buildVariantKey({ size: v, width: 'D' });
      const [sizePair, widthPair] = splitUnescaped(key, '|');
      const [sizeName, sizeValue] = splitUnescaped(sizePair!, '=');
      expect(unescapeSlot(sizeName!)).toBe('size');
      expect(unescapeSlot(sizeValue!)).toBe(norm(v));
      expect(unescapeSlot(widthPair!)).toBe('width=d');
    }
  });

  it('round-trips every nasty value back out of a group key', () => {
    for (const v of ['10|W', 'a=b', 'x\\y', '\\', '|', '=', 'a|b=c\\d', 'plain']) {
      const parts = splitUnescaped(
        buildGroupKey({ subcategoryKey: 'shoes', brand: v, model: 'M' }),
        '|',
      );
      expect(parts).toHaveLength(5);
      expect(unescapeSlot(parts[0]!)).toBe('shoes');
      expect(unescapeSlot(parts[1]!)).toBe(norm(v));
      expect(unescapeSlot(parts[2]!)).toBe('m');
    }
  });

  it('is injective: distinct variant tuples NEVER share a key', () => {
    const nasty = ['10|W', 'a=b', 'x\\y', '\\|', '', null, '10', 'W'];
    const seen = new Map<string, string>();
    for (const size of nasty) {
      for (const width of nasty) {
        for (const fit of nasty) {
          const key = buildVariantKey({ size, width, fit });
          // '' and null both mean ABSENT, so compare on the normalized tuple.
          const canonical = JSON.stringify([norm(size), norm(width), norm(fit)]);
          const prior = seen.get(key);
          if (prior !== undefined) expect(prior).toBe(canonical);
          seen.set(key, canonical);
        }
      }
    }
    // 8 values over 3 slots, minus the '' / null pairs that mean the same
    // absent slot: 7^3 distinct tuples must yield 7^3 distinct keys.
    expect(new Set(seen.values()).size).toBe(343);
    expect(seen.size).toBe(343);
  });

  it('is injective: distinct group tuples NEVER share a key', () => {
    const nasty = ['a|b', 'a', 'b', 'x=y', 'x\\y', '', null];
    const seen = new Map<string, string>();
    for (const team of nasty) {
      for (const league of nasty) {
        for (const season of nasty) {
          const key = buildGroupKey({
            subcategoryKey: 'jerseys',
            team,
            league,
            season,
          });
          const canonical = JSON.stringify([norm(team), norm(league), norm(season)]);
          const prior = seen.get(key);
          if (prior !== undefined) expect(prior).toBe(canonical);
          seen.set(key, canonical);
        }
      }
    }
    // 7 values, one of which ('' / null) duplicates: 6^3 distinct tuples.
    expect(seen.size).toBe(216);
  });

  it('cannot forge the name-fallback key from a real attribute', () => {
    const fallback = buildGroupKey({ subcategoryKey: 'balls', name: 'Practice Ball' });
    expect(fallback).toBe('balls|name:practice ball');
    // A brand that spells the fallback still lands in the brand slot.
    expect(buildGroupKey({ subcategoryKey: 'balls', brand: 'name:practice ball' })).not.toBe(
      fallback,
    );
    // A subcategory carrying a pipe cannot reach across into the name slot.
    expect(buildGroupKey({ subcategoryKey: 'balls|name:x', name: 'y' })).not.toBe(
      buildGroupKey({ subcategoryKey: 'balls', name: 'x|name:y' }),
    );
  });
});

describe('groupRollupLabel', () => {
  it('renders the counting unit as the requirements phrase it', () => {
    expect(groupRollupLabel(6, 52, 'pairs')).toBe('6 variants · 52 pairs total');
    expect(groupRollupLabel(1, 3, 'each')).toBe('1 variant · 3 each total');
  });
});
