import type { LonLat } from './world-geometry';

/**
 * Every piece of the globe's arithmetic, pure and tested (globe-math.test.ts).
 * The one file that touches WebGL (globe-renderer.ts) calls these and holds no
 * rule of its own. Nothing here allocates in the functions the renderer calls
 * on every frame: they write into arrays and objects they are handed.
 *
 * The globe's own axes: north is +y, longitude 0 on the equator is +z (toward
 * the viewer when the globe is not turned), longitude 90 east is +x. The
 * globe is turned by a yaw about y, then a pitch about x (three.js's Euler
 * order 'XYZ' applies them in that order): yaw = -longitude and pitch =
 * latitude bring that place to the front.
 */

const RADIANS = Math.PI / 180;
const TAU = Math.PI * 2;

/** Writes the place's point on a sphere of `radius` into `out` at `offset` (x, y, z). */
export function lonLatToVector(
  lon: number,
  lat: number,
  radius: number,
  out: Float32Array | number[],
  offset = 0,
): void {
  const l = lon * RADIANS;
  const p = lat * RADIANS;
  const c = Math.cos(p);
  out[offset] = radius * c * Math.sin(l);
  out[offset + 1] = radius * Math.sin(p);
  out[offset + 2] = radius * c * Math.cos(l);
}

/** The land dots (longitude, latitude pairs) as points on a sphere of `radius`. */
export function dotPositions(lonLat: Float32Array, radius: number): Float32Array {
  const out = new Float32Array((lonLat.length / 2) * 3);
  for (let i = 0, j = 0; i + 1 < lonLat.length; i += 2, j += 3) {
    lonLatToVector(lonLat[i] as number, lonLat[i + 1] as number, radius, out, j);
  }
  return out;
}

/** The angle between two places, seen from the centre of the earth, in radians. */
export function centralAngle(a: LonLat, b: LonLat): number {
  const p1 = a[1] * RADIANS;
  const p2 = b[1] * RADIANS;
  const dl = (b[0] - a[0]) * RADIANS;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** How high an arc rises at its middle, in globe radii: higher the farther it goes. */
export const ARC_MIN_HEIGHT = 0.06;
export const ARC_MAX_HEIGHT = 0.42;
export function arcHeight(angle: number): number {
  const share = Math.min(1, Math.max(0, angle / Math.PI));
  return ARC_MIN_HEIGHT + (ARC_MAX_HEIGHT - ARC_MIN_HEIGHT) * Math.sqrt(share);
}

/** Points along every arc. */
export const ARC_SEGMENTS = 48;

/**
 * Writes the arc from `from` to `to` on a globe of radius 1 into `out`:
 * `segments + 1` points (x, y, z each) along the great circle between them,
 * lifted off the surface by arcHeight(angle) * sin(pi * t). Two places at
 * the same point make a small loop straight up; two opposite each other go
 * over the north side.
 */
export function writeArcPoints(
  from: LonLat,
  to: LonLat,
  out: Float32Array,
  segments: number = ARC_SEGMENTS,
): void {
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  lonLatToVector(from[0], from[1], 1, a);
  lonLatToVector(to[0], to[1], 1, b);
  const dot = Math.min(1, Math.max(-1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!));
  const omega = Math.acos(dot);
  const height = arcHeight(omega);
  const sinOmega = Math.sin(omega);
  // Nearly opposite places: the great circle is not defined by the two
  // points alone, so go through a point a quarter turn north of the start.
  const opposite = sinOmega < 1e-6 && dot < 0;
  // The point a quarter turn north of the start along its meridian.
  const fromLon = from[0] * RADIANS;
  const fromLat = from[1] * RADIANS;
  const mid = [
    -Math.sin(fromLat) * Math.sin(fromLon),
    Math.cos(fromLat),
    -Math.sin(fromLat) * Math.cos(fromLon),
  ];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    let x: number;
    let y: number;
    let z: number;
    if (sinOmega < 1e-6 && !opposite) {
      x = a[0]!;
      y = a[1]!;
      z = a[2]!;
    } else if (opposite) {
      // Two quarter-circle halves through `mid`.
      const s = t < 0.5 ? t * 2 : (t - 0.5) * 2;
      const p = t < 0.5 ? a : mid;
      const q = t < 0.5 ? mid : b;
      const w = Math.PI / 2;
      const k0 = Math.sin((1 - s) * w);
      const k1 = Math.sin(s * w);
      x = k0 * p[0]! + k1 * q[0]!;
      y = k0 * p[1]! + k1 * q[1]!;
      z = k0 * p[2]! + k1 * q[2]!;
    } else {
      const k0 = Math.sin((1 - t) * omega) / sinOmega;
      const k1 = Math.sin(t * omega) / sinOmega;
      x = k0 * a[0]! + k1 * b[0]!;
      y = k0 * a[1]! + k1 * b[1]!;
      z = k0 * a[2]! + k1 * b[2]!;
    }
    const length = Math.hypot(x, y, z) || 1;
    const lift = (1 + height * Math.sin(Math.PI * t)) / length;
    out[i * 3] = x * lift;
    out[i * 3 + 1] = y * lift;
    out[i * 3 + 2] = z * lift;
  }
}

/**
 * Writes the point at `t` (0 to 1) along a line of points (x, y, z each)
 * into `out` at `offset`, straight between the two nearest points.
 */
export function pointAlong(points: Float32Array, t: number, out: Float32Array, offset = 0): void {
  const last = points.length / 3 - 1;
  const at = Math.min(last, Math.max(0, t * last));
  const i = Math.min(last - 1, Math.floor(at));
  const f = at - i;
  for (let k = 0; k < 3; k += 1) {
    const p = points[i * 3 + k] as number;
    const q = points[(i + 1) * 3 + k] as number;
    out[offset + k] = p + (q - p) * f;
  }
}

/** Sides of the tube an arc is drawn as. */
export const TUBE_SIDES = 5;

/** Vertices of a tube around `segments + 1` points with `sides` around. */
export const tubeVertexCount = (segments: number, sides: number): number => (segments + 1) * sides;

/**
 * Writes a thin tube around a line of points: positions (x, y, z), for each
 * vertex how far along the line it is (0 to 1), and, when `normals` is given,
 * the direction each vertex faces. The tube is thinnest where it leaves the
 * ground and lands, and `radius` thick at the middle.
 */
export function writeTube(
  points: Float32Array,
  segments: number,
  sides: number,
  radius: number,
  positions: Float32Array,
  along: Float32Array,
  normals?: Float32Array,
): void {
  for (let i = 0; i <= segments; i += 1) {
    const prev = Math.max(0, i - 1) * 3;
    const next = Math.min(segments, i + 1) * 3;
    const px = points[i * 3] as number;
    const py = points[i * 3 + 1] as number;
    const pz = points[i * 3 + 2] as number;
    // Tangent along the line.
    let tx = (points[next] as number) - (points[prev] as number);
    let ty = (points[next + 1] as number) - (points[prev + 1] as number);
    let tz = (points[next + 2] as number) - (points[prev + 2] as number);
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    // Up (away from the centre), made square to the tangent.
    const ul = Math.hypot(px, py, pz) || 1;
    let nx = px / ul;
    let ny = py / ul;
    let nz = pz / ul;
    const d = nx * tx + ny * ty + nz * tz;
    nx -= d * tx;
    ny -= d * ty;
    nz -= d * tz;
    let nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-9) {
      // The tangent points straight up: any square direction will do.
      nx = Math.abs(tx) < 0.9 ? 1 : 0;
      ny = Math.abs(tx) < 0.9 ? 0 : 1;
      nz = 0;
      const e = nx * tx + ny * ty + nz * tz;
      nx -= e * tx;
      ny -= e * ty;
      nz -= e * tz;
      nl = Math.hypot(nx, ny, nz) || 1;
    }
    nx /= nl;
    ny /= nl;
    nz /= nl;
    // The third direction: tangent x up.
    const bx = ty * nz - tz * ny;
    const by = tz * nx - tx * nz;
    const bz = tx * ny - ty * nx;
    const t = i / segments;
    const r = radius * (0.35 + 0.65 * Math.sin(Math.PI * t));
    for (let k = 0; k < sides; k += 1) {
      const angle = (k / sides) * TAU;
      const c = Math.cos(angle) * r;
      const s = Math.sin(angle) * r;
      const v = i * sides + k;
      positions[v * 3] = px + c * nx + s * bx;
      positions[v * 3 + 1] = py + c * ny + s * by;
      positions[v * 3 + 2] = pz + c * nz + s * bz;
      along[v] = t;
      if (normals) {
        const cu = Math.cos(angle);
        const su = Math.sin(angle);
        normals[v * 3] = cu * nx + su * bx;
        normals[v * 3 + 1] = cu * ny + su * by;
        normals[v * 3 + 2] = cu * nz + su * bz;
      }
    }
  }
}

/** The triangles of a tube made by writeTube, as indexes (the same for every arc). */
export function tubeIndexes(segments: number, sides: number): Uint16Array {
  const out = new Uint16Array(segments * sides * 6);
  let n = 0;
  for (let i = 0; i < segments; i += 1) {
    for (let k = 0; k < sides; k += 1) {
      const a = i * sides + k;
      const b = i * sides + ((k + 1) % sides);
      const c = a + sides;
      const d = b + sides;
      out[n++] = a;
      out[n++] = c;
      out[n++] = b;
      out[n++] = b;
      out[n++] = c;
      out[n++] = d;
    }
  }
  return out;
}

/** An angle brought into (-pi, pi]. */
export function wrapAngle(angle: number): number {
  const a = ((((angle + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return a === -Math.PI ? Math.PI : a;
}

/** Turns a point (x, y, z) by the globe's yaw and then its pitch, in place. */
export function turnPoint(v: Float32Array | number[], yaw: number, pitch: number): void {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x = (v[0] as number) * cy + (v[2] as number) * sy;
  const z1 = -(v[0] as number) * sy + (v[2] as number) * cy;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const y = (v[1] as number) * cp - z1 * sp;
  const z = (v[1] as number) * sp + z1 * cp;
  v[0] = x;
  v[1] = y;
  v[2] = z;
}

/** Which way to turn the globe to face a set of places. */
export interface GlobeFacing {
  yaw: number;
  pitch: number;
  /** The angle from the facing direction to the farthest place, in radians. */
  spread: number;
}

/**
 * The yaw and pitch that bring the middle of `places` to the front, and how
 * far the farthest of them is from it. Null for no places, or for places
 * spread so evenly round the world that they have no middle.
 */
export function facingOf(places: readonly LonLat[]): GlobeFacing | null {
  if (places.length === 0) return null;
  const v = [0, 0, 0];
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const [lon, lat] of places) {
    lonLatToVector(lon, lat, 1, v);
    sx += v[0]!;
    sy += v[1]!;
    sz += v[2]!;
  }
  const length = Math.hypot(sx, sy, sz);
  if (length < 1e-6 * places.length) return null;
  sx /= length;
  sy /= length;
  sz /= length;
  let spread = 0;
  for (const [lon, lat] of places) {
    lonLatToVector(lon, lat, 1, v);
    const dot = Math.min(1, Math.max(-1, v[0]! * sx + v[1]! * sy + v[2]! * sz));
    spread = Math.max(spread, Math.acos(dot));
  }
  return { yaw: -Math.atan2(sx, sz), pitch: Math.asin(Math.min(1, Math.max(-1, sy))), spread };
}

/* ─────────────────────────── turning the globe ─────────────────────────── */

/** The globe's turn, kept between frames. advanceGlobeMotion() changes it in place. */
export interface GlobeMotion {
  yaw: number;
  pitch: number;
  /** Turn speed left over from a drag, radians per millisecond. */
  yawSpeed: number;
  pitchSpeed: number;
  /** Milliseconds since the viewer last let go of the globe. */
  idleMs: number;
  /** Milliseconds of turning on its own, for the gentle sway. */
  swayMs: number;
}

/** The pitch never goes past this, so the globe is never seen from a pole. */
export const MAX_PITCH = 1.05;
/** After the viewer lets go, the globe waits this long before it turns on its own again. */
export const RESUME_AFTER_MS = 2500;
/** A drag's speed halves about every this many milliseconds once let go. */
export const INERTIA_MS = 420;
/** Turning on its own: one turn in this many milliseconds. */
export const TURN_MS = 90_000;
/** Places that fit within this angle of their middle stay in view: the globe sways instead of turning. */
export const FITS_IN_VIEW = 1.15;
const SWAY = 0.16;
const SWAY_MS = 26_000;
const EASE_MS = 1800;
const RESTING_PITCH = 0.32;
const MAX_STEP_MS = 64;

export function createGlobeMotion(yaw = 0, pitch = RESTING_PITCH): GlobeMotion {
  return { yaw, pitch, yawSpeed: 0, pitchSpeed: 0, idleMs: RESUME_AFTER_MS, swayMs: 0 };
}

const clampPitch = (p: number): number => Math.min(MAX_PITCH, Math.max(-MAX_PITCH, p));

/**
 * One frame of the globe's turn, in place. A drag's leftover speed dies away
 * whatever else is true (it is the viewer's own push). Turning on its own
 * happens only when `mayTurn` (not paused, not stopped, not hidden) and the
 * viewer let go a while ago: towards `focus` with a gentle sway when its
 * places fit in view, otherwise a slow steady turn. A long gap between
 * frames (a tab that comes back) counts as a short one, so nothing jumps.
 */
export function advanceGlobeMotion(
  m: GlobeMotion,
  input: { dtMs: number; dragging: boolean; mayTurn: boolean; focus: GlobeFacing | null },
): void {
  const dt = Math.min(MAX_STEP_MS, Math.max(0, input.dtMs));
  if (input.dragging) {
    m.idleMs = 0;
    return;
  }
  m.idleMs += dt;
  if (m.yawSpeed !== 0 || m.pitchSpeed !== 0) {
    m.yaw = wrapAngle(m.yaw + m.yawSpeed * dt);
    m.pitch = clampPitch(m.pitch + m.pitchSpeed * dt);
    const keep = Math.exp(-dt / INERTIA_MS);
    m.yawSpeed *= keep;
    m.pitchSpeed *= keep;
    if (Math.abs(m.yawSpeed) < 1e-6) m.yawSpeed = 0;
    if (Math.abs(m.pitchSpeed) < 1e-6) m.pitchSpeed = 0;
    return;
  }
  if (!input.mayTurn || m.idleMs < RESUME_AFTER_MS) return;
  m.swayMs += dt;
  const ease = 1 - Math.exp(-dt / EASE_MS);
  const focus = input.focus;
  if (focus && focus.spread <= FITS_IN_VIEW) {
    const target = focus.yaw + SWAY * Math.sin((TAU * m.swayMs) / SWAY_MS);
    m.yaw = wrapAngle(m.yaw + wrapAngle(target - m.yaw) * ease);
    m.pitch = clampPitch(m.pitch + (clampPitch(focus.pitch * 0.8) - m.pitch) * ease);
  } else {
    m.yaw = wrapAngle(m.yaw + (TAU * dt) / TURN_MS);
    m.pitch = clampPitch(m.pitch + (RESTING_PITCH - m.pitch) * ease);
  }
}

/**
 * A drag of (dx, dy) screen pixels over `dtMs` on a globe drawn `radiusPx`
 * pixels across its half: the globe turns with the pointer, and remembers
 * the speed so it can coast a little when let go.
 */
export function dragGlobe(
  m: GlobeMotion,
  dx: number,
  dy: number,
  dtMs: number,
  radiusPx: number,
): void {
  const r = Math.max(40, radiusPx);
  const dYaw = dx / r;
  const dPitch = dy / r;
  m.yaw = wrapAngle(m.yaw + dYaw);
  m.pitch = clampPitch(m.pitch + dPitch);
  m.idleMs = 0;
  if (dtMs > 0) {
    m.yawSpeed = 0.7 * m.yawSpeed + 0.3 * (dYaw / dtMs);
    m.pitchSpeed = 0.7 * m.pitchSpeed + 0.3 * (dPitch / dtMs);
  }
}

/** The pointer was held still before letting go: no coasting. */
export function stopCoasting(m: GlobeMotion): void {
  m.yawSpeed = 0;
  m.pitchSpeed = 0;
}

/* ───────────────────────── the arcs' moving heads ───────────────────────── */

/** How the arcs move: looping (live), once per replay step, or not at all. */
export type ArcTiming = 'live' | 'replay' | 'still';

/** A live arc's head takes this long from its start to StockPilot, and starts again after this long. */
export const LIVE_TRAVEL_MS = 2000;
export const LIVE_PERIOD_MS = 3600;
/** In a replay step, each arc starts within this much of the step's start, and travels this long. */
export const REPLAY_SPREAD_MS = 600;
export const REPLAY_TRAVEL_MS = 1300;
/** The trail behind the head, as a share of the arc. */
export const TRAIL = 0.4;
/** A pulse where an arc starts or lands lasts this long. */
export const PULSE_MS = 900;

/** What one arc shows in one frame. */
export interface ArcFrame {
  /** Where the head is along the arc (0 to 1 + TRAIL); below 0, not started. */
  head: number;
  /** How bright the whole path is, under the head and its trail (0 to 1). */
  base: number;
  /** The start's and the landing's pulse: 0 to 1 while it runs, -1 when there is none. */
  startPulse: number;
  landPulse: number;
}

export const createArcFrame = (): ArcFrame => ({
  head: -1,
  base: 0,
  startPulse: -1,
  landPulse: -1,
});

/** A number from 0 to 1 that stays the same for a key, so arcs do not all move together. */
export function arcOffset(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

const pulse = (sinceMs: number): number =>
  sinceMs >= 0 && sinceMs < PULSE_MS ? sinceMs / PULSE_MS : -1;

/**
 * One arc's frame, written into `out`. `elapsedMs` is the time since the
 * play began (live) or since the replay step began (replay). Still: the
 * whole path drawn, no head and no pulse.
 */
export function arcFrameAt(
  out: ArcFrame,
  timing: ArcTiming,
  elapsedMs: number,
  offset: number,
): void {
  if (timing === 'still') {
    out.head = -1;
    out.base = 0.6;
    out.startPulse = -1;
    out.landPulse = -1;
    return;
  }
  let since: number;
  let travel: number;
  if (timing === 'live') {
    const shifted = elapsedMs + offset * LIVE_PERIOD_MS;
    since = ((shifted % LIVE_PERIOD_MS) + LIVE_PERIOD_MS) % LIVE_PERIOD_MS;
    travel = LIVE_TRAVEL_MS;
  } else {
    since = elapsedMs - offset * REPLAY_SPREAD_MS;
    travel = REPLAY_TRAVEL_MS;
  }
  out.head = since < 0 ? -1 : since / travel;
  out.base = since < 0 && timing === 'replay' ? 0 : 0.08;
  out.startPulse = pulse(since);
  out.landPulse = pulse(since - travel);
}
