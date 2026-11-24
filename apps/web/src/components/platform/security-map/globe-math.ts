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

/**
 * The globe's radius is this share of the stage's height, and the globe sits
 * in the middle of the stage's height, so the room above its top (and below
 * its bottom) is STAGE_HEADROOM globe radii.
 */
export const GLOBE_HEIGHT_SHARE = 0.36;
export const STAGE_HEADROOM = (0.5 - GLOBE_HEIGHT_SHARE) / GLOBE_HEIGHT_SHARE;

/**
 * How high an arc rises at its middle, in globe radii: higher the farther it
 * goes, and never higher than ARC_MAX_HEIGHT, which is well under the room
 * the stage leaves above the globe, so no arc is cut by the stage's edge.
 */
export const ARC_MIN_HEIGHT = 0.05;
export const ARC_MAX_HEIGHT = 0.26;
export function arcHeight(angle: number): number {
  const share = Math.min(1, Math.max(0, angle / Math.PI));
  return ARC_MIN_HEIGHT + (ARC_MAX_HEIGHT - ARC_MIN_HEIGHT) * Math.sqrt(share);
}

/** Points along every arc. */
export const ARC_SEGMENTS = 72;

/**
 * How far an arc bows sideways off its great circle at most (a long arc; a
 * shorter one bows less). Without it, an arc whose plane is edge-on to the
 * camera is drawn as a perfectly straight line across the globe's face and
 * reads as a line through the Earth.
 */
export const ARC_BOW = 7 * RADIANS;
/** Arcs this long or longer bow by the whole ARC_BOW; shorter ones in proportion. */
const BOW_FULL_AT = 60 * RADIANS;
/** The largest value of sin(pi t) * (1 + cos(pi t)), at t = 1/3. */
const BOW_PEAK = (3 * Math.sqrt(3)) / 4;

/**
 * The sideways bow of the arc from `from` to `to` at its widest, in radians
 * off the great circle (signed: which side). Always the same for the same
 * pair, so an arc never flips or jitters between reads.
 */
export function arcBow(from: LonLat, to: LonLat): number {
  const side = arcOffset(`${from[0]},${from[1]}>${to[0]},${to[1]}`) < 0.5 ? -1 : 1;
  return side * ARC_BOW * Math.min(1, centralAngle(from, to) / BOW_FULL_AT);
}

/**
 * The share of an arc's bow at `t` (0 at the source, 1 at StockPilot): none
 * at either end, widest a third of the way from the source, and meeting
 * StockPilot along the great circle. It is lopsided on purpose: a bow shaped
 * like the arc's own rise (widest in the middle) only turns the straight
 * view to another angle, but a lopsided one leaves no view from which the
 * arc is a straight line.
 */
export function arcBowAt(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return (Math.sin(Math.PI * clamped) * (1 + Math.cos(Math.PI * clamped))) / BOW_PEAK;
}

/**
 * Writes the arc from `from` to `to` on a globe of radius 1 into `out`:
 * `segments + 1` points (x, y, z each) along the great circle between them,
 * turned `bow * arcBowAt(t)` radians off it to one side (arcBow), and lifted
 * off the surface by arcHeight(angle) * sin(pi * t). Two places at the same
 * point make a small loop straight up; two opposite each other go over the
 * north side.
 */
export function writeArcPoints(
  from: LonLat,
  to: LonLat,
  out: Float32Array,
  segments: number = ARC_SEGMENTS,
  bow = 0,
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
  // The normal of the arc's plane: the bow turns each point along it.
  const other = opposite ? mid : b;
  const n = [
    a[1]! * other[2]! - a[2]! * other[1]!,
    a[2]! * other[0]! - a[0]! * other[2]!,
    a[0]! * other[1]! - a[1]! * other[0]!,
  ];
  const nLength = Math.hypot(n[0]!, n[1]!, n[2]!);
  const bows = nLength > 1e-9 && bow !== 0;
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
    if (bows) {
      // Off the great circle by up to `bow`, none at the ends: the point turned
      // toward the plane's normal (both unit length and at right angles).
      const turn = bow * arcBowAt(t);
      const c = Math.cos(turn);
      const s = Math.sin(turn) / nLength;
      const unit = Math.hypot(x, y, z) || 1;
      x = (x / unit) * c + n[0]! * s;
      y = (y / unit) * c + n[1]! * s;
      z = (z / unit) * c + n[2]! * s;
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

/* ───────────────────────────── the arcs' ribbons ───────────────────────────── */

/** Vertices of one arc's ribbon: two for each point of its line, one either side. */
export const ribbonVertexCount = (segments: number): number => (segments + 1) * 2;

/** The arrays an arc's ribbon is written into (shared by every arc, each at its own place). */
export interface RibbonArrays {
  /** The point itself (x, y, z), the same for both vertices of a point. */
  position: Float32Array;
  /** The points before and after it (the first point's "before" is itself, as is the last one's "after"). */
  previous: Float32Array;
  next: Float32Array;
  /** -1 or +1: which side of the line the vertex is pushed to. */
  side: Float32Array;
  /** How far along the line, 0 at the start to 1 at StockPilot. */
  along: Float32Array;
  /** The length of line before the point, in globe radii. */
  distance: Float32Array;
}

/**
 * Writes one arc's ribbon into `out`, starting at vertex `first`. The
 * renderer turns each vertex's "before" and "after" into the line's direction
 * on the screen and pushes the vertex out sideways by half the ribbon's width
 * in pixels, so every arc is the same width on the screen however far away
 * it is. `distance` lets a dashed line keep dashes of one length on every
 * arc. Returns the line's whole length, in globe radii.
 */
export function writeRibbon(
  points: Float32Array,
  segments: number,
  out: RibbonArrays,
  first: number,
): number {
  let distance = 0;
  for (let i = 0; i <= segments; i += 1) {
    const prev = Math.max(0, i - 1) * 3;
    const next = Math.min(segments, i + 1) * 3;
    if (i > 0) {
      distance += Math.hypot(
        (points[i * 3] as number) - (points[prev] as number),
        (points[i * 3 + 1] as number) - (points[prev + 1] as number),
        (points[i * 3 + 2] as number) - (points[prev + 2] as number),
      );
    }
    for (let s = 0; s < 2; s += 1) {
      const v = first + i * 2 + s;
      for (let k = 0; k < 3; k += 1) {
        out.position[v * 3 + k] = points[i * 3 + k] as number;
        out.previous[v * 3 + k] = points[prev + k] as number;
        out.next[v * 3 + k] = points[next + k] as number;
      }
      out.side[v] = s === 0 ? -1 : 1;
      out.along[v] = i / segments;
      out.distance[v] = distance;
    }
  }
  return distance;
}

/** The triangles of `count` ribbons of `segments` segments each, laid one after another. */
export function ribbonIndexes(segments: number, count: number): Uint16Array {
  const perRibbon = ribbonVertexCount(segments);
  const out = new Uint16Array(segments * 6 * count);
  let n = 0;
  for (let r = 0; r < count; r += 1) {
    const base = r * perRibbon;
    for (let i = 0; i < segments; i += 1) {
      const a = base + i * 2;
      out[n++] = a;
      out[n++] = a + 2;
      out[n++] = a + 1;
      out[n++] = a + 1;
      out[n++] = a + 2;
      out[n++] = a + 3;
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

/** The camera, as the stage sees it: on the globe's axis at `distance` radii, looking at its centre. */
export interface StageCamera {
  distance: number;
  /** tan(half the vertical field of view). */
  tanHalf: number;
  /** Width over height. */
  aspect: number;
  width: number;
  height: number;
  /** The view moved right by this many CSS pixels (the globe drawn this much left). */
  shift: number;
}

/**
 * Where a point of the globe (unturned, in globe radii) is on the stage, in
 * CSS pixels from its top-left corner, once the globe is turned by `yaw` and
 * `pitch`; and the cosine of its angle from the middle of the view, seen
 * from the globe's centre (for limbFade). Writes [x, y, cos] into `out`.
 */
export function projectToStage(
  point: ArrayLike<number>,
  yaw: number,
  pitch: number,
  camera: StageCamera,
  out: Float32Array | number[],
): void {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const px = point[0] as number;
  const py = point[1] as number;
  const pz = point[2] as number;
  const x = px * cy + pz * sy;
  const z1 = -px * sy + pz * cy;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const y = py * cp - z1 * sp;
  const z = py * sp + z1 * cp;
  const depth = Math.max(1e-6, camera.distance - z);
  const ndcX = x / depth / (camera.tanHalf * camera.aspect);
  const ndcY = y / depth / camera.tanHalf;
  out[0] = (ndcX * 0.5 + 0.5) * camera.width - camera.shift;
  out[1] = (0.5 - ndcY * 0.5) * camera.height;
  out[2] = z / (Math.hypot(x, y, z) || 1);
}

/* ─────────────────────────── which way the globe faces ─────────────────────────── */

/** The camera's tilt: the globe is seen from this far north of its equator (pitch = latitude at the front). */
export const GLOBE_TILT = 18 * RADIANS;
/** A source is seen in full up to this far from the middle of the view, and not at all past SOURCE_GONE. */
export const SOURCE_SEEN = 42 * RADIANS;
export const SOURCE_GONE = 76 * RADIANS;
/** StockPilot is seen in full up to this far from the middle, and counts for nothing past STOCKPILOT_GONE. */
export const STOCKPILOT_SEEN = 48 * RADIANS;
export const STOCKPILOT_GONE = 68 * RADIANS;
/** What keeping StockPilot in view is worth, against all the sources' weight together. */
export const STOCKPILOT_WORTH = 0.6;

/** A place the play draws arcs from, and how much it weighs in where the globe faces. */
export interface WeightedPlace {
  lonLat: LonLat;
  weight: number;
}

/** The angle from the middle of the view (yaw, at the tilt's latitude) to a place, in radians. */
export function angleFromView(yaw: number, place: LonLat, tilt = GLOBE_TILT): number {
  return centralAngle([-yaw / RADIANS, tilt / RADIANS], place);
}

/** 1 up to `full`, 0 from `gone`, smooth in between. */
function seen(angle: number, full: number, gone: number): number {
  const x = Math.min(1, Math.max(0, (gone - angle) / (gone - full)));
  return x * x * (3 - 2 * x);
}

/**
 * The yaw that faces the play's sources while keeping StockPilot on the
 * visible side whenever that can be had. Every yaw, a degree apart, is given
 * a score: the weight of the sources it shows well (a source in the middle
 * counts a little more than one near the edge), and, when StockPilot is well
 * inside the limb, STOCKPILOT_WORTH of all the sources' weight. The best
 * wins; so StockPilot is kept in view unless that would hide most of the
 * sources (a play from the far side of the world faces the sources). With no
 * places (nothing to play) the globe faces StockPilot. A place's weight is
 * the square root of its events, so one loud country does not hide the rest.
 */
export function facingYaw(places: readonly WeightedPlace[], stockpilot: LonLat): number {
  const own = wrapAngle(-stockpilot[0] * RADIANS);
  const weighed = places.filter((p) => p.weight > 0 && Number.isFinite(p.weight));
  if (weighed.length === 0) return own;
  const total = weighed.reduce((sum, p) => sum + p.weight, 0);
  let best = own;
  let bestScore = -Infinity;
  for (let degree = -179; degree <= 180; degree += 1) {
    const yaw = degree * RADIANS;
    let score = 0;
    for (const p of weighed) {
      const angle = angleFromView(yaw, p.lonLat);
      score += p.weight * (seen(angle, SOURCE_SEEN, SOURCE_GONE) + 0.25 * Math.cos(angle));
    }
    score +=
      STOCKPILOT_WORTH *
      total *
      seen(angleFromView(yaw, stockpilot), STOCKPILOT_SEEN, STOCKPILOT_GONE);
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = yaw;
    }
  }
  return wrapAngle(best);
}

/* ─────────────────────────── turning the globe ─────────────────────────── */

/** The globe's turn, kept between frames. advanceGlobeMotion() changes it in place. */
export interface GlobeMotion {
  yaw: number;
  /** The tilt: the globe is only ever turned left and right. */
  pitch: number;
  /** The yaw the globe faces (its sway goes either side of it); null before the first. */
  target: number | null;
  /** An ease toward the target: the yaw it started from, and how far it is (ms); -1 when none. */
  easeFrom: number;
  easeMs: number;
  /** Turn speed left over from a drag, radians per millisecond. */
  yawSpeed: number;
  /** Milliseconds since the viewer last let go of the globe. */
  idleMs: number;
  /** The viewer turned the globe away from its target, and it has not eased back yet. */
  away: boolean;
  /** Milliseconds of sway since the last ease began. */
  swayMs: number;
}

/** An ease to a new facing takes this long, slow at both ends. */
export const EASE_MS = 1200;
/** After the viewer lets go, the globe waits this long before it eases back. */
export const RETURN_AFTER_MS = 6000;
/** A drag's speed halves about every this many milliseconds once let go. */
export const INERTIA_MS = 380;
/** The sway's reach either side of the target. */
export const SWAY = 22 * RADIANS;
/** At its fastest the sway turns as fast as one whole turn in this long. */
export const DRIFT_TURN_MS = 240_000;
/** So one sway, there and back, takes this long. */
export const SWAY_PERIOD_MS = SWAY * DRIFT_TURN_MS;
/** A new target closer than this to the old one is not worth an ease. */
export const TARGET_MOVE = 3 * RADIANS;
const MAX_STEP_MS = 64;

export function createGlobeMotion(yaw = 0): GlobeMotion {
  return {
    yaw: wrapAngle(yaw),
    pitch: GLOBE_TILT,
    target: null,
    easeFrom: 0,
    easeMs: -1,
    yawSpeed: 0,
    idleMs: RETURN_AFTER_MS,
    away: false,
    swayMs: 0,
  };
}

/** Slow at both ends (cubic). */
export function easeInOut(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** The sway's offset from the target after `ms` of swaying. */
export const swayAt = (ms: number): number => SWAY * Math.sin((TAU * ms) / SWAY_PERIOD_MS);

function startEase(m: GlobeMotion): void {
  m.easeFrom = m.yaw;
  m.easeMs = 0;
  m.swayMs = 0;
  m.away = false;
}

/**
 * One frame of the globe's turn, in place.
 *
 * - `still` (reduced motion): nothing moves on its own. The globe is put
 *   straight on its target (no ease, no sway); a drag turns it, with no
 *   coasting.
 * - `mayTurn` false (paused, not updating, hidden): the globe holds where it
 *   is; only the viewer's drag and its coasting move it. The very first
 *   target is taken straight, so a stopped page still faces its sources.
 * - Otherwise: a new target (further than TARGET_MOVE from the old) is eased
 *   to over EASE_MS; in between, a slow sway either side of it, never faster
 *   than one turn in DRIFT_TURN_MS. After a drag the globe coasts, waits
 *   RETURN_AFTER_MS, then eases back.
 *
 * A long gap between frames (a tab that comes back) counts as a short one.
 */
export function advanceGlobeMotion(
  m: GlobeMotion,
  input: {
    dtMs: number;
    dragging: boolean;
    mayTurn: boolean;
    still: boolean;
    target: number | null;
  },
): void {
  const dt = Math.min(MAX_STEP_MS, Math.max(0, input.dtMs));
  const target = input.target;
  const moved =
    target !== null && (m.target === null || Math.abs(wrapAngle(target - m.target)) > TARGET_MOVE);
  if (input.dragging) {
    m.idleMs = 0;
    return;
  }
  m.idleMs += dt;
  if (input.still) {
    m.yawSpeed = 0;
    m.easeMs = -1;
    if (moved) {
      m.target = target;
      m.yaw = wrapAngle(target);
      m.away = false;
    }
    return;
  }
  if (m.yawSpeed !== 0) {
    m.yaw = wrapAngle(m.yaw + m.yawSpeed * dt);
    m.yawSpeed *= Math.exp(-dt / INERTIA_MS);
    if (Math.abs(m.yawSpeed) < 1e-6) m.yawSpeed = 0;
    if (moved) m.target = target;
    return;
  }
  if (!input.mayTurn) {
    if (moved && m.target === null) m.yaw = wrapAngle(target);
    if (moved) m.target = target;
    m.easeMs = -1;
    return;
  }
  if (moved) {
    m.target = target;
    if (!m.away) startEase(m);
  }
  if (m.target === null) return;
  if (m.away) {
    if (m.idleMs < RETURN_AFTER_MS) return;
    startEase(m);
  }
  m.swayMs += dt;
  const goal = m.target + swayAt(m.swayMs);
  if (m.easeMs >= 0) {
    m.easeMs += dt;
    const k = easeInOut(m.easeMs / EASE_MS);
    m.yaw = wrapAngle(m.easeFrom + wrapAngle(goal - m.easeFrom) * k);
    if (m.easeMs >= EASE_MS) m.easeMs = -1;
    return;
  }
  m.yaw = wrapAngle(goal);
}

/**
 * A drag of `dx` screen pixels over `dtMs` on a globe drawn `radiusPx`
 * pixels across its half: the globe turns left or right with the pointer
 * (never up or down: the tilt stays), and remembers the speed so it can
 * coast a little when let go. `still` (reduced motion): no coasting.
 */
export function dragGlobe(
  m: GlobeMotion,
  dx: number,
  dtMs: number,
  radiusPx: number,
  still = false,
): void {
  const r = Math.max(40, radiusPx);
  const dYaw = dx / r;
  m.yaw = wrapAngle(m.yaw + dYaw);
  m.idleMs = 0;
  m.away = true;
  m.easeMs = -1;
  if (still) m.yawSpeed = 0;
  else if (dtMs > 0) m.yawSpeed = 0.7 * m.yawSpeed + 0.3 * (dYaw / dtMs);
}

/** The pointer was held still before letting go: no coasting. */
export function stopCoasting(m: GlobeMotion): void {
  m.yawSpeed = 0;
}

/* ───────────────────────── the arcs' comets ───────────────────────── */

/** How the arcs move: looping (live), once per replay step, or not at all. */
export type ArcTiming = 'live' | 'replay' | 'still';

/** Live: each arc launches once every LIVE_PERIOD_MS, at its own moment in the period. */
export const LIVE_PERIOD_MS = 5200;
/** A flight from the source to StockPilot takes between these, by the arc's own offset. */
export const FLIGHT_MIN_MS = 1600;
export const FLIGHT_MAX_MS = 2400;
/** Replay: each arc launches within REPLAY_SPREAD_MS of its step's start and flies REPLAY_FLIGHT_MS. */
export const REPLAY_SPREAD_MS = 400;
export const REPLAY_FLIGHT_MS = 1600;
/** The comet's tail, as a share of the arc. */
export const TRAIL = 0.32;
/** The ring where a head lands lasts this long. */
export const RING_MS = 900;
/** The faint full-length track: fades in at launch, stays this long after landing, then fades out. */
export const TRACK_IN_MS = 250;
export const TRACK_HOLD_MS = 1100;
export const TRACK_OUT_MS = 700;
/** A still arc (reduced motion, paused, stopped): its whole track at this strength. */
export const STILL_TRACK = 0.6;

/** What one arc shows in one frame. */
export interface ArcFrame {
  /** Where the head is along the arc (0 to 1, then up to 1 + TRAIL while its tail drains in); -1: none. */
  head: number;
  /** How strong the faint full-length track is (0 to 1). */
  track: number;
  /** The landing ring: 0 to 1 while it runs, -1 when there is none. */
  ring: number;
}

export const createArcFrame = (): ArcFrame => ({ head: -1, track: 0, ring: -1 });

/** A number from 0 to 1 that stays the same for a key, so arcs do not all move together. */
export function arcOffset(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** A live arc's flight time, between FLIGHT_MIN_MS and FLIGHT_MAX_MS, the same for the same offset. */
export function flightMs(offset: number): number {
  const spread = (((offset * 7.31 + 0.13) % 1) + 1) % 1;
  return FLIGHT_MIN_MS + (FLIGHT_MAX_MS - FLIGHT_MIN_MS) * spread;
}

/** The track's strength `since` ms after launch, for a flight of `flight` ms. */
function trackAt(since: number, flight: number): number {
  if (since < 0) return 0;
  if (since < TRACK_IN_MS) return since / TRACK_IN_MS;
  const out = since - flight - TRACK_HOLD_MS;
  if (out <= 0) return 1;
  return Math.max(0, 1 - out / TRACK_OUT_MS);
}

/**
 * One arc's frame, written into `out`. `elapsedMs` is the time since the
 * play began (live) or since the replay step began (replay). Live arcs
 * launch at their own moment in the period, so they never all go at once;
 * a replay step's arcs launch within its first REPLAY_SPREAD_MS, and their
 * tracks fade out as the step ends. Still: the whole track, no head, no ring.
 */
export function arcFrameAt(
  out: ArcFrame,
  timing: ArcTiming,
  elapsedMs: number,
  offset: number,
  stepMs: number = Number.POSITIVE_INFINITY,
): void {
  if (timing === 'still') {
    out.head = -1;
    out.track = STILL_TRACK;
    out.ring = -1;
    return;
  }
  let since: number;
  let flight: number;
  if (timing === 'live') {
    const shifted = elapsedMs + offset * LIVE_PERIOD_MS;
    since = ((shifted % LIVE_PERIOD_MS) + LIVE_PERIOD_MS) % LIVE_PERIOD_MS;
    flight = flightMs(offset);
  } else {
    since = elapsedMs - offset * REPLAY_SPREAD_MS;
    flight = REPLAY_FLIGHT_MS;
  }
  const head = since < 0 ? -1 : since / flight;
  out.head = head > 1 + TRAIL ? -1 : head;
  const landed = since - flight;
  out.ring = landed >= 0 && landed < RING_MS ? landed / RING_MS : -1;
  let track = trackAt(since, flight);
  if (timing === 'replay' && Number.isFinite(stepMs)) {
    // The step's arcs leave together at its end: their tracks fade out first.
    const left = stepMs - elapsedMs;
    track *= Math.min(1, Math.max(0, left / 350));
  }
  out.track = track;
}

/* ───────────────────────── marks, labels, the land ───────────────────────── */

/** A source's mark, in CSS pixels across: 10 for one event to 18 at core's widest (log scale). */
export function sourceMarkSize(width: number): number {
  const w = Math.min(4, Math.max(1, Number.isFinite(width) ? width : 1));
  return 10 + ((w - 1) / 3) * 8;
}

/**
 * How strongly a source country's land glows: its events against the most of
 * any country in the play, on a log scale: over 0.35 for any events, 1 for
 * the most; 0 for none.
 */
export function heatOf(events: number, most: number): number {
  if (!(events > 0) || !(most > 0)) return 0;
  return 0.35 + 0.65 * (Math.log1p(Math.min(events, most)) / Math.log1p(most));
}

/**
 * How visible a place on the globe is, by its angle from the middle of the
 * view as seen from the globe's centre (its cosine): 1 well inside the limb,
 * fading to 0 over the last `fade` radians before it, 0 beyond. `limbCos` is
 * the cosine of the limb's angle (the camera's distance gives it: 1 / d).
 */
export function limbFade(cosAngle: number, limbCos: number, fade: number): number {
  const angle = Math.acos(Math.min(1, Math.max(-1, cosAngle)));
  const limb = Math.acos(Math.min(1, Math.max(-1, limbCos)));
  return Math.min(1, Math.max(0, (limb - angle) / fade));
}

/** A label to place: its mark's point on the screen, its own size, whether its mark is visible. */
export interface LabelAnchor {
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
  /** Which spots it may take, in order (StockPilot's label: right, then left). */
  spots: readonly LabelSpot[];
}
export type LabelSpot = 'right' | 'left' | 'above' | 'below';
/** A box on the screen (top-left, size). */
export interface ScreenBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PlacedLabel {
  x: number;
  y: number;
  shown: boolean;
}

const overlaps = (a: ScreenBox, b: ScreenBox, pad: number): boolean =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

/**
 * Places labels beside their marks, in the order given (the most important
 * first): each takes the first of its spots that stays inside `bounds` (with
 * `margin` to spare) and clear of the labels already placed and of the
 * `reserved` boxes (the in-stage panels). A label with no free spot, or whose
 * mark is hidden, is not shown. Writes into `out`, one entry per anchor.
 */
export function placeLabels(
  anchors: readonly LabelAnchor[],
  bounds: { w: number; h: number },
  reserved: readonly ScreenBox[],
  out: PlacedLabel[],
  gap = 10,
  margin = 8,
): void {
  const placed: ScreenBox[] = [];
  for (let i = 0; i < anchors.length; i += 1) {
    const a = anchors[i]!;
    const slot = out[i] ?? { x: 0, y: 0, shown: false };
    out[i] = slot;
    slot.shown = false;
    if (!a.visible) continue;
    for (const spot of a.spots) {
      const x = spot === 'right' ? a.x + gap : spot === 'left' ? a.x - gap - a.w : a.x - a.w / 2;
      const y = spot === 'above' ? a.y - gap - a.h : spot === 'below' ? a.y + gap : a.y - a.h / 2;
      const box = { x, y, w: a.w, h: a.h };
      if (x < margin || y < margin || x + a.w > bounds.w - margin || y + a.h > bounds.h - margin) {
        continue;
      }
      if (placed.some((p) => overlaps(p, box, 4)) || reserved.some((r) => overlaps(r, box, 0))) {
        continue;
      }
      placed.push(box);
      slot.x = x;
      slot.y = y;
      slot.shown = true;
      break;
    }
  }
}

/**
 * The scenery's stars: `count` points, the same on every load (a fixed seed),
 * as x and y from -1 to 1 across the stage and a brightness from 0.25 to 1.
 * Scenery only: they never move but with the globe's turn, never pulse, and
 * are far smaller and dimmer than any mark.
 */
export function writeStars(count: number, seed: number): Float32Array {
  const out = new Float32Array(count * 3);
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i += 1) {
    out[i * 3] = next() * 2 - 1;
    out[i * 3 + 1] = next() * 2 - 1;
    out[i * 3 + 2] = 0.25 + 0.75 * next() ** 2.2;
  }
  return out;
}
