import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  LineSegments,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
  type IUniform,
} from 'three';

import {
  ARC_SEGMENTS,
  GLOBE_HEIGHT_SHARE,
  TRAIL,
  advanceGlobeMotion,
  arcBow,
  arcFrameAt,
  arcOffset,
  createArcFrame,
  createGlobeMotion,
  dotPositions,
  dragGlobe,
  limbFade,
  lonLatToVector,
  LABEL_LEADER,
  LABEL_SPOTS,
  placeLabels,
  stockpilotSpots,
  pointAlong,
  projectToStage,
  ribbonIndexes,
  ribbonVertexCount,
  sourceMarkSize,
  stopCoasting,
  writeArcPoints,
  writeRibbon,
  writeStars,
  type ArcTiming,
  type GlobeFacing,
  type LabelAnchor,
  type LabelSpot,
  type PlacedLabel,
  type ScreenBox,
  type StageCamera,
} from './globe-math';
import type { GlobeArc } from './map-model';
import type { LonLat } from './world-geometry';

/**
 * THE GLOBE: the one file that touches WebGL (three.js). It cannot run in the
 * test environment, so it holds no rule: what to draw, how arcs move, which
 * way the globe faces and where labels go all come from globe-math.ts and the
 * island (tested). This file only puts them on the screen.
 *
 * Our own look, drawn from our own data and shaders: no texture, image or
 * font from anywhere. The glow is additive blending and falloff in the
 * shaders (no post-processing pass). Scenery (the stars, the graticule, the
 * halo) is far dimmer and smaller than anything that stands for data, and
 * never pulses.
 *
 * Well behaved: the pixel ratio is capped at 2; one requestAnimationFrame
 * loop, which stops when the island says the globe is not on screen (a hidden
 * tab or a canvas scrolled away) and when nothing moves; nothing is made per
 * frame (every buffer is made once, at the most arcs there can be, and
 * written into); when frames run slow (over 24 ms for 2 s) the stars and the
 * halos go first; dispose() frees every geometry, material and texture, the
 * renderer and its context, and every listener. A lost context stops the
 * loop and is reported once, so the island can show the flat map.
 */

export type { GlobeArc };

export interface GlobeScene {
  arcs: readonly GlobeArc[];
  timing: ArcTiming;
  /** The moment (performance.now()) the live play or the replay step began. */
  startedAt: number;
  /** A replay step's length: its arcs' tracks fade out as it ends. */
  stepMs: number;
  /** Where to face, yaw and tilt and the sway's reach (globe-math facingOf), or null to stay. */
  target: GlobeFacing | null;
  /** Whether the globe may turn on its own (nothing stops the play). */
  mayTurn: boolean;
  /** Reduced motion: nothing moves on its own, no pulse, no flight. */
  still: boolean;
  /** How strongly each source country's land glows (0 to 1), by ISO code. */
  heat: ReadonlyMap<string, number>;
}

/** A label over the canvas: an element the island made, and the place it belongs to. */
export interface GlobeLabel {
  el: HTMLElement;
  lonLat: LonLat;
  kind: 'stockpilot' | 'source';
}

/** The parts of the stage the island covers with its own panels, in CSS pixels. */
export interface StageInsets {
  /** The top-left corner (the mode pill): its width and height. */
  topLeft: { w: number; h: number };
  /** The strip at the right (the flagged panel), 0 when there is none. */
  right: number;
  /** The strip along the bottom (the legend and the ticker). */
  bottom: number;
}

export interface GlobeHandle {
  show(scene: GlobeScene): void;
  /** Whether the globe is on screen: false stops every frame until it is again. */
  setRunning(running: boolean): void;
  resize(width: number, height: number, insets: StageInsets): void;
  /** The HTML labels to keep beside their places (StockPilot first, then by importance). */
  setLabels(labels: readonly GlobeLabel[]): void;
  dispose(): void;
}

export interface GlobeOptions {
  /** The land dots, as longitude and latitude pairs. */
  land: Float32Array;
  /** Which country each land dot is in: 1 + its place in `codes`, 0 for none; null when unknown. */
  owners: { index: Uint8Array; codes: readonly string[] } | null;
  stockpilot: LonLat;
  /** Called once, when the browser takes the drawing context away. */
  onContextLost: () => void;
}

/** At most this many arcs are drawn (core's plan never hands over more). */
export const GLOBE_MAX_ARCS = 40;

const DOT_RADIUS = 1.003;
const MARK_RADIUS = 1.004;
/** Half of StockPilot's mark on the screen, with its inner ring (CSS px). */
const HOME_MARK_HALF = 9;
const CAMERA_FOV = 30;
const HALO_SIZE = 1.7;
/** Frames slower than this, for this long, drop the scenery first. */
const SLOW_FRAME_MS = 24;
const SLOW_FOR_MS = 2000;

/* ─────────────────────────────── the shaders ─────────────────────────────── */

/** How visible a point is (view space), by its angle from the view's middle seen from the globe's centre. */
const LIMB = /* glsl */ `
float limbFade(vec3 p, vec3 centre, float fadeRadians) {
  vec3 g = normalize(p - centre);
  vec3 e = normalize(-centre);
  float a = acos(clamp(dot(g, e), -1.0, 1.0));
  float limb = acos(clamp(1.0 / length(centre), -1.0, 1.0));
  return clamp((limb - a) / fadeRadians, 0.0, 1.0);
}`;

/**
 * How much of an arc's point (view space) is shown. An arc whose two ends are
 * both in view is drawn whole (it may arch past the globe's edge: both ends
 * are on marks). Once either end goes over the horizon, the arc is drawn only
 * where it is inside the globe's disc and in front of it, so it disappears
 * at the globe's edge as if going over the horizon, and never ends in empty
 * space; the change from one rule to the other is smooth as the globe turns.
 */
const ARC_SEEN = /* glsl */ `
float groundAngle(vec3 p, vec3 centre) {
  return acos(clamp(dot(normalize(p - centre), normalize(-centre)), -1.0, 1.0));
}
float arcSeen(vec3 p, vec3 origin, vec3 home, vec3 centre) {
  float limb = acos(clamp(1.0 / length(centre), -1.0, 1.0));
  float ends = max(groundAngle(origin, centre), groundAngle(home, centre));
  float crossing = smoothstep(limb - radians(10.0), limb - radians(1.0), ends);
  float ground = clamp((limb - groundAngle(p, centre)) / radians(8.0), 0.0, 1.0);
  vec3 dir = normalize(p);
  float along = dot(centre, dir);
  float off = length(centre - along * dir);
  float inDisc = 1.0 - smoothstep(0.955, 1.0, off);
  float nearHit = along - sqrt(max(0.0, 1.0 - off * off));
  float front = off >= 1.0 ? 1.0 : step(length(p), nearHit + 0.015);
  return mix(ground, inDisc * front, crossing);
}`;

const STARS_VERTEX = /* glsl */ `
attribute float aBright;
uniform float uShift;
uniform float uSize;
varying float vBright;
void main() {
  float x = fract(position.x * 0.5 + 0.5 + uShift) * 2.0 - 1.0;
  vBright = aBright;
  gl_PointSize = uSize;
  gl_Position = vec4(x * 1.04, position.y * 1.04, 0.9999, 1.0);
}`;

const STARS_FRAGMENT = /* glsl */ `
varying float vBright;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float a = pow(1.0 - r, 2.0) * vBright * 0.5;
  gl_FragColor = vec4(vec3(0.78, 0.85, 1.0), a);
}`;

const HALO_VERTEX = /* glsl */ `
varying vec2 vXY;
void main() {
  vXY = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const HALO_FRAGMENT = /* glsl */ `
uniform float uEdge;
uniform vec3 uColour;
varying vec2 vXY;
void main() {
  float r = length(vXY);
  if (r < uEdge * 0.985) discard;
  float out1 = max(0.0, r - uEdge);
  float tight = exp(-out1 / 0.028) * 0.55;
  float wide = exp(-out1 / 0.16) * 0.22;
  float side = 0.82 + 0.18 * dot(normalize(vXY), normalize(vec2(-0.55, 0.8)));
  float inner = smoothstep(uEdge * 0.985, uEdge * 1.004, r);
  float a = (tight + wide) * side * inner;
  gl_FragColor = vec4(uColour, a);
}`;

const GLOBE_VERTEX = /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const GLOBE_FRAGMENT = /* glsl */ `
uniform vec3 uDeep;
uniform vec3 uLit;
uniform vec3 uRim;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec3 n = normalize(vNormal);
  float facing = clamp(dot(n, normalize(vView)), 0.0, 1.0);
  float light = clamp(dot(n, normalize(vec3(-0.5, 0.62, 0.6))), 0.0, 1.0);
  vec3 colour = mix(uDeep, uLit, 0.35 + 0.65 * pow(light, 1.6));
  colour *= 0.55 + 0.45 * pow(facing, 0.6);
  float rim = pow(1.0 - facing, 3.2);
  colour += uRim * rim * 0.95;
  gl_FragColor = vec4(colour, 1.0);
}`;

const GRID_VERTEX = /* glsl */ `
varying float vSeen;
${LIMB}
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 centre = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vSeen = limbFade(mv.xyz, centre, 0.5);
  gl_Position = projectionMatrix * mv;
}`;

const GRID_FRAGMENT = /* glsl */ `
uniform float uAlpha;
varying float vSeen;
void main() {
  if (vSeen <= 0.0) discard;
  gl_FragColor = vec4(vec3(0.55, 0.72, 1.0), uAlpha * vSeen);
}`;

const DOTS_VERTEX = /* glsl */ `
attribute float aHeat;
uniform float uSize;
uniform float uScale;
uniform float uPulse;
varying float vFacing;
varying float vLight;
varying float vHeat;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * position);
  vFacing = dot(n, normalize(-mv.xyz));
  vLight = dot(n, normalize(vec3(-0.5, 0.62, 0.6)));
  // Toward the limb the dots crowd together on the screen: they shrink, and a
  // source country's glow thins out, so neither bands into stripes there.
  float face = clamp(vFacing, 0.0, 1.0);
  float thin = smoothstep(0.0, 0.65, face);
  vHeat = aHeat * (0.78 + 0.22 * uPulse) * smoothstep(0.12, 0.7, face);
  gl_PointSize = uSize * uScale * mix(0.5, 1.0, thin) * (1.0 + 0.35 * aHeat * thin) / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const DOTS_FRAGMENT = /* glsl */ `
uniform vec3 uColour;
uniform vec3 uWarm;
varying float vFacing;
varying float vLight;
varying float vHeat;
void main() {
  if (vFacing <= 0.0) discard;
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  float core = 1.0 - smoothstep(0.16, 0.5, d);
  float lit = mix(0.5, 1.0, smoothstep(-0.35, 0.85, vLight));
  float edge = smoothstep(0.0, 0.42, vFacing);
  vec3 colour = mix(uColour, uWarm, vHeat);
  float a = core * edge * lit * mix(0.62, 1.0, vHeat);
  gl_FragColor = vec4(colour * (0.8 + 0.5 * core), a);
}`;

const ARC_VERTEX = /* glsl */ `
attribute vec3 previous;
attribute vec3 next;
attribute float side;
attribute float along;
attribute float distance;
attribute float arc;
attribute vec3 origin;
uniform vec3 uHome;
uniform vec4 uArcA[${GLOBE_MAX_ARCS}];
uniform vec4 uArcB[${GLOBE_MAX_ARCS}];
uniform vec2 uResolution;
varying float vAlong;
varying float vSide;
varying float vDistance;
varying float vSeen;
varying float vHalf;
varying vec4 vA;
varying vec4 vB;
${ARC_SEEN}
vec2 onScreen(vec4 clip) { return clip.xy / clip.w * uResolution * 0.5; }
void main() {
  int i = int(arc + 0.5);
  vA = uArcA[i];
  vB = uArcB[i];
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec4 clip = projectionMatrix * mv;
  vec2 here = onScreen(clip);
  vec2 before = onScreen(projectionMatrix * modelViewMatrix * vec4(previous, 1.0));
  vec2 after = onScreen(projectionMatrix * modelViewMatrix * vec4(next, 1.0));
  vec2 dir = after - before;
  dir = length(dir) < 1e-4 ? vec2(1.0, 0.0) : normalize(dir);
  float taper = mix(0.4, 1.0, smoothstep(0.0, 0.05, along) * smoothstep(1.0, 0.95, along));
  float halfWidth = vB.w * taper;
  clip.xy += vec2(-dir.y, dir.x) * side * halfWidth / (uResolution * 0.5) * clip.w;
  gl_Position = clip;
  vec3 centre = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 from = (modelViewMatrix * vec4(origin, 1.0)).xyz;
  vec3 home = (modelViewMatrix * vec4(uHome, 1.0)).xyz;
  vSeen = arcSeen(mv.xyz, from, home, centre);
  vAlong = along;
  vSide = side;
  vDistance = distance;
  vHalf = halfWidth;
}`;

const ARC_FRAGMENT = /* glsl */ `
uniform float uTrail;
varying float vAlong;
varying float vSide;
varying float vDistance;
varying float vSeen;
varying float vHalf;
varying vec4 vA;
varying vec4 vB;
void main() {
  if (vSeen <= 0.0) discard;
  float head = vA.x;
  float track = vA.y;
  bool flagged = vA.z > 0.5;
  float px = abs(vSide) * vHalf;
  float coreHalf = vHalf * 0.5;
  float core = 1.0 - smoothstep(coreHalf - 0.7, coreHalf + 0.5, px);
  float glow = exp(-pow(px / (vHalf * 0.62), 2.0));
  float dt = head - vAlong;
  float tail = (head >= 0.0 && dt >= 0.0 && dt <= uTrail) ? pow(1.0 - dt / uTrail, 2.4) : 0.0;
  float flare = (head >= 0.0 && head <= 1.0 && dt >= 0.0) ? exp(-dt * 90.0) : 0.0;
  bool gap = flagged && fract(vDistance * 24.0) > 0.56;
  float trackA = gap ? 0.0 : track * (0.26 * core + 0.07 * glow);
  float tailA = gap ? 0.0 : tail * (0.95 * core + 0.38 * glow);
  float flareA = flagged ? 0.0 : flare * (core + 0.5 * glow);
  float a = (max(trackA, tailA) + flareA) * vSeen;
  if (a < 0.004) discard;
  vec3 colour = mix(vB.rgb, vec3(1.0), clamp(flare * 0.85 + tail * tail * 0.22, 0.0, 1.0));
  gl_FragColor = vec4(colour, a);
}`;

const HEADS_VERTEX = /* glsl */ `
attribute vec3 aColour;
attribute float aAlpha;
attribute float aHollow;
attribute vec3 aOrigin;
uniform vec3 uHome;
uniform float uPixelRatio;
varying vec3 vColour;
varying float vAlpha;
varying float vHollow;
${ARC_SEEN}
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 centre = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 from = (modelViewMatrix * vec4(aOrigin, 1.0)).xyz;
  vec3 home = (modelViewMatrix * vec4(uHome, 1.0)).xyz;
  vColour = aColour;
  vHollow = aHollow;
  vAlpha = aAlpha * arcSeen(mv.xyz, from, home, centre);
  gl_PointSize = 26.0 * uPixelRatio;
  gl_Position = projectionMatrix * mv;
}`;

const HEADS_FRAGMENT = /* glsl */ `
varying vec3 vColour;
varying float vAlpha;
varying float vHollow;
void main() {
  if (vAlpha <= 0.0) discard;
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float halo = exp(-r * 5.0) * 0.8;
  float body = vHollow > 0.5
    ? 1.0 - smoothstep(0.035, 0.075, abs(r - 0.2))
    : 1.0 - smoothstep(0.09, 0.17, r);
  vec3 colour = mix(vColour, vec3(1.0), body * (vHollow > 0.5 ? 0.35 : 0.8));
  gl_FragColor = vec4(colour, max(halo * (vHollow > 0.5 ? 0.45 : 1.0), body) * vAlpha);
}`;

/*
 * The source marks: one per arc, the category's shape (filled for blocked,
 * hollow for flagged), with a soft halo and a slow pulse. aNudge moves marks
 * that share a country a few pixels apart, so each shape stays readable.
 */
const MARKS_VERTEX = /* glsl */ `
attribute vec3 aColour;
attribute float aShape;
attribute float aHollow;
attribute float aSize;
attribute float aPhase;
attribute vec2 aNudge;
uniform float uPixelRatio;
uniform vec2 uResolution;
varying vec3 vColour;
varying float vShape;
varying float vHollow;
varying float vPhase;
varying float vSeen;
${LIMB}
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 centre = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vColour = aColour;
  vShape = aShape;
  vHollow = aHollow;
  vPhase = aPhase;
  vSeen = aShape < 0.0 ? 0.0 : limbFade(mv.xyz, centre, radians(8.0));
  gl_PointSize = aSize * 2.6 * uPixelRatio;
  vec4 clip = projectionMatrix * mv;
  clip.xy += aNudge * uPixelRatio / (uResolution * 0.5) * clip.w;
  gl_Position = clip;
}`;

const MARKS_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uMotion;
uniform float uHalo;
varying vec3 vColour;
varying float vShape;
varying float vHollow;
varying float vPhase;
varying float vSeen;
float shapeDistance(vec2 q, float shape) {
  if (shape < 0.5) return length(q);
  if (shape < 1.5) return (abs(q.x) + abs(q.y)) * 0.78;
  if (shape < 2.5) return max(abs(q.x), abs(q.y)) * 1.06;
  if (shape < 3.5) return max(abs(q.x) * 0.866 + q.y * 0.5, -q.y) * 1.6;
  return max(abs(q.x) * 0.866 + abs(q.y) * 0.5, abs(q.y)) * 1.1;
}
void main() {
  if (vSeen <= 0.0) discard;
  // The sprite is 2.6 marks wide (room for the halo and the pulse): p is 1 at the mark's edge.
  vec2 p = (gl_PointCoord - 0.5) * 2.0 * 2.6;
  p.y = -p.y;
  float r = length(p);
  float d = shapeDistance(p, vShape);
  float fill = 1.0 - smoothstep(0.9, 1.0, d);
  float outline = 1.0 - smoothstep(0.1, 0.2, abs(d - 0.86));
  float mark = vHollow > 0.5 ? outline : fill;
  float rim = vHollow > 0.5 ? 0.0 : (1.0 - smoothstep(0.05, 0.14, abs(d - 0.96))) * 0.5;
  float cycle = fract(uTime / 3200.0 + vPhase);
  float ringAt = 1.05 + cycle * 1.1;
  float pulse = uMotion * (1.0 - smoothstep(0.0, 0.07, abs(d - ringAt))) * (1.0 - cycle) * 0.55;
  float halo = uHalo * exp(-max(0.0, r - 0.7) * 2.2) * 0.3;
  float a = max(max(mark, pulse), halo) * vSeen;
  if (a < 0.01) discard;
  vec3 colour = mix(vColour, vec3(1.0), (mark * 0.18 + rim) * (vHollow > 0.5 ? 0.4 : 1.0));
  gl_FragColor = vec4(colour, a);
}`;

/*
 * The rings on the surface at StockPilot, in its tangent plane: one per arc,
 * where its head lands (blocked: a crisp ring in the kind's colour that
 * stops short, like hitting a shield; flagged: a hollow dashed ring that
 * fades as it goes), and StockPilot's own two slow rings (aArc < 0).
 */
const RINGS_VERTEX = /* glsl */ `
attribute vec2 aCorner;
attribute float aArc;
uniform vec3 uAt;
uniform vec3 uEast;
uniform vec3 uNorth;
uniform float uSize;
varying vec2 vCorner;
varying float vArc;
varying float vSeen;
${LIMB}
void main() {
  vec3 p = uAt + (aCorner.x * uEast + aCorner.y * uNorth) * uSize;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 centre = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vSeen = limbFade((modelViewMatrix * vec4(uAt, 1.0)).xyz, centre, radians(12.0));
  vCorner = aCorner;
  vArc = aArc;
  gl_Position = projectionMatrix * mv;
}`;

const RINGS_FRAGMENT = /* glsl */ `
uniform vec4 uRing[${GLOBE_MAX_ARCS}];
uniform vec4 uArcB[${GLOBE_MAX_ARCS}];
uniform float uTime;
uniform float uMotion;
varying vec2 vCorner;
varying float vArc;
varying float vSeen;
void main() {
  if (vSeen <= 0.0) discard;
  float r = length(vCorner);
  if (r > 1.0) discard;
  vec3 colour;
  float a;
  if (vArc < 0.0) {
    // StockPilot's own two rings: slow, and still under reduced motion.
    float k = -vArc - 1.0;
    float cycle = fract(uTime / 4200.0 + k * 0.5);
    float at = uMotion > 0.5 ? mix(0.22, 0.62, cycle) : mix(0.3, 0.5, k);
    float fade = uMotion > 0.5 ? (1.0 - cycle) * smoothstep(0.0, 0.15, cycle) : 0.8;
    a = (1.0 - smoothstep(0.012, 0.03, abs(r - at))) * fade * 0.7;
    colour = vec3(0.92, 0.96, 1.0);
  } else {
    vec4 ring = uRing[int(vArc + 0.5)];
    float t = ring.x;
    if (t < 0.0) discard;
    colour = uArcB[int(vArc + 0.5)].rgb;
    if (ring.y > 0.5) {
      float at = mix(0.2, 0.95, t);
      float dash = step(0.5, fract(atan(vCorner.y, vCorner.x) / 6.2831853 * 18.0));
      a = (1.0 - smoothstep(0.012, 0.03, abs(r - at))) * dash * (1.0 - t) * 0.9;
    } else {
      float grow = 1.0 - pow(1.0 - min(1.0, t / 0.28), 3.0);
      float at = mix(0.18, 0.78, grow);
      float fade = 1.0 - smoothstep(0.3, 1.0, t);
      a = (1.0 - smoothstep(0.014, 0.034, abs(r - at))) * fade;
      a += exp(-abs(r - at) * 30.0) * fade * 0.3;
    }
  }
  a *= vSeen;
  if (a < 0.01) discard;
  gl_FragColor = vec4(colour, a);
}`;

const BEACON_VERTEX = /* glsl */ `
uniform float uPixelRatio;
varying float vSeen;
${LIMB}
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 centre = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vSeen = limbFade(mv.xyz, centre, radians(12.0));
  gl_PointSize = 30.0 * uPixelRatio;
  gl_Position = projectionMatrix * mv;
}`;

const BEACON_FRAGMENT = /* glsl */ `
varying float vSeen;
void main() {
  if (vSeen <= 0.0) discard;
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float core = 1.0 - smoothstep(0.13, 0.2, r);
  float halo = exp(-r * 4.2) * 0.9;
  gl_FragColor = vec4(vec3(1.0, 0.99, 0.96), max(core, halo) * vSeen);
}`;

/* ─────────────────────────────── the globe ─────────────────────────────── */

const vec3 = (r: number, g: number, b: number): IUniform<Vector3> => ({
  value: new Vector3(r, g, b),
});

function dynamic(array: Float32Array, itemSize: number): BufferAttribute {
  return new BufferAttribute(array, itemSize).setUsage(DynamicDrawUsage);
}

/** The graticule: every 30 degrees of latitude and longitude, as line segments on the sphere. */
function graticule(radius: number): Float32Array {
  const out: number[] = [];
  const v = [0, 0, 0];
  const w = [0, 0, 0];
  const segment = (a: LonLat, b: LonLat) => {
    lonLatToVector(a[0], a[1], radius, v);
    lonLatToVector(b[0], b[1], radius, w);
    out.push(v[0]!, v[1]!, v[2]!, w[0]!, w[1]!, w[2]!);
  };
  for (let lat = -60; lat <= 60; lat += 30) {
    for (let lon = -180; lon < 180; lon += 3) segment([lon, lat], [lon + 3, lat]);
  }
  for (let lon = -180; lon < 180; lon += 30) {
    for (let lat = -84; lat < 84; lat += 3) segment([lon, lat], [lon, Math.min(84, lat + 3)]);
  }
  return new Float32Array(out);
}

/**
 * Makes the globe on `canvas`. Throws when the browser cannot give a WebGL 2
 * context (three.js r163 and later need one): the island then shows the flat
 * map. The island tests for WebGL before it loads this file at all.
 */
export function createGlobe(canvas: HTMLCanvasElement, options: GlobeOptions): GlobeHandle {
  const renderer = new WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, 60);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);

  const world = new Group();
  scene.add(world);

  const pixelRatio: IUniform<number> = { value: 1 };
  const resolution: IUniform<{ x: number; y: number }> = { value: { x: 1, y: 1 } };
  const time: IUniform<number> = { value: 0 };
  const motionOn: IUniform<number> = { value: 1 };
  const haloOn: IUniform<number> = { value: 1 };
  const disposables: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(thing: T): T => {
    disposables.push(thing);
    return thing;
  };
  const additive = { blending: AdditiveBlending, transparent: true, depthWrite: false } as const;

  /* The stars: two layers, scenery only. */
  const starLayers = [
    { count: 240, size: 1.4, speed: 0.012, seed: 11 },
    { count: 70, size: 2.2, speed: 0.03, seed: 29 },
  ].map(({ count, size, speed, seed }) => {
    const data = writeStars(count, seed);
    const positions = new Float32Array(count * 3);
    const bright = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = data[i * 3] as number;
      positions[i * 3 + 1] = data[i * 3 + 1] as number;
      bright[i] = data[i * 3 + 2] as number;
    }
    const geometry = keep(new BufferGeometry());
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aBright', new BufferAttribute(bright, 1));
    const uniforms = { uShift: { value: 0 }, uSize: { value: size } };
    const points = new Points(
      geometry,
      keep(
        new ShaderMaterial({
          uniforms,
          vertexShader: STARS_VERTEX,
          fragmentShader: STARS_FRAGMENT,
          ...additive,
          depthTest: false,
        }),
      ),
    );
    points.frustumCulled = false;
    points.renderOrder = -10;
    scene.add(points);
    return { points, uniforms, size, speed };
  });

  /* The halo: a soft glow just outside the globe's edge, on a plane facing the camera. */
  const haloEdge: IUniform<number> = { value: 1 };
  const halo = new Mesh(
    keep(new PlaneGeometry(HALO_SIZE * 2, HALO_SIZE * 2)),
    keep(
      new ShaderMaterial({
        uniforms: { uEdge: haloEdge, uColour: vec3(0.3, 0.56, 1.0) },
        vertexShader: HALO_VERTEX,
        fragmentShader: HALO_FRAGMENT,
        ...additive,
        depthTest: false,
      }),
    ),
  );
  halo.renderOrder = -5;
  scene.add(halo);

  /* The body of the globe: the ocean. */
  const body = new Mesh(
    keep(new SphereGeometry(1, 128, 96)),
    keep(
      new ShaderMaterial({
        uniforms: {
          uDeep: vec3(0.012, 0.024, 0.06),
          uLit: vec3(0.05, 0.1, 0.22),
          uRim: vec3(0.22, 0.48, 1.0),
        },
        vertexShader: GLOBE_VERTEX,
        fragmentShader: GLOBE_FRAGMENT,
      }),
    ),
  );
  body.renderOrder = 0;
  world.add(body);

  /* The graticule. */
  const gridGeometry = keep(new BufferGeometry());
  gridGeometry.setAttribute('position', new BufferAttribute(graticule(1.001), 3));
  const grid = new LineSegments(
    gridGeometry,
    keep(
      new ShaderMaterial({
        uniforms: { uAlpha: { value: 0.06 } },
        vertexShader: GRID_VERTEX,
        fragmentShader: GRID_FRAGMENT,
        ...additive,
      }),
    ),
  );
  grid.renderOrder = 1;
  world.add(grid);

  /* The land: one point per dot; a source country's dots glow warm. */
  const dotCount = options.land.length / 2;
  const dotsGeometry = keep(new BufferGeometry());
  dotsGeometry.setAttribute(
    'position',
    new BufferAttribute(dotPositions(options.land, DOT_RADIUS), 3),
  );
  const heat = new Float32Array(dotCount);
  const heatAttribute = dynamic(heat, 1);
  dotsGeometry.setAttribute('aHeat', heatAttribute);
  const dotScale: IUniform<number> = { value: 1 };
  const dotPulse: IUniform<number> = { value: 0 };
  const dots = new Points(
    dotsGeometry,
    keep(
      new ShaderMaterial({
        uniforms: {
          uColour: vec3(0.36, 0.6, 1.0),
          uWarm: vec3(1.0, 0.9, 0.74),
          // A dot's width on the globe, in globe radii (the dots are about 0.017 apart).
          uSize: { value: 0.0105 },
          uScale: dotScale,
          uPulse: dotPulse,
        },
        vertexShader: DOTS_VERTEX,
        fragmentShader: DOTS_FRAGMENT,
        ...additive,
      }),
    ),
  );
  dots.renderOrder = 2;
  world.add(dots);
  const owners = options.owners && options.owners.index.length === dotCount ? options.owners : null;

  /* StockPilot's point on the surface, where every arc ends. */
  const home = new Float32Array(3);
  lonLatToVector(options.stockpilot[0], options.stockpilot[1], 1, home);
  const homeUniform = { value: new Vector3(home[0], home[1], home[2]) };

  /* The arcs: every ribbon in one geometry, made once at the most there can be. */
  const perRibbon = ribbonVertexCount(ARC_SEGMENTS);
  const arcVertices = perRibbon * GLOBE_MAX_ARCS;
  const ribbon = {
    position: new Float32Array(arcVertices * 3),
    previous: new Float32Array(arcVertices * 3),
    next: new Float32Array(arcVertices * 3),
    side: new Float32Array(arcVertices),
    along: new Float32Array(arcVertices),
    distance: new Float32Array(arcVertices),
  };
  const arcOrigin = new Float32Array(arcVertices * 3);
  const arcOriginAttribute = dynamic(arcOrigin, 3);
  const arcIndex = new Float32Array(arcVertices);
  for (let i = 0; i < arcVertices; i += 1) arcIndex[i] = Math.floor(i / perRibbon);
  const arcGeometry = keep(new BufferGeometry());
  arcGeometry.setAttribute('position', dynamic(ribbon.position, 3));
  arcGeometry.setAttribute('previous', dynamic(ribbon.previous, 3));
  arcGeometry.setAttribute('next', dynamic(ribbon.next, 3));
  arcGeometry.setAttribute('side', dynamic(ribbon.side, 1));
  arcGeometry.setAttribute('along', dynamic(ribbon.along, 1));
  arcGeometry.setAttribute('distance', dynamic(ribbon.distance, 1));
  arcGeometry.setAttribute('arc', new BufferAttribute(arcIndex, 1));
  arcGeometry.setAttribute('origin', arcOriginAttribute);
  arcGeometry.setIndex(new BufferAttribute(ribbonIndexes(ARC_SEGMENTS, GLOBE_MAX_ARCS), 1));
  arcGeometry.setDrawRange(0, 0);
  const arcA = new Float32Array(GLOBE_MAX_ARCS * 4);
  const arcB = new Float32Array(GLOBE_MAX_ARCS * 4);
  const arcs = new Mesh(
    arcGeometry,
    keep(
      new ShaderMaterial({
        uniforms: {
          uArcA: { value: arcA },
          uArcB: { value: arcB },
          uResolution: resolution,
          uTrail: { value: TRAIL },
          uHome: homeUniform,
        },
        vertexShader: ARC_VERTEX,
        fragmentShader: ARC_FRAGMENT,
        ...additive,
        depthTest: false,
        side: DoubleSide,
      }),
    ),
  );
  arcs.frustumCulled = false;
  arcs.renderOrder = 4;
  world.add(arcs);
  const arcPoints = new Float32Array((ARC_SEGMENTS + 1) * 3 * GLOBE_MAX_ARCS);
  const slots = Array.from({ length: GLOBE_MAX_ARCS }, (_, i) => ({
    points: arcPoints.subarray(i * (ARC_SEGMENTS + 1) * 3, (i + 1) * (ARC_SEGMENTS + 1) * 3),
    frame: createArcFrame(),
    offset: 0,
  }));

  /* The heads: one point per arc. */
  const headPositions = new Float32Array(GLOBE_MAX_ARCS * 3);
  const headColours = new Float32Array(GLOBE_MAX_ARCS * 3);
  const headAlphas = new Float32Array(GLOBE_MAX_ARCS);
  const headHollow = new Float32Array(GLOBE_MAX_ARCS);
  const headsGeometry = keep(new BufferGeometry());
  const headPositionAttribute = dynamic(headPositions, 3);
  const headColourAttribute = dynamic(headColours, 3);
  const headAlphaAttribute = dynamic(headAlphas, 1);
  const headHollowAttribute = dynamic(headHollow, 1);
  const headOrigins = new Float32Array(GLOBE_MAX_ARCS * 3);
  const headOriginAttribute = dynamic(headOrigins, 3);
  headsGeometry.setAttribute('aOrigin', headOriginAttribute);
  headsGeometry.setAttribute('position', headPositionAttribute);
  headsGeometry.setAttribute('aColour', headColourAttribute);
  headsGeometry.setAttribute('aAlpha', headAlphaAttribute);
  headsGeometry.setAttribute('aHollow', headHollowAttribute);
  const heads = new Points(
    headsGeometry,
    keep(
      new ShaderMaterial({
        uniforms: { uPixelRatio: pixelRatio, uHome: homeUniform },
        vertexShader: HEADS_VERTEX,
        fragmentShader: HEADS_FRAGMENT,
        ...additive,
        depthTest: false,
      }),
    ),
  );
  heads.frustumCulled = false;
  heads.renderOrder = 6;
  world.add(heads);

  /* The source marks: one per arc. */
  const markPositions = new Float32Array(GLOBE_MAX_ARCS * 3);
  const markColours = new Float32Array(GLOBE_MAX_ARCS * 3);
  const markShapes = new Float32Array(GLOBE_MAX_ARCS).fill(-1);
  const markHollow = new Float32Array(GLOBE_MAX_ARCS);
  const markSizes = new Float32Array(GLOBE_MAX_ARCS);
  const markPhases = new Float32Array(GLOBE_MAX_ARCS);
  const markNudges = new Float32Array(GLOBE_MAX_ARCS * 2);
  const marksGeometry = keep(new BufferGeometry());
  const markAttributes = [
    ['position', dynamic(markPositions, 3)],
    ['aColour', dynamic(markColours, 3)],
    ['aShape', dynamic(markShapes, 1)],
    ['aHollow', dynamic(markHollow, 1)],
    ['aSize', dynamic(markSizes, 1)],
    ['aPhase', dynamic(markPhases, 1)],
    ['aNudge', dynamic(markNudges, 2)],
  ] as const;
  for (const [name, attribute] of markAttributes) marksGeometry.setAttribute(name, attribute);
  const marks = new Points(
    marksGeometry,
    keep(
      new ShaderMaterial({
        uniforms: {
          uPixelRatio: pixelRatio,
          uResolution: resolution,
          uTime: time,
          uMotion: motionOn,
          uHalo: haloOn,
        },
        vertexShader: MARKS_VERTEX,
        fragmentShader: MARKS_FRAGMENT,
        // Normal blending: a mark is solid over the land dots, never mixed with them.
        transparent: true,
        depthWrite: false,
        depthTest: false,
      }),
    ),
  );
  marks.frustumCulled = false;
  marks.renderOrder = 5;
  world.add(marks);

  /* StockPilot: the rings on the surface (two of its own, one per arc's landing) and its bright core. */
  const at = new Float32Array(3);
  lonLatToVector(options.stockpilot[0], options.stockpilot[1], MARK_RADIUS, at);
  const lonR = (options.stockpilot[0] * Math.PI) / 180;
  const latR = (options.stockpilot[1] * Math.PI) / 180;
  const east = new Vector3(Math.cos(lonR), 0, -Math.sin(lonR));
  const north = new Vector3(
    -Math.sin(latR) * Math.sin(lonR),
    Math.cos(latR),
    -Math.sin(latR) * Math.cos(lonR),
  );
  const ringQuads = GLOBE_MAX_ARCS + 2;
  const ringCorners = new Float32Array(ringQuads * 4 * 2);
  const ringArcs = new Float32Array(ringQuads * 4);
  const ringIndexes = new Uint16Array(ringQuads * 6);
  for (let q = 0; q < ringQuads; q += 1) {
    const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let k = 0; k < 8; k += 1) ringCorners[q * 8 + k] = corners[k] as number;
    // The first two quads are StockPilot's own rings (-1, -2); then one per arc.
    const id = q < 2 ? -(q + 1) : q - 2;
    for (let k = 0; k < 4; k += 1) ringArcs[q * 4 + k] = id;
    ringIndexes.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
  }
  const ringsGeometry = keep(new BufferGeometry());
  ringsGeometry.setAttribute('position', new BufferAttribute(new Float32Array(ringQuads * 12), 3));
  ringsGeometry.setAttribute('aCorner', new BufferAttribute(ringCorners, 2));
  ringsGeometry.setAttribute('aArc', new BufferAttribute(ringArcs, 1));
  ringsGeometry.setIndex(new BufferAttribute(ringIndexes, 1));
  const ringState = new Float32Array(GLOBE_MAX_ARCS * 4).fill(-1);
  const rings = new Mesh(
    ringsGeometry,
    keep(
      new ShaderMaterial({
        uniforms: {
          uAt: { value: new Vector3(at[0], at[1], at[2]) },
          uEast: { value: east },
          uNorth: { value: north },
          uSize: { value: 0.085 },
          uRing: { value: ringState },
          uArcB: { value: arcB },
          uTime: time,
          uMotion: motionOn,
        },
        vertexShader: RINGS_VERTEX,
        fragmentShader: RINGS_FRAGMENT,
        ...additive,
        depthTest: false,
        side: DoubleSide,
      }),
    ),
  );
  rings.frustumCulled = false;
  rings.renderOrder = 3;
  world.add(rings);

  const beaconGeometry = keep(new BufferGeometry());
  beaconGeometry.setAttribute('position', new BufferAttribute(at.slice(), 3));
  const beacon = new Points(
    beaconGeometry,
    keep(
      new ShaderMaterial({
        uniforms: { uPixelRatio: pixelRatio },
        vertexShader: BEACON_VERTEX,
        fragmentShader: BEACON_FRAGMENT,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      }),
    ),
  );
  beacon.frustumCulled = false;
  beacon.renderOrder = 7;
  world.add(beacon);

  /* ─────────────────────────────── state ─────────────────────────────── */

  const motion = createGlobeMotion(-options.stockpilot[0] * (Math.PI / 180));
  let current: GlobeScene = {
    arcs: [],
    timing: 'still',
    startedAt: 0,
    stepMs: Number.POSITIVE_INFINITY,
    target: null,
    mayTurn: false,
    still: false,
    heat: new Map(),
  };
  let count = 0;
  let running = false;
  let lost = false;
  let disposed = false;
  let frame = 0;
  let lastTime = -1;
  let dragging = false;
  let lastX = 0;
  let lastMoveAt = 0;
  let width = 1;
  let height = 1;
  let insets: StageInsets = { topLeft: { w: 0, h: 0 }, right: 0, bottom: 0 };
  let radiusPx = 1;
  let slowFor = 0;
  let lowQuality = false;
  let labels: Array<{
    label: GlobeLabel;
    point: Float32Array;
    key: string;
    anchor: LabelAnchor;
    fade: number;
  }> = [];
  let anchors: LabelAnchor[] = [];
  const placed: PlacedLabel[] = [];
  const reserved: ScreenBox[] = [];
  const projected = new Float32Array(3);
  const projectedEnd = new Float32Array(3);
  const scratchPoint = new Float32Array(3);
  // How far each source country's marks reach from its point (CSS px), by "lon,lat".
  const markReach = new Map<string, number>();
  // The boxes of the marks on the screen this frame: no label may cover one.
  const markBoxPool = Array.from({ length: GLOBE_MAX_ARCS + 1 }, () => ({
    x: 0,
    y: 0,
    w: 0,
    h: 0,
  }));
  const markBoxes: ScreenBox[] = [];
  const homeSpots: LabelSpot[] = [];
  const stageCamera: StageCamera = {
    distance: 5,
    tanHalf: Math.tan(((CAMERA_FOV / 2) * Math.PI) / 180),
    aspect: 1,
    width: 1,
    height: 1,
    shift: 0,
  };

  function writeHeat(next: ReadonlyMap<string, number>): void {
    if (!owners) return;
    const strength = owners.codes.map((code) => next.get(code) ?? 0);
    for (let i = 0; i < dotCount; i += 1) {
      const owner = owners.index[i] as number;
      heat[i] = owner === 0 ? 0 : (strength[owner - 1] ?? 0);
    }
    heatAttribute.needsUpdate = true;
  }

  function writeArcs(next: GlobeScene): void {
    count = Math.min(GLOBE_MAX_ARCS, next.arcs.length);
    markReach.clear();
    // Marks that share a country stand a few pixels apart, round their point.
    const sharing = new Map<string, number[]>();
    for (let i = 0; i < count; i += 1) {
      const arc = next.arcs[i]!;
      const key = `${arc.from[0]},${arc.from[1]}`;
      const list = sharing.get(key);
      if (list) list.push(i);
      else sharing.set(key, [i]);
    }
    for (let i = 0; i < GLOBE_MAX_ARCS; i += 1) {
      const arc = i < count ? next.arcs[i] : undefined;
      headAlphas[i] = 0;
      markShapes[i] = -1;
      ringState[i * 4] = -1;
      if (!arc) continue;
      const slot = slots[i]!;
      writeArcPoints(
        arc.from,
        options.stockpilot,
        slot.points,
        ARC_SEGMENTS,
        arcBow(arc.from, options.stockpilot),
      );
      writeRibbon(slot.points, ARC_SEGMENTS, ribbon, i * perRibbon);
      for (let v = i * perRibbon; v < (i + 1) * perRibbon; v += 1) {
        arcOrigin[v * 3] = slot.points[0] as number;
        arcOrigin[v * 3 + 1] = slot.points[1] as number;
        arcOrigin[v * 3 + 2] = slot.points[2] as number;
      }
      headOrigins[i * 3] = slot.points[0] as number;
      headOrigins[i * 3 + 1] = slot.points[1] as number;
      headOrigins[i * 3 + 2] = slot.points[2] as number;
      slot.offset = arcOffset(arc.key);
      const coreWidth = 2.5 + (Math.min(4, Math.max(1, arc.width)) - 1) / 6;
      arcA[i * 4 + 2] = arc.flagged ? 1 : 0;
      arcB[i * 4] = arc.rgb[0];
      arcB[i * 4 + 1] = arc.rgb[1];
      arcB[i * 4 + 2] = arc.rgb[2];
      // The ribbon's half width is the core's whole width: the glow is twice as wide as the core.
      arcB[i * 4 + 3] = coreWidth * pixelRatio.value;
      ringState[i * 4 + 1] = arc.flagged ? 1 : 0;
      for (let k = 0; k < 3; k += 1) {
        headColours[i * 3 + k] = arc.rgb[k] as number;
        markColours[i * 3 + k] = arc.rgb[k] as number;
      }
      headHollow[i] = arc.flagged ? 1 : 0;
      lonLatToVector(arc.from[0], arc.from[1], MARK_RADIUS, markPositions, i * 3);
      markShapes[i] = arc.shape;
      markHollow[i] = arc.flagged ? 1 : 0;
      markSizes[i] = sourceMarkSize(arc.width);
      markPhases[i] = slot.offset;
      const group = sharing.get(`${arc.from[0]},${arc.from[1]}`) ?? [i];
      const place = group.indexOf(i);
      const spread = group.length > 1 ? 7 : 0;
      const angle = (place / group.length) * Math.PI * 2 + Math.PI / 4;
      markNudges[i * 2] = Math.cos(angle) * spread;
      markNudges[i * 2 + 1] = Math.sin(angle) * spread;
      const key = `${arc.from[0]},${arc.from[1]}`;
      markReach.set(key, Math.max(markReach.get(key) ?? 0, spread + (markSizes[i] as number) / 2));
    }
    for (const name of ['position', 'previous', 'next', 'side', 'along', 'distance'] as const) {
      arcGeometry.getAttribute(name).needsUpdate = true;
    }
    arcGeometry.setDrawRange(0, count * ARC_SEGMENTS * 6);
    arcOriginAttribute.needsUpdate = true;
    headOriginAttribute.needsUpdate = true;
    headColourAttribute.needsUpdate = true;
    headHollowAttribute.needsUpdate = true;
    for (const [, attribute] of markAttributes) attribute.needsUpdate = true;
  }

  /** Each frame: every head, every track's strength, every ring. */
  function writeFrame(now: number): void {
    const elapsed = now - current.startedAt;
    for (let i = 0; i < count; i += 1) {
      const slot = slots[i]!;
      arcFrameAt(slot.frame, current.timing, elapsed, slot.offset, current.stepMs);
      arcA[i * 4] = slot.frame.head;
      arcA[i * 4 + 1] = slot.frame.track;
      ringState[i * 4] = slot.frame.ring;
      const head = slot.frame.head;
      if (head >= 0 && head <= 1) {
        pointAlong(slot.points, head, headPositions, i * 3);
        headAlphas[i] = Math.min(1, (1 - head) * 14 + 0.25);
      } else {
        headAlphas[i] = 0;
      }
    }
    headPositionAttribute.needsUpdate = true;
    headAlphaAttribute.needsUpdate = true;
  }

  /** The marks on the screen this frame, as boxes (StockPilot's too). */
  function writeMarkBoxes(): void {
    markBoxes.length = 0;
    const limbCos = 1 / stageCamera.distance;
    const seenFade = (8 * Math.PI) / 180;
    for (let i = 0; i < count; i += 1) {
      for (let k = 0; k < 3; k += 1) scratchPoint[k] = markPositions[i * 3 + k] as number;
      projectToStage(scratchPoint, motion.yaw, motion.pitch, stageCamera, projected);
      if (limbFade(projected[2] as number, limbCos, seenFade) <= 0.05) continue;
      const half = (markSizes[i] as number) / 2 + 1;
      const box = markBoxPool[i]!;
      box.x = (projected[0] as number) + (markNudges[i * 2] as number) - half;
      box.y = (projected[1] as number) - (markNudges[i * 2 + 1] as number) - half;
      box.w = half * 2;
      box.h = half * 2;
      markBoxes.push(box);
    }
    projectToStage(at, motion.yaw, motion.pitch, stageCamera, projected);
    if (limbFade(projected[2] as number, limbCos, seenFade) > 0.05) {
      const box = markBoxPool[GLOBE_MAX_ARCS]!;
      box.x = (projected[0] as number) - HOME_MARK_HALF;
      box.y = (projected[1] as number) - HOME_MARK_HALF;
      box.w = HOME_MARK_HALF * 2;
      box.h = HOME_MARK_HALF * 2;
      markBoxes.push(box);
    }
  }

  /**
   * StockPilot's label's spots, best first: away from the last stretch of the
   * arcs coming in (globe-math stockpilotSpots), keeping its side while that
   * stays good enough.
   */
  function writeHomeSpots(held: LabelSpot | null): void {
    projectToStage(at, motion.yaw, motion.pitch, stageCamera, projectedEnd);
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < count; i += 1) {
      // A point an eighth of the way back along the arc from StockPilot.
      const points = slots[i]!.points;
      const back = (ARC_SEGMENTS - 9) * 3;
      for (let k = 0; k < 3; k += 1) scratchPoint[k] = points[back + k] as number;
      projectToStage(scratchPoint, motion.yaw, motion.pitch, stageCamera, projected);
      const ex = (projected[0] as number) - (projectedEnd[0] as number);
      const ey = (projected[1] as number) - (projectedEnd[1] as number);
      const length = Math.hypot(ex, ey);
      if (length < 1e-3) continue;
      dx += ex / length;
      dy += ey / length;
    }
    stockpilotSpots(dx, dy, held, homeSpots);
  }

  /** The labels: each beside its marks, clear of each other, of every mark and of the island's panels. */
  function writeLabels(): void {
    if (labels.length === 0) return;
    writeMarkBoxes();
    for (let i = 0; i < labels.length; i += 1) {
      const entry = labels[i]!;
      projectToStage(entry.point, motion.yaw, motion.pitch, stageCamera, projected);
      const home = entry.label.kind === 'stockpilot';
      entry.fade = limbFade(
        projected[2] as number,
        1 / stageCamera.distance,
        ((home ? 12 : 8) * Math.PI) / 180,
      );
      const anchor = entry.anchor;
      anchor.x = projected[0] as number;
      anchor.y = projected[1] as number;
      anchor.visible = entry.fade > 0.05;
      anchor.reach = (home ? HOME_MARK_HALF : (markReach.get(entry.key) ?? 6)) + LABEL_LEADER + 1;
      if (home) {
        writeHomeSpots(placed[i]?.side ?? null);
        anchor.spots = homeSpots;
      }
    }
    placeLabels(anchors, { w: width, h: height }, reserved, markBoxes, placed);
    for (let i = 0; i < labels.length; i += 1) {
      const entry = labels[i]!;
      const spot = placed[i]!;
      const opacity = spot.shown ? Math.min(1, entry.fade * 1.25) : 0;
      const style = entry.label.el.style;
      const transform = `translate3d(${spot.x.toFixed(1)}px, ${spot.y.toFixed(1)}px, 0)`;
      if (style.transform !== transform) style.transform = transform;
      // The side its leader line comes from (the stage's CSS draws the line).
      const side = spot.side ?? '';
      if (entry.label.el.dataset.side !== side) entry.label.el.dataset.side = side;
      const o = opacity.toFixed(2);
      if (style.opacity !== o) style.opacity = o;
      const visibility = opacity > 0.01 ? 'visible' : 'hidden';
      if (style.visibility !== visibility) style.visibility = visibility;
    }
  }

  function draw(now: number): void {
    const dt = lastTime < 0 ? 16 : now - lastTime;
    lastTime = now;
    // Slow frames for 2 s: the stars and halos go first.
    if (!lowQuality && dt > SLOW_FRAME_MS && dt < 1000) {
      slowFor += dt;
      if (slowFor > SLOW_FOR_MS) {
        lowQuality = true;
        for (const layer of starLayers) layer.points.visible = false;
        halo.visible = false;
        haloOn.value = 0;
      }
    } else if (dt <= SLOW_FRAME_MS) {
      slowFor = 0;
    }
    advanceGlobeMotion(motion, {
      dtMs: dt,
      dragging,
      mayTurn: current.mayTurn,
      still: current.still,
      target: current.target,
    });
    world.rotation.set(motion.pitch, motion.yaw, 0);
    for (const layer of starLayers)
      layer.uniforms.uShift.value = (-motion.yaw / (Math.PI * 2)) * layer.speed * 6;
    const moving = !current.still && current.timing !== 'still';
    motionOn.value = current.still ? 0 : 1;
    if (moving || current.mayTurn) time.value = now;
    dotPulse.value = current.still ? 1 : 0.5 + 0.5 * Math.sin((now / 2600) * Math.PI * 2);
    writeFrame(now);
    renderer.render(scene, camera);
    writeLabels();
  }

  /** Whether anything moves: if not, the loop stops after this frame and waits to be woken. */
  const busy = (): boolean =>
    (!current.still && (current.timing !== 'still' || current.mayTurn)) ||
    dragging ||
    motion.yawSpeed !== 0 ||
    motion.easeMs >= 0 ||
    (motion.away && current.mayTurn && !current.still);

  function loop(now: number): void {
    frame = 0;
    if (!running || lost || disposed) return;
    draw(now);
    if (busy()) frame = requestAnimationFrame(loop);
    else lastTime = -1;
  }

  function wake(): void {
    if (frame !== 0 || !running || lost || disposed) return;
    frame = requestAnimationFrame(loop);
  }

  /* ───────────────────────────── listeners ───────────────────────────── */

  function onLost(event: Event): void {
    event.preventDefault();
    if (lost || disposed) return;
    lost = true;
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    options.onContextLost();
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    dragging = true;
    lastX = event.clientX;
    lastMoveAt = event.timeStamp;
    stopCoasting(motion);
    canvas.setPointerCapture(event.pointerId);
    wake();
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return;
    const dt = event.timeStamp - lastMoveAt;
    dragGlobe(motion, event.clientX - lastX, dt, radiusPx, current.still);
    lastX = event.clientX;
    lastMoveAt = event.timeStamp;
    // Under reduced motion nothing else wakes the loop: draw the turn now.
    if (frame === 0 && running && !lost) draw(performance.now());
  }

  function onPointerUp(event: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    // Held still before letting go: no coasting.
    if (event.timeStamp - lastMoveAt > 90) stopCoasting(motion);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    wake();
  }

  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  function layout(): void {
    const ratio = pixelRatio.value;
    resolution.value = { x: width * ratio, y: height * ratio };
    camera.aspect = width / height;
    const room = Math.max(1, width - insets.right);
    // The globe's radius: GLOBE_HEIGHT_SHARE of the stage's height, or less on a narrow stage.
    radiusPx = Math.max(40, Math.min(height * GLOBE_HEIGHT_SHARE, room * 0.42));
    const half = Math.tan(((CAMERA_FOV / 2) * Math.PI) / 180);
    const tanA = (radiusPx / (height / 2)) * half;
    const distance = 1 / Math.sin(Math.atan(tanA));
    camera.position.set(0, 0, distance);
    camera.lookAt(0, 0, 0);
    stageCamera.distance = distance;
    stageCamera.tanHalf = half;
    stageCamera.aspect = width / height;
    stageCamera.width = width;
    stageCamera.height = height;
    stageCamera.shift = insets.right / 2;
    // In the middle of the room the panel leaves, so a little left of the stage's middle.
    const shift = insets.right / 2;
    if (shift > 0) camera.setViewOffset(width, height, shift, 0, width, height);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    // The halo's plane passes through the globe's centre: the edge it sees is a little wider than 1.
    haloEdge.value = distance / Math.sqrt(distance * distance - 1);
    // The dots' size on screen in device pixels, at the camera's distance.
    dotScale.value = (height * ratio) / (2 * half);
    for (const layer of starLayers) layer.uniforms.uSize.value = layer.size * ratio;
    for (let i = 0; i < count; i += 1) {
      const arc = current.arcs[i];
      if (arc) arcB[i * 4 + 3] = (2.5 + (Math.min(4, Math.max(1, arc.width)) - 1) / 6) * ratio;
    }
    reserved.length = 0;
    if (insets.topLeft.w > 0)
      reserved.push({ x: 0, y: 0, w: insets.topLeft.w, h: insets.topLeft.h });
    if (insets.right > 0)
      reserved.push({ x: width - insets.right, y: 0, w: insets.right, h: height });
    if (insets.bottom > 0)
      reserved.push({ x: 0, y: height - insets.bottom, w: width, h: insets.bottom });
  }

  return {
    show(next) {
      if (disposed) return;
      const arcsChanged = next.arcs !== current.arcs;
      const heatChanged = next.heat !== current.heat;
      current = next;
      if (arcsChanged) writeArcs(next);
      if (heatChanged) writeHeat(next.heat);
      lastTime = -1;
      if (frame === 0 && running && !lost) {
        // Draw this scene at once, even if nothing will move.
        draw(performance.now());
        if (busy()) wake();
      }
    },
    setRunning(next) {
      if (disposed || running === next) return;
      running = next;
      if (!next) {
        if (frame !== 0) cancelAnimationFrame(frame);
        frame = 0;
        lastTime = -1;
        dragging = false;
        return;
      }
      if (!lost) {
        draw(performance.now());
        wake();
      }
    },
    resize(w, h, nextInsets) {
      if (disposed || w <= 0 || h <= 0) return;
      width = w;
      height = h;
      insets = nextInsets;
      const ratio = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
      pixelRatio.value = ratio;
      renderer.setPixelRatio(ratio);
      renderer.setSize(w, h, false);
      layout();
      if (running && !lost) {
        lastTime = -1;
        draw(performance.now());
      }
    },
    setLabels(next) {
      if (disposed) return;
      labels = next.map((label) => {
        const point = new Float32Array(3);
        lonLatToVector(label.lonLat[0], label.lonLat[1], MARK_RADIUS, point);
        const anchor: LabelAnchor = {
          x: 0,
          y: 0,
          w: label.el.offsetWidth,
          h: label.el.offsetHeight,
          reach: LABEL_LEADER,
          visible: false,
          spots: LABEL_SPOTS,
        };
        return { label, point, key: `${label.lonLat[0]},${label.lonLat[1]}`, anchor, fade: 0 };
      });
      anchors = labels.map((entry) => entry.anchor);
      if (running && !lost && frame === 0) draw(performance.now());
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      for (const thing of disposables) thing.dispose();
      disposables.length = 0;
      renderer.dispose();
      // Give the context back at once (browsers allow only a few); a context
      // already lost has nothing to give back.
      if (!lost) renderer.forceContextLoss();
    },
  };
}
