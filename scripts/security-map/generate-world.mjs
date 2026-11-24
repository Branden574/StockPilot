#!/usr/bin/env node
/**
 * The two small data files the platform console's attack map draws from, made
 * from the Natural Earth outline of the world's countries:
 *
 *   apps/web/src/components/platform/security-map/world-dots.ts
 *       the land as a grid of dots (one bit per cell)
 *   apps/web/src/components/platform/security-map/country-points.ts
 *       one point for every ISO 3166-1 two-letter code (249 of them), and for
 *       the codes outside it in HAND_ONLY_CODES (Kosovo's XK)
 *
 *   node scripts/security-map/generate-world.mjs <ne_110m_admin_0_countries.geojson>
 *       writes both files
 *   node scripts/security-map/generate-world.mjs <ne_110m_admin_0_countries.geojson> --check
 *       writes nothing: makes both files again and compares them byte for byte
 *       with the committed ones
 *
 * The input is Natural Earth 1:110m Admin 0 Countries, version 5.1.2, which is
 * public domain (naturalearthdata.com). It is not in this repository; only the
 * two files made from it are. The script refuses any other input file than the
 * one pinned by OUTLINE_SHA256, reads it as JSON and nothing else, and writes
 * into the outputs only numbers it worked out and two-letter codes from the
 * list below: no name or other text from the file reaches them.
 *
 * Plain Node, no package. The point-in-polygon test is this file's own (the
 * even-odd rule over every ring, so a hole is not land).
 *
 * The dots. Rows of cells from the north pole to the south, each STEP degrees
 * of latitude high. Row i stands at latitude 90 - STEP * (i + 0.5) and has
 * round(360 / STEP * cos(latitude)) cells, at least one, so a cell is about
 * the same size on the ground everywhere (the globe shows no crowding at the
 * poles, and the flat map uses an equal-area projection). A cell is land when
 * its centre is inside a country of the outline (Antarctica included).
 *
 * The points. For each code the outline has: the centre of the country's
 * largest polygon when that centre is inside it, otherwise the middle of the
 * widest stretch of land on the centre's latitude. The code is ISO_A2_EH when
 * that is two capital letters, otherwise ISO_A2 (the plain field is -99 for
 * Norway and France in this release and CN-TW for Taiwan; ISO_A2_EH has NO, FR
 * and TW). A feature with no code (N. Cyprus, Somaliland) is land and has no
 * point. A code outside the 249 gets no point (the map counts such events in
 * words and never draws them), unless HAND_ONLY_CODES names it: Kosovo's XK,
 * which is not in ISO 3166-1 but is the code sign-in services give, has its
 * point written by hand, and the outline's shape for it is not used. The
 * places the 1:110m outline leaves out (small islands, Singapore, Hong Kong
 * and others) come from FALLBACK_POINTS, written by hand below; a code of the
 * 249 in both is an error, and so is one with neither.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUTPUT_DIR = 'apps/web/src/components/platform/security-map';
export const OUTPUT_FILES = {
  worldDots: `${OUTPUT_DIR}/world-dots.ts`,
  countryPoints: `${OUTPUT_DIR}/country-points.ts`,
};

/** The one input this script accepts: Natural Earth 1:110m Admin 0 Countries 5.1.2, as GeoJSON. */
export const OUTLINE_SHA256 = '6866c877d39cba9c357620878839b336d569f8c662d3cfab4cb1dbe2d39c977f';
export const OUTLINE_SOURCE =
  'Natural Earth 1:110m Admin 0 Countries, version 5.1.2, public domain (naturalearthdata.com)';
export const COMMAND =
  'node scripts/security-map/generate-world.mjs <path to ne_110m_admin_0_countries.geojson>';

/** Degrees between rows of dots, and between dots along a row (on the ground). */
export const DOT_STEP = 1;

/** Both files together, gzip-compressed, must stay under this. */
export const BUDGET_GZIP_BYTES = 25 * 1024;

/** Every ISO 3166-1 alpha-2 code (249). */
export const ISO_3166_ALPHA2 = Object.freeze(
  (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ ' +
    'BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM ' +
    'DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS ' +
    'GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN ' +
    'KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ ' +
    'MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM ' +
    'PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV ' +
    'SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI ' +
    'VN VU WF WS YE YT ZA ZM ZW'
  ).split(' '),
);

/**
 * The places the 1:110m outline does not have, written by hand: [longitude,
 * latitude] of the place (its main island, or its capital), to one decimal.
 * A group of islands far apart gets its main island.
 */
export const FALLBACK_POINTS = Object.freeze({
  AD: [1.6, 42.5], // Andorra
  AG: [-61.8, 17.1], // Antigua and Barbuda (Antigua)
  AI: [-63.1, 18.2], // Anguilla
  AS: [-170.7, -14.3], // American Samoa (Tutuila)
  AW: [-70.0, 12.5], // Aruba
  AX: [19.9, 60.2], // Aland Islands
  BB: [-59.5, 13.2], // Barbados
  BH: [50.6, 26.0], // Bahrain
  BL: [-62.8, 17.9], // Saint Barthelemy
  BM: [-64.8, 32.3], // Bermuda
  BQ: [-68.3, 12.2], // Bonaire, Sint Eustatius and Saba (Bonaire)
  BV: [3.4, -54.4], // Bouvet Island
  CC: [96.8, -12.2], // Cocos (Keeling) Islands
  CK: [-159.8, -21.2], // Cook Islands (Rarotonga)
  CV: [-23.6, 15.1], // Cabo Verde (Santiago)
  CW: [-69.0, 12.2], // Curacao
  CX: [105.7, -10.5], // Christmas Island
  DM: [-61.4, 15.4], // Dominica
  FM: [158.2, 6.9], // Micronesia (Pohnpei)
  FO: [-6.9, 62.0], // Faroe Islands
  GD: [-61.7, 12.1], // Grenada
  GF: [-53.1, 4.0], // French Guiana
  GG: [-2.6, 49.5], // Guernsey
  GI: [-5.4, 36.1], // Gibraltar
  GP: [-61.6, 16.2], // Guadeloupe
  GS: [-36.6, -54.4], // South Georgia and the South Sandwich Islands (South Georgia)
  GU: [144.8, 13.4], // Guam
  HK: [114.2, 22.3], // Hong Kong
  HM: [73.5, -53.1], // Heard Island and McDonald Islands (Heard Island)
  IM: [-4.5, 54.2], // Isle of Man
  IO: [72.4, -7.3], // British Indian Ocean Territory (Diego Garcia)
  JE: [-2.1, 49.2], // Jersey
  KI: [173.0, 1.4], // Kiribati (Tarawa)
  KM: [43.3, -11.7], // Comoros (Grande Comore)
  KN: [-62.7, 17.3], // Saint Kitts and Nevis (Saint Kitts)
  KY: [-81.3, 19.3], // Cayman Islands (Grand Cayman)
  LC: [-61.0, 13.9], // Saint Lucia
  LI: [9.6, 47.2], // Liechtenstein
  MC: [7.4, 43.7], // Monaco
  MF: [-63.1, 18.1], // Saint Martin (French part)
  MH: [171.4, 7.1], // Marshall Islands (Majuro)
  MO: [113.6, 22.2], // Macao
  MP: [145.8, 15.2], // Northern Mariana Islands (Saipan)
  MQ: [-61.0, 14.6], // Martinique
  MS: [-62.2, 16.7], // Montserrat
  MT: [14.4, 35.9], // Malta
  MU: [57.6, -20.3], // Mauritius
  MV: [73.5, 4.2], // Maldives (Male)
  NF: [168.0, -29.0], // Norfolk Island
  NR: [166.9, -0.5], // Nauru
  NU: [-169.9, -19.1], // Niue
  PF: [-149.4, -17.6], // French Polynesia (Tahiti)
  PM: [-56.3, 46.9], // Saint Pierre and Miquelon
  PN: [-130.1, -25.1], // Pitcairn
  PW: [134.6, 7.5], // Palau
  RE: [55.5, -21.1], // Reunion
  SC: [55.5, -4.6], // Seychelles (Mahe)
  SG: [103.8, 1.4], // Singapore
  SH: [-5.7, -16.0], // Saint Helena, Ascension and Tristan da Cunha (Saint Helena)
  SJ: [15.6, 78.2], // Svalbard and Jan Mayen (Spitsbergen)
  SM: [12.5, 43.9], // San Marino
  ST: [6.6, 0.3], // Sao Tome and Principe (Sao Tome)
  SX: [-63.1, 18.0], // Sint Maarten (Dutch part)
  TC: [-71.8, 21.8], // Turks and Caicos Islands
  TK: [-171.8, -9.2], // Tokelau
  TO: [-175.2, -21.2], // Tonga (Tongatapu)
  TV: [179.2, -8.5], // Tuvalu (Funafuti)
  UM: [166.6, 19.3], // United States Minor Outlying Islands (Wake Island)
  VA: [12.5, 41.9], // Vatican City
  VC: [-61.2, 13.3], // Saint Vincent and the Grenadines (Saint Vincent)
  VG: [-64.6, 18.4], // British Virgin Islands (Tortola)
  VI: [-64.8, 18.3], // United States Virgin Islands (Saint Thomas)
  WF: [-176.2, -13.3], // Wallis and Futuna (Wallis)
  WS: [-172.1, -13.8], // Samoa (Upolu and Savai'i)
  YT: [45.2, -12.8], // Mayotte
  XK: [20.9, 42.6], // Kosovo (the middle of the country; not an ISO 3166-1 code, see HAND_ONLY_CODES)
});

/**
 * Codes outside ISO 3166-1 that the map still places, always at the point
 * written by hand in FALLBACK_POINTS (never one worked out from the outline).
 */
export const HAND_ONLY_CODES = Object.freeze(['XK']);

const CODE_RE = /^[A-Z]{2}$/;

/* ───────────────────────────── reading the outline ───────────────────────────── */

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

function readPosition(p, where) {
  if (!Array.isArray(p) || p.length < 2 || !isFiniteNumber(p[0]) || !isFiniteNumber(p[1])) {
    throw new Error(`${where}: not a position`);
  }
  const [lon, lat] = p;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new Error(`${where}: out of range`);
  return [lon, lat];
}

function readRing(ring, where) {
  if (!Array.isArray(ring) || ring.length < 4) throw new Error(`${where}: not a ring`);
  return ring.map((p, i) => readPosition(p, `${where}.${i}`));
}

function readPolygon(polygon, where) {
  if (!Array.isArray(polygon) || polygon.length < 1) throw new Error(`${where}: not a polygon`);
  return polygon.map((ring, i) => readRing(ring, `${where}.${i}`));
}

/**
 * The outline as a list of { code, polygons }: `code` is a two-letter code or
 * null, `polygons` a list of polygons, each a list of rings (the first the
 * outside, the rest holes), each ring a list of [longitude, latitude]. Only
 * those fields are kept. Anything that is not that shape is an error.
 */
export function readOutline(text) {
  const doc = JSON.parse(text);
  if (doc === null || typeof doc !== 'object' || doc.type !== 'FeatureCollection') {
    throw new Error('not a FeatureCollection');
  }
  if (!Array.isArray(doc.features) || doc.features.length === 0) throw new Error('no features');
  return doc.features.map((feature, i) => {
    const where = `features.${i}`;
    const geometry = feature?.geometry;
    const properties = feature?.properties ?? {};
    let polygons;
    if (geometry?.type === 'Polygon') polygons = [readPolygon(geometry.coordinates, where)];
    else if (geometry?.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
      polygons = geometry.coordinates.map((p, j) => readPolygon(p, `${where}.${j}`));
    } else throw new Error(`${where}: not a Polygon or MultiPolygon`);
    return { code: countryCodeOf(properties), polygons };
  });
}

/** ISO_A2_EH when it is two capital letters, else ISO_A2 when it is, else null. */
export function countryCodeOf(properties) {
  for (const key of ['ISO_A2_EH', 'ISO_A2']) {
    const value = properties?.[key];
    if (typeof value === 'string' && CODE_RE.test(value)) return value;
  }
  return null;
}

/* ───────────────────────────────── geometry ───────────────────────────────── */

/** Whether [lon, lat] is inside the ring, by the even-odd rule (a point on an edge may go either way). */
export function ringContains(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Inside the outside ring and in no hole. */
export function polygonContains(polygon, lon, lat) {
  if (!ringContains(polygon[0], lon, lat)) return false;
  for (let k = 1; k < polygon.length; k += 1) {
    if (ringContains(polygon[k], lon, lat)) return false;
  }
  return true;
}

function boundsOf(ring) {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west, east, south, north };
}

/** The signed area of a ring in square degrees (shoelace), and its centre. */
export function ringAreaAndCentre(ring) {
  let twice = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [x0, y0] = ring[j];
    const [x1, y1] = ring[i];
    const cross = x0 * y1 - x1 * y0;
    twice += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  const area = twice / 2;
  if (area === 0) {
    const b = boundsOf(ring);
    return { area: 0, centre: [(b.west + b.east) / 2, (b.south + b.north) / 2] };
  }
  return { area, centre: [cx / (6 * area), cy / (6 * area)] };
}

/** Where the rings of a polygon cross the latitude `lat`, sorted west to east. */
function crossingsAt(polygon, lat) {
  const xs = [];
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat) xs.push(((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    }
  }
  return xs.sort((a, b) => a - b);
}

/** The middle of the widest stretch inside the polygon along the latitude `lat`, or null. */
function widestSpanMiddle(polygon, lat) {
  const xs = crossingsAt(polygon, lat);
  let best = null;
  for (let k = 0; k + 1 < xs.length; k += 2) {
    const width = xs[k + 1] - xs[k];
    if (width > 0 && (best === null || width > best.width)) {
      best = { width, lon: (xs[k] + xs[k + 1]) / 2 };
    }
  }
  return best && polygonContains(polygon, best.lon, lat) ? [best.lon, lat] : null;
}

/**
 * A point inside the polygon: its centre when that is inside, otherwise the
 * middle of the widest inside stretch on the centre's latitude, otherwise on
 * the nearest latitude (north and south of it in turn) that has one.
 */
export function insidePointOf(polygon) {
  const { centre } = ringAreaAndCentre(polygon[0]);
  if (polygonContains(polygon, centre[0], centre[1])) return { point: centre, how: 'centre' };
  const b = boundsOf(polygon[0]);
  const step = Math.max((b.north - b.south) / 200, 1e-6);
  for (let k = 0; k <= 200; k += 1) {
    for (const lat of k === 0 ? [centre[1]] : [centre[1] + k * step, centre[1] - k * step]) {
      if (lat <= b.south || lat >= b.north) continue;
      const point = widestSpanMiddle(polygon, lat);
      if (point) return { point, how: 'widest stretch' };
    }
  }
  return null;
}

/** The polygon of a feature with the largest area. */
function largestPolygon(polygons) {
  let best = null;
  let bestArea = -1;
  for (const polygon of polygons) {
    const area = Math.abs(ringAreaAndCentre(polygon[0]).area);
    if (area > bestArea) {
      best = polygon;
      bestArea = area;
    }
  }
  return best;
}

/* ─────────────────────────────────── the dots ─────────────────────────────────── */

const RADIANS = Math.PI / 180;

/**
 * The rows of the grid: latitude and number of cells. Fails when a row's
 * cell count is so near a half that two browsers' cosines could round it
 * differently (world-geometry.ts works the counts out again).
 */
export function dotRows(step) {
  const rows = Math.round(180 / step);
  if (Math.abs(rows * step - 180) > 1e-9) throw new Error('the step must divide 180');
  const out = [];
  for (let i = 0; i < rows; i += 1) {
    const lat = 90 - step * (i + 0.5);
    const exact = (360 / step) * Math.cos(lat * RADIANS);
    if (Math.abs((exact % 1) - 0.5) < 1e-6) throw new Error(`row ${i}: cell count too near a half`);
    out.push({ lat, cells: Math.max(1, Math.round(exact)) });
  }
  return out;
}

/** The longitude of cell j of a row of `cells` cells. */
export const cellLongitude = (j, cells) => -180 + ((j + 0.5) * 360) / cells;

/**
 * One bit per cell, 1 for land, row after row from the north, most
 * significant bit first; and, for every land cell in that order, the country
 * it is in: the code of the first country of the outline whose polygon holds
 * the cell's centre, when that code is in `codes` (so never a code outside
 * the list, and never Kosovo's outline shape: HAND_ONLY_CODES are not in the
 * list); none otherwise. `ownerCodes` are the codes that hold a cell, sorted;
 * `owners` has one byte per land cell: 1 + the code's place in `ownerCodes`,
 * or 0 for none.
 */
export function landBits(outline, step, codes = ISO_3166_ALPHA2) {
  const listed = new Set(codes);
  const polygons = outline.flatMap((f) =>
    f.polygons.map((p) => ({ p, b: boundsOf(p[0]), code: listed.has(f.code) ? f.code : null })),
  );
  const rows = dotRows(step);
  const cells = rows.reduce((sum, row) => sum + row.cells, 0);
  const bytes = new Uint8Array(Math.ceil(cells / 8));
  const ownerOf = [];
  let index = 0;
  let count = 0;
  for (const row of rows) {
    const here = polygons.filter(({ b }) => b.south <= row.lat && row.lat <= b.north);
    for (let j = 0; j < row.cells; j += 1) {
      const lon = cellLongitude(j, row.cells);
      const holding = here.filter(
        ({ p, b }) => b.west <= lon && lon <= b.east && polygonContains(p, lon, row.lat),
      );
      if (holding.length > 0) {
        bytes[index >> 3] |= 0x80 >> (index & 7);
        count += 1;
        ownerOf.push(holding.find((h) => h.code !== null)?.code ?? null);
      }
      index += 1;
    }
  }
  const ownerCodes = [...new Set(ownerOf.filter((code) => code !== null))].sort();
  if (ownerCodes.length > 255)
    throw new Error('more than 255 countries hold land: one byte is too small');
  const place = new Map(ownerCodes.map((code, i) => [code, i + 1]));
  const owners = Uint8Array.from(ownerOf, (code) => (code === null ? 0 : place.get(code)));
  return { rows: rows.length, cells, count, bytes, owners, ownerCodes };
}

/* ────────────────────────────────── the points ────────────────────────────────── */

/** A number to one decimal, as it is written in the output (never "-0"). */
export function oneDecimal(n) {
  const r = Math.round(n * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * A point for every code in `codes`: from the outline where it has the code,
 * else from `fallback`; and for every code in `handOnly` (codes outside the
 * list), from `fallback` only. Errors: a code twice in the outline, a
 * fallback entry for a code the outline has, a code with neither, a code in
 * both lists, a fallback entry for no code of either.
 */
export function countryPoints(outline, codes, fallback, handOnly = []) {
  for (const code of handOnly) {
    if (codes.includes(code)) throw new Error(`${code}: in the list and in the hand-only list`);
  }
  const fromOutline = new Map();
  const notInList = [];
  let withoutCode = 0;
  for (const feature of outline) {
    if (feature.code === null) {
      withoutCode += 1;
      continue;
    }
    if (handOnly.includes(feature.code)) continue;
    if (!codes.includes(feature.code)) {
      notInList.push(feature.code);
      continue;
    }
    if (fromOutline.has(feature.code)) throw new Error(`${feature.code}: twice in the outline`);
    const found = insidePointOf(largestPolygon(feature.polygons));
    if (!found) throw new Error(`${feature.code}: no point inside its largest polygon`);
    fromOutline.set(feature.code, found);
  }
  const points = {};
  const fromFallback = [];
  const how = {};
  for (const code of [...codes, ...handOnly].sort()) {
    const outlined = fromOutline.get(code);
    const hand = Object.prototype.hasOwnProperty.call(fallback, code) ? fallback[code] : null;
    if (outlined && hand) throw new Error(`${code}: in the outline and in the fallback table`);
    if (outlined) {
      points[code] = [oneDecimal(outlined.point[0]), oneDecimal(outlined.point[1])];
      how[code] = outlined.how;
    } else if (hand) {
      points[code] = [oneDecimal(hand[0]), oneDecimal(hand[1])];
      fromFallback.push(code);
      how[code] = 'fallback table';
    } else throw new Error(`${code}: no point (not in the outline, not in the fallback table)`);
  }
  for (const code of Object.keys(fallback)) {
    if (!codes.includes(code) && !handOnly.includes(code)) {
      throw new Error(`${code}: in the fallback table and not a code`);
    }
  }
  return { points, fromFallback, notInList: notInList.sort(), withoutCode, how };
}

/* ─────────────────────────────────── the files ─────────────────────────────────── */

const header = (what) =>
  [
    `// GENERATED by scripts/security-map/generate-world.mjs. Do not edit by hand: run it again.`,
    `//`,
    `// ${what}`,
    `// Source: ${OUTLINE_SOURCE}.`,
    `// Input sha256: ${OUTLINE_SHA256}.`,
    `// Made with: ${COMMAND}`,
  ].join('\n');

export function renderWorldDots(dots, step) {
  const land = Buffer.from(dots.bytes).toString('base64');
  return `${header('The land of the world as a grid of dots, for the attack map (world-geometry.ts reads it).')}

/**
 * The layout. \`rows\` rows of cells from the north pole to the south, each
 * \`step\` degrees of latitude high: row i stands at latitude 90 - step * (i + 0.5)
 * and has max(1, round(360 / step * cos(latitude))) cells, so a cell is about the
 * same size on the ground everywhere; cell j of a row of n cells stands at
 * longitude -180 + (j + 0.5) * 360 / n. \`land\` holds one bit per cell, 1 when the
 * cell's centre is on land, row after row from the north, most significant bit
 * first, in base64. \`cells\` and \`count\` (the land cells) are there to check a
 * reading against. \`owners\` holds one byte per land cell, in the same order: 0
 * when the cell is in no listed country, else 1 + the place of its country's code
 * in \`ownerCodes\` (sorted, separated by spaces), in base64.
 */
export interface WorldDotsData {
  readonly source: string;
  readonly sha256: string;
  readonly step: number;
  readonly rows: number;
  readonly cells: number;
  readonly count: number;
  readonly land: string;
  readonly ownerCodes: string;
  readonly owners: string;
}

export const WORLD_DOTS: WorldDotsData = {
  source:
    '${OUTLINE_SOURCE}',
  sha256: '${OUTLINE_SHA256}',
  step: ${step},
  rows: ${dots.rows},
  cells: ${dots.cells},
  count: ${dots.count},
  land: '${land}',
  ownerCodes: '${dots.ownerCodes.join(' ')}',
  owners: '${Buffer.from(dots.owners).toString('base64')}',
};
`;
}

export function renderCountryPoints(result) {
  const lines = Object.entries(result.points).map(
    ([code, [lon, lat]]) => `  ${code}: [${lon}, ${lat}],`,
  );
  const fallback = result.fromFallback.map((code) => `  '${code}',`);
  return `${header('One point for every ISO 3166-1 two-letter code and the few placed by hand, for the attack map: [longitude, latitude].')}

/**
 * For a code the outline has, the centre of the country's largest polygon when
 * that is inside it, otherwise the middle of the widest stretch of land on that
 * latitude. For the places the outline leaves out, and for the codes outside
 * ISO 3166-1 the script places by hand, the point written by hand in the
 * script's fallback table (COUNTRY_POINTS_FROM_FALLBACK lists them).
 */
export const COUNTRY_POINTS: Readonly<Record<string, readonly [lon: number, lat: number]>> = {
${lines.join('\n')}
};

/** The codes whose point is from the script's hand-written fallback table. */
export const COUNTRY_POINTS_FROM_FALLBACK: readonly string[] = [
${fallback.join('\n')}
];
`;
}

/** Both files' text, from the outline's text. */
export function generateWorld(
  text,
  {
    step = DOT_STEP,
    codes = ISO_3166_ALPHA2,
    fallback = FALLBACK_POINTS,
    handOnly = HAND_ONLY_CODES,
  } = {},
) {
  const outline = readOutline(text);
  const dots = landBits(outline, step, codes);
  const points = countryPoints(outline, codes, fallback, handOnly);
  return {
    worldDots: renderWorldDots(dots, step),
    countryPoints: renderCountryPoints(points),
    dots,
    points,
  };
}

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
export const gzipBytes = (text) => gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).length;

/* ─────────────────────────────────── the command ─────────────────────────────────── */

function main(argv) {
  const args = argv.slice(2);
  const check = args.includes('--check');
  const paths = args.filter((a) => a !== '--check');
  if (paths.length !== 1) {
    console.error(`usage: ${COMMAND} [--check]`);
    return 2;
  }
  const input = readFileSync(paths[0]);
  const digest = sha256(input);
  console.log(`input: ${input.length} bytes, sha256 ${digest}`);
  if (digest !== OUTLINE_SHA256) {
    console.error(`refused: the input is not the pinned outline (sha256 ${OUTLINE_SHA256})`);
    return 1;
  }
  const made = generateWorld(input.toString('utf8'));
  const sizes = {};
  for (const [key, rel] of Object.entries(OUTPUT_FILES)) {
    sizes[key] = { raw: Buffer.byteLength(made[key]), gzip: gzipBytes(made[key]) };
    console.log(`${rel}: ${sizes[key].raw} bytes, ${sizes[key].gzip} gzip`);
  }
  const total = sizes.worldDots.gzip + sizes.countryPoints.gzip;
  console.log(`both, gzip: ${total} bytes (budget ${BUDGET_GZIP_BYTES})`);
  console.log(
    `dots: step ${DOT_STEP} degrees, ${made.dots.rows} rows, ${made.dots.cells} cells, ${made.dots.count} on land`,
  );
  const owned = made.dots.owners.reduce((n, owner) => n + (owner === 0 ? 0 : 1), 0);
  console.log(
    `land dots in a listed country: ${owned} of ${made.dots.count}, in ${made.dots.ownerCodes.length} countries`,
  );
  console.log(`points: ${Object.keys(made.points.points).length} codes`);
  console.log(
    `from the fallback table (${made.points.fromFallback.length}): ${made.points.fromFallback.join(' ')}`,
  );
  const byHow = {};
  for (const [code, how] of Object.entries(made.points.how)) (byHow[how] ??= []).push(code);
  for (const [how, codes] of Object.entries(byHow)) {
    console.log(`  ${how} (${codes.length}): ${codes.join(' ')}`);
  }
  console.log(`outside ISO 3166-1, placed by hand: ${HAND_ONLY_CODES.join(' ')}`);
  console.log(
    `codes in the outline outside the list, given no point: ${made.points.notInList.join(' ') || 'none'}`,
  );
  console.log(`features with no code (land, no point): ${made.points.withoutCode}`);
  if (total > BUDGET_GZIP_BYTES) {
    console.error('refused: over the budget');
    return 1;
  }
  let differ = 0;
  for (const [key, rel] of Object.entries(OUTPUT_FILES)) {
    const path = join(REPO_ROOT, rel);
    if (check) {
      const same = existsSync(path) && readFileSync(path, 'utf8') === made[key];
      console.log(`${relative(REPO_ROOT, path)}: ${same ? 'the same, byte for byte' : 'DIFFERS'}`);
      if (!same) differ += 1;
    } else {
      writeFileSync(path, made[key]);
      console.log(`wrote ${relative(REPO_ROOT, path)}`);
    }
  }
  return differ === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
