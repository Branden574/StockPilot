import { COUNTRY_POINTS } from './country-points';
import { WORLD_DOTS, type WorldDotsData } from './world-dots';

/**
 * The attack map's geometry, read from the two generated files beside this
 * one (scripts/security-map/generate-world.mjs makes them). Pure: no drawing
 * and no data rule. The globe and the flat map draw the same dots and the
 * same points.
 */

export type LonLat = readonly [lon: number, lat: number];

/**
 * StockPilot's end of every arc: one fixed point, labelled "StockPilot". The
 * app is served from the east coast of the United States; the point stands
 * for the service, not for a building.
 */
export const STOCKPILOT_LON_LAT: LonLat = [-77.5, 39];

const RADIANS = Math.PI / 180;

/**
 * The cell counts of the grid's rows, worked out as the generator does. It
 * checked that no row's count is near a half, so every browser's cosine
 * rounds the same way.
 */
function rowCells(data: WorldDotsData): number[] {
  const cells: number[] = [];
  for (let i = 0; i < data.rows; i += 1) {
    const lat = 90 - data.step * (i + 0.5);
    cells.push(Math.max(1, Math.round((360 / data.step) * Math.cos(lat * RADIANS))));
  }
  return cells;
}

function base64Bytes(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * The land dots as [longitude, latitude] pairs in one array (lon0, lat0,
 * lon1, lat1, ...). Empty when the data does not read as its own header says
 * (the wrong number of cells or of land cells): no dots is better than dots
 * in the wrong places.
 */
export function decodeLand(data: WorldDotsData = WORLD_DOTS): Float32Array {
  if (!(data.step > 0) || Math.abs(data.rows * data.step - 180) > 1e-9) return new Float32Array();
  const cells = rowCells(data);
  if (cells.reduce((sum, n) => sum + n, 0) !== data.cells) return new Float32Array();
  const bytes = base64Bytes(data.land);
  if (!bytes || bytes.length !== Math.ceil(data.cells / 8)) return new Float32Array();
  const out = new Float32Array(data.count * 2);
  let index = 0;
  let found = 0;
  for (let i = 0; i < data.rows; i += 1) {
    const lat = 90 - data.step * (i + 0.5);
    const n = cells[i] as number;
    for (let j = 0; j < n; j += 1, index += 1) {
      if (((bytes[index >> 3] as number) & (0x80 >> (index & 7))) === 0) continue;
      if (found >= data.count) return new Float32Array();
      out[found * 2] = -180 + ((j + 0.5) * 360) / n;
      out[found * 2 + 1] = lat;
      found += 1;
    }
  }
  return found === data.count ? out : new Float32Array();
}

let landCache: Float32Array | null = null;
/** decodeLand() of the committed data, read once. */
export function landDots(): Float32Array {
  landCache ??= decodeLand();
  return landCache;
}

/** A country's point, or null for a code with none (one outside ISO 3166-1 the generator does not place). */
export function countryPoint(code: string): LonLat | null {
  return Object.prototype.hasOwnProperty.call(COUNTRY_POINTS, code)
    ? (COUNTRY_POINTS[code] ?? null)
    : null;
}

/* ─────────────────────── the flat map: Equal Earth ─────────────────────── */

/*
 * The Equal Earth projection (Savric, Patterson and Jenny, 2018): equal area,
 * so the dots, which are about the same size on the ground everywhere, are
 * evenly spread on the flat map too. Its constants are those of the
 * published formula.
 */
const A1 = 1.340264;
const A2 = -0.081106;
const A3 = 0.000893;
const A4 = 0.003796;
const M = Math.sqrt(3) / 2;

function equalEarth(lon: number, lat: number): [number, number] {
  const theta = Math.asin(M * Math.sin(lat * RADIANS));
  const t2 = theta * theta;
  const t6 = t2 * t2 * t2;
  const x =
    (lon * RADIANS * Math.cos(theta)) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)));
  const y = theta * (A1 + A2 * t2 + t6 * (A3 + A4 * t2));
  return [x, y];
}

/** The flat map shows the latitudes between these; a point outside is drawn on the edge. */
export const FLAT_NORTH = 84;
export const FLAT_SOUTH = -58;
/** The flat map's width in its own units. */
export const FLAT_WIDTH = 1000;

const X_EDGE = equalEarth(180, 0)[0];
const Y_TOP = equalEarth(0, FLAT_NORTH)[1];
const Y_BOTTOM = equalEarth(0, FLAT_SOUTH)[1];
/** The flat map's height in its own units. */
export const FLAT_HEIGHT = Math.round((FLAT_WIDTH * (Y_TOP - Y_BOTTOM)) / (2 * X_EDGE));

/** A place on the flat map, in its own units (x to the east, y down). */
export function projectFlat(lon: number, lat: number): [number, number] {
  const clamped = Math.min(FLAT_NORTH, Math.max(FLAT_SOUTH, lat));
  const [x, y] = equalEarth(Math.min(180, Math.max(-180, lon)), clamped);
  return [
    ((x + X_EDGE) / (2 * X_EDGE)) * FLAT_WIDTH,
    ((Y_TOP - y) / (Y_TOP - Y_BOTTOM)) * FLAT_HEIGHT,
  ];
}

const fixed1 = (n: number): string => (Math.round(n * 10) / 10).toString();

/**
 * Every land dot of the flat map as ONE path: a zero-length segment per dot,
 * drawn with round caps. Dots south of the flat map's edge are left out.
 */
export function worldDotsPath(dots: Float32Array = landDots()): string {
  const parts: string[] = [];
  for (let i = 0; i + 1 < dots.length; i += 2) {
    const lat = dots[i + 1] as number;
    if (lat < FLAT_SOUTH || lat > FLAT_NORTH) continue;
    const [x, y] = projectFlat(dots[i] as number, lat);
    parts.push(`M${fixed1(x)} ${fixed1(y)}h0`);
  }
  return parts.join('');
}

let pathCache: string | null = null;
/** worldDotsPath() of the committed data, made once. */
export function flatDotsPath(): string {
  pathCache ??= worldDotsPath();
  return pathCache;
}

/**
 * An arc on the flat map from `from` to `to`: a quadratic curve that bows
 * up (north) by a share of its length, so arcs that share an end fan out.
 * Returned as the path's `d`.
 */
export function flatArcPath(from: LonLat, to: LonLat): string {
  const [x0, y0] = projectFlat(from[0], from[1]);
  const [x1, y1] = projectFlat(to[0], to[1]);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  const lift = Math.min(160, 18 + length * 0.28);
  const cx = (x0 + x1) / 2;
  const cy = Math.max(4, (y0 + y1) / 2 - lift);
  return `M${fixed1(x0)} ${fixed1(y0)}Q${fixed1(cx)} ${fixed1(cy)} ${fixed1(x1)} ${fixed1(y1)}`;
}
