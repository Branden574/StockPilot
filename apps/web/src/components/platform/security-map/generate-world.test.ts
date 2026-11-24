// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BUDGET_GZIP_BYTES,
  DOT_STEP,
  FALLBACK_POINTS,
  HAND_ONLY_CODES,
  ISO_3166_ALPHA2,
  OUTLINE_SHA256,
  OUTPUT_FILES,
  REPO_ROOT,
  countryCodeOf,
  countryPoints,
  dotRows,
  generateWorld,
  gzipBytes,
  insidePointOf,
  landBits,
  polygonContains,
  readOutline,
  ringContains,
  sha256,
  type Position,
} from '../../../../../../scripts/security-map/generate-world.mjs';

import { COUNTRY_POINTS, COUNTRY_POINTS_FROM_FALLBACK } from './country-points';
import { decodeLand } from './world-geometry';
import { WORLD_DOTS } from './world-dots';

/**
 * The generator of the attack map's two data files, on a tiny made-up
 * outline, and the two committed files it made from Natural Earth.
 *
 * The raw outline is not in the repository. The byte-for-byte regeneration
 * test runs only where it is on disk, named by SECURITY_MAP_OUTLINE (a path to
 * ne_110m_admin_0_countries.geojson); without it that one test is skipped and
 * says so in its name.
 */

/** ISO 3166-1 alpha-2, every code (249), held here apart from the generator's own copy. */
const ISO_CODES =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(
    ' ',
  );

const square = (west: number, south: number, east: number, north: number): Position[] => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
  [west, south],
];

/** A U: two uprights joined at the bottom, so its centre falls in the gap. */
const U_SHAPE: Position[] = [
  [80, -10],
  [100, -10],
  [100, 10],
  [95, 10],
  [95, -5],
  [85, -5],
  [85, 10],
  [80, 10],
  [80, -10],
];

/** A made-up outline: names that look like markup, codes of every kind the real file has. */
function fixture(): string {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { ISO_A2: 'ZA', ISO_A2_EH: 'ZA', NAME: '<script>alert(1)</script>' },
        geometry: {
          type: 'Polygon',
          // Land from -40 to 40 east, -30 to 30 north, with a hole from -20 to -10 east.
          coordinates: [square(-40, -30, 40, 30), square(-20, -20, -10, 20)],
        },
      },
      {
        type: 'Feature',
        properties: { ISO_A2: '-99', ISO_A2_EH: 'NO', NAME: 'Made-up north' },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [[square(100, 60, 110, 70)], [square(125, 60, 155, 80)]],
        },
      },
      {
        type: 'Feature',
        properties: { ISO_A2: 'CN-TW', ISO_A2_EH: '-99', NAME: 'No code at all' },
        geometry: { type: 'Polygon', coordinates: [square(-100, -50, -90, -40)] },
      },
      {
        type: 'Feature',
        properties: { ISO_A2: '-99', ISO_A2_EH: 'XK', NAME: 'Outside the list' },
        geometry: { type: 'Polygon', coordinates: [square(-170, 10, -160, 20)] },
      },
      {
        type: 'Feature',
        properties: { ISO_A2: 'US', ISO_A2_EH: 'US', NAME: 'U shape' },
        geometry: { type: 'Polygon', coordinates: [U_SHAPE] },
      },
    ],
  });
}

const CODES = ['NO', 'SG', 'US', 'ZA'];
const FALLBACK = { SG: [103.8, 1.35] as const };

describe('reading the outline', () => {
  it('keeps a code and polygons only; the code is ISO_A2_EH, else ISO_A2, else none', () => {
    const outline = readOutline(fixture());
    expect(outline.map((f) => f.code)).toEqual(['ZA', 'NO', null, 'XK', 'US']);
    expect(Object.keys(outline[0]!).sort()).toEqual(['code', 'polygons']);
    expect(outline[1]!.polygons).toHaveLength(2);
    expect(countryCodeOf({ ISO_A2: '-99', ISO_A2_EH: 'FR' })).toBe('FR');
    expect(countryCodeOf({ ISO_A2: 'DE', ISO_A2_EH: '-99' })).toBe('DE');
    expect(countryCodeOf({ ISO_A2: 'CN-TW', ISO_A2_EH: 'TW' })).toBe('TW');
    // Both well formed and different: ISO_A2_EH is the one kept.
    expect(countryCodeOf({ ISO_A2: 'AA', ISO_A2_EH: 'BB' })).toBe('BB');
    expect(countryCodeOf({ ISO_A2: 'de', ISO_A2_EH: '<b>' })).toBeNull();
    expect(countryCodeOf(null)).toBeNull();
  });

  it('refuses anything that is not a collection of polygons in range', () => {
    const bad = [
      '[]',
      JSON.stringify({ type: 'Feature' }),
      JSON.stringify({ type: 'FeatureCollection', features: [] }),
      JSON.stringify({
        type: 'FeatureCollection',
        features: [{ properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } }],
      }),
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          { properties: {}, geometry: { type: 'Polygon', coordinates: [square(0, 0, 200, 1)] } },
        ],
      }),
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            properties: {},
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [0, 0],
                  [1, 1],
                  ['x', 0],
                  [0, 0],
                ],
              ],
            },
          },
        ],
      }),
    ];
    for (const text of bad) expect(() => readOutline(text), text).toThrow();
  });
});

describe('inside and outside', () => {
  it('a point in a hole is not inside; one on land is', () => {
    const polygon = [square(-40, -30, 40, 30), square(-20, -20, -10, 20)];
    expect(ringContains(polygon[0]!, 0, 0)).toBe(true);
    expect(polygonContains(polygon, 0, 0)).toBe(true);
    expect(polygonContains(polygon, -15, 0)).toBe(false);
    expect(polygonContains(polygon, 50, 0)).toBe(false);
  });

  it('a U shape: its centre is in the gap, so the point is the middle of the widest stretch of land', () => {
    const found = insidePointOf([U_SHAPE]);
    expect(found?.how).toBe('widest stretch');
    expect(polygonContains([U_SHAPE], found!.point[0], found!.point[1])).toBe(true);
    // A plain square's point is its centre.
    expect(insidePointOf([square(0, 0, 10, 10)])).toEqual({ point: [5, 5], how: 'centre' });
  });
});

describe('the grid of dots', () => {
  it('rows are as tall as a step; a row has as many cells as fit around the world at its latitude', () => {
    expect(dotRows(30)).toEqual([
      { lat: 75, cells: 3 },
      { lat: 45, cells: 8 },
      { lat: 15, cells: 12 },
      { lat: -15, cells: 12 },
      { lat: -45, cells: 8 },
      { lat: -75, cells: 3 },
    ]);
    expect(() => dotRows(7)).toThrow('the step must divide 180');
  });

  it('a cell is land when its centre is inside a country and in no hole, one bit per cell, most significant first', () => {
    const dots = landBits(readOutline(fixture()), 30);
    expect(dots.rows).toBe(6);
    expect(dots.cells).toBe(46);
    // Rows at 15 and -15 north: cells at -15 (in the hole) and 15 east of the
    // first country; only 15 is land (indexes 17 and 29). The code outside the
    // list is land too (-165 east, 15 north: index 11). The U and the squares
    // at 60 to 80 north hold no cell centre.
    const set = [...Array(dots.cells).keys()].filter(
      (i) => (dots.bytes[i >> 3]! & (0x80 >> (i & 7))) !== 0,
    );
    expect(set).toEqual([11, 17, 29]);
    expect(dots.count).toBe(3);
  });
});

describe('the points', () => {
  it('the largest polygon of a country; the fallback table where the outline has no code; no point outside the list', () => {
    const result = countryPoints(readOutline(fixture()), CODES, FALLBACK);
    expect(result.points).toEqual({
      NO: [140, 70],
      SG: [103.8, 1.4],
      US: [expect.any(Number), expect.any(Number)],
      ZA: [0, 0],
    });
    expect(result.how).toMatchObject({
      NO: 'centre',
      SG: 'fallback table',
      US: 'widest stretch',
      ZA: 'centre',
    });
    expect(result.fromFallback).toEqual(['SG']);
    expect(result.notInList).toEqual(['XK']);
    expect(result.withoutCode).toBe(1);
  });

  it('refuses a code with no point, a code in both places, a code twice, a table entry that is not a code', () => {
    const outline = readOutline(fixture());
    expect(() => countryPoints(outline, CODES, {})).toThrow('SG: no point');
    expect(() => countryPoints(outline, CODES, { ...FALLBACK, ZA: [1, 1] })).toThrow(
      'ZA: in the outline and in the fallback table',
    );
    expect(() => countryPoints(outline, [...CODES], { ...FALLBACK, QQ: [1, 1] })).toThrow(
      'QQ: in the fallback table and not a code',
    );
    const twice = [...outline, { code: 'ZA', polygons: outline[0]!.polygons }];
    expect(() => countryPoints(twice, CODES, FALLBACK)).toThrow('ZA: twice in the outline');
  });

  it("a hand-only code outside the list: the hand-written point, never the outline's", () => {
    const outline = readOutline(fixture());
    const result = countryPoints(outline, CODES, { ...FALLBACK, XK: [20.9, 42.6] }, ['XK']);
    // The outline's square for XK stands at -165 east, 15 north: not used.
    expect(result.points.XK).toEqual([20.9, 42.6]);
    expect(result.how.XK).toBe('fallback table');
    expect(result.fromFallback).toEqual(['SG', 'XK']);
    expect(result.notInList).toEqual([]);
    expect(Object.keys(result.points)).toEqual(['NO', 'SG', 'US', 'XK', 'ZA']);
    expect(() => countryPoints(outline, CODES, FALLBACK, ['XK'])).toThrow('XK: no point');
    expect(() => countryPoints(outline, CODES, { ...FALLBACK, ZA: [1, 1] }, ['ZA'])).toThrow(
      'ZA: in the list and in the hand-only list',
    );
  });
});

describe('the two files from the made-up outline', () => {
  it('hold numbers and codes only: no text from the outline reaches them', () => {
    const made = generateWorld(fixture(), {
      step: 30,
      codes: CODES,
      fallback: FALLBACK,
      handOnly: [],
    });
    for (const text of [made.worldDots, made.countryPoints]) {
      expect(text).not.toMatch(/<script>|alert\(1\)|Made-up|No code|Outside the list|U shape/);
    }
    expect(made.worldDots).toContain('  step: 30,\n  rows: 6,\n  cells: 46,\n  count: 3,\n');
    expect(made.countryPoints).toContain('  NO: [140, 70],\n');
    expect(made.countryPoints).toContain('  SG: [103.8, 1.4],\n');
    expect(made.countryPoints).toContain(
      "COUNTRY_POINTS_FROM_FALLBACK: readonly string[] = [\n  'SG',\n];",
    );
  });

  it('read back through world-geometry, the dots stand where the generator put them', () => {
    const made = generateWorld(fixture(), {
      step: 30,
      codes: CODES,
      fallback: FALLBACK,
      handOnly: [],
    });
    const land = made.worldDots.match(/land: '([^']*)'/)![1]!;
    const dots = decodeLand({
      source: 'x',
      sha256: 'x',
      step: 30,
      rows: 6,
      cells: 46,
      count: 3,
      land,
    });
    expect([...dots]).toEqual([-165, 15, 15, 15, 15, -15]);
    // A count that does not match the bits is no dots, never dots in the wrong places.
    expect(
      decodeLand({ source: 'x', sha256: 'x', step: 30, rows: 6, cells: 46, count: 4, land }),
    ).toHaveLength(0);
    expect(
      decodeLand({ source: 'x', sha256: 'x', step: 30, rows: 6, cells: 45, count: 3, land }),
    ).toHaveLength(0);
  });
});

describe('the committed files', () => {
  it('every ISO 3166-1 alpha-2 code has a point, and Kosovo (XK); nothing else does', () => {
    expect(ISO_CODES).toHaveLength(249);
    expect(new Set(ISO_CODES).size).toBe(249);
    expect([...ISO_3166_ALPHA2]).toEqual(ISO_CODES);
    expect([...HAND_ONLY_CODES]).toEqual(['XK']);
    expect(Object.keys(COUNTRY_POINTS)).toHaveLength(250);
    expect(Object.keys(COUNTRY_POINTS).sort()).toEqual([...ISO_CODES, 'XK'].sort());
    for (const code of [...ISO_CODES, 'XK']) {
      const [lon, lat] = COUNTRY_POINTS[code]!;
      expect(lon, code).toBeGreaterThanOrEqual(-180);
      expect(lon, code).toBeLessThanOrEqual(180);
      expect(lat, code).toBeGreaterThanOrEqual(-90);
      expect(lat, code).toBeLessThanOrEqual(90);
    }
  });

  it('every code of the list is a real region (the runtime names it)', () => {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    for (const code of [...ISO_CODES, 'XK']) expect(names.of(code), code).not.toBe(code);
  });

  it('the points from the hand-written table are exactly the places the outline lacks', () => {
    expect([...COUNTRY_POINTS_FROM_FALLBACK].sort()).toEqual(Object.keys(FALLBACK_POINTS).sort());
    // Singapore and Hong Kong, common sources of requests, are among them.
    expect(COUNTRY_POINTS_FROM_FALLBACK).toEqual(expect.arrayContaining(['SG', 'HK']));
  });

  it("Kosovo's point is the hand-written one, inside Kosovo", () => {
    expect(COUNTRY_POINTS.XK).toEqual(FALLBACK_POINTS.XK);
    expect(COUNTRY_POINTS_FROM_FALLBACK).toContain('XK');
    const [lon, lat] = COUNTRY_POINTS.XK!;
    expect(lon).toBeGreaterThan(20);
    expect(lon).toBeLessThan(21.8);
    expect(lat).toBeGreaterThan(41.8);
    expect(lat).toBeLessThan(43.3);
  });

  it('the dots read back to their own count, at the generator step', () => {
    expect(WORLD_DOTS.step).toBe(DOT_STEP);
    expect(WORLD_DOTS.sha256).toBe(OUTLINE_SHA256);
    const dots = decodeLand();
    expect(dots.length).toBe(WORLD_DOTS.count * 2);
    expect(WORLD_DOTS.count).toBeGreaterThan(10_000);
  });

  it('both files together are under the budget, compressed', () => {
    const total =
      gzipBytes(readFileSync(join(REPO_ROOT, OUTPUT_FILES.worldDots), 'utf8')) +
      gzipBytes(readFileSync(join(REPO_ROOT, OUTPUT_FILES.countryPoints), 'utf8'));
    expect(total).toBeLessThan(BUDGET_GZIP_BYTES);
  });

  const outline = process.env.SECURITY_MAP_OUTLINE;
  it.skipIf(!outline || !existsSync(outline))(
    'are made again byte for byte from the outline (skipped unless SECURITY_MAP_OUTLINE names the raw file)',
    () => {
      const text = readFileSync(outline as string);
      expect(sha256(text)).toBe(OUTLINE_SHA256);
      const made = generateWorld(text.toString('utf8'));
      expect(made.worldDots).toBe(readFileSync(join(REPO_ROOT, OUTPUT_FILES.worldDots), 'utf8'));
      expect(made.countryPoints).toBe(
        readFileSync(join(REPO_ROOT, OUTPUT_FILES.countryPoints), 'utf8'),
      );
    },
  );
});
