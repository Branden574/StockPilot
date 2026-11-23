import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DynamicDrawUsage,
  Group,
  Mesh,
  PerspectiveCamera,
  Points,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  WebGLRenderer,
  type IUniform,
} from 'three';

import {
  ARC_SEGMENTS,
  TRAIL,
  TUBE_SIDES,
  advanceGlobeMotion,
  arcFrameAt,
  arcOffset,
  createArcFrame,
  createGlobeMotion,
  dotPositions,
  dragGlobe,
  lonLatToVector,
  pointAlong,
  stopCoasting,
  tubeIndexes,
  tubeVertexCount,
  writeArcPoints,
  writeTube,
  type ArcTiming,
  type GlobeFacing,
} from './globe-math';
import type { LonLat } from './world-geometry';

/**
 * THE GLOBE: the one file that touches WebGL (three.js). It cannot run in the
 * test environment, so it holds no rule: what to draw, how arcs move and how
 * the globe turns all come from globe-math.ts and the island (tested). This
 * file only puts them on the screen.
 *
 * Our own look, drawn from our own data and shaders: no texture or image from
 * anywhere (the one texture is the word "StockPilot", drawn here).
 *
 * Well behaved: the pixel ratio is capped at 2; one requestAnimationFrame
 * loop, which stops when the island says the globe is not on screen (a hidden
 * tab or a canvas scrolled away) and when nothing moves; nothing is made per
 * frame (every buffer is made once, at the most arcs there can be, and
 * written into); dispose() frees every geometry, material and texture, the
 * renderer and its context, and every listener. A lost context stops the
 * loop and is reported once, so the island can show the flat map.
 */

export interface GlobeArc {
  key: string;
  from: LonLat;
  /** 0 to 1, as the island's look gives it. */
  rgb: readonly [number, number, number];
  /** Core's width for the count, 1 to 4. */
  width: number;
  flagged: boolean;
  /** The category's mark, as the shader numbers it. */
  shape: number;
}

export interface GlobeScene {
  arcs: readonly GlobeArc[];
  timing: ArcTiming;
  /** The moment (performance.now()) the live play or the replay step began. */
  startedAt: number;
  focus: GlobeFacing | null;
  /** Whether the globe may turn on its own (nothing stops the play). */
  mayTurn: boolean;
}

export interface GlobeHandle {
  show(scene: GlobeScene): void;
  /** Whether the globe is on screen: false stops every frame until it is again. */
  setRunning(running: boolean): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

export interface GlobeOptions {
  /** The land dots, as longitude and latitude pairs. */
  land: Float32Array;
  stockpilot: LonLat;
  stockpilotLabel: string;
  /** Called once, when the browser takes the drawing context away. */
  onContextLost: () => void;
}

/** At most this many arcs are drawn (core's plan never hands over more). */
export const GLOBE_MAX_ARCS = 40;

const DOT_RADIUS = 1.004;
const MARK_RADIUS = 1.006;
const ATMOSPHERE_SCALE = 1.2;
const CAMERA_FOV = 30;
const FIT = 1.32;

/* ─────────────────────────────── the shaders ─────────────────────────────── */

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
uniform vec3 uCore;
uniform vec3 uEdge;
uniform vec3 uRim;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec3 n = normalize(vNormal);
  float facing = clamp(dot(n, normalize(vView)), 0.0, 1.0);
  vec3 colour = mix(uEdge, uCore, pow(facing, 0.75));
  float light = clamp(dot(n, normalize(vec3(-0.45, 0.55, 0.7))), 0.0, 1.0);
  colour += uCore * 0.45 * pow(light, 2.0);
  colour += uRim * 0.6 * pow(1.0 - facing, 3.0);
  gl_FragColor = vec4(colour, 1.0);
}`;

const ATMOSPHERE_VERTEX = /* glsl */ `
varying vec3 vNormal;
void main() {
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const ATMOSPHERE_FRAGMENT = /* glsl */ `
uniform vec3 uRim;
varying vec3 vNormal;
void main() {
  // The inside of the larger sphere, seen past the globe's edge: brightest
  // next to the globe and nothing at its own outline.
  float k = clamp(-dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)) * 1.75, 0.0, 1.0);
  gl_FragColor = vec4(uRim, pow(k, 2.2) * 0.75);
}`;

/** Whether a point (view space) is hidden behind a globe of radius 1 centred at `centre`. */
const HIDDEN_BEHIND_GLOBE = /* glsl */ `
float behindGlobe(vec3 p, vec3 centre) {
  float pp = dot(p, p);
  float ps = dot(p, centre);
  float disc = ps * ps - pp * (dot(centre, centre) - 1.0);
  if (disc < 0.0) return 0.0;
  float t = (ps - sqrt(disc)) / pp;
  return (t > 0.0 && t < 0.996) ? 1.0 : 0.0;
}`;

const DOTS_VERTEX = /* glsl */ `
uniform float uSize;
uniform float uScale;
varying float vFacing;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * position);
  vFacing = dot(n, normalize(-mv.xyz));
  gl_PointSize = uSize * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const DOTS_FRAGMENT = /* glsl */ `
uniform vec3 uColour;
varying float vFacing;
void main() {
  if (vFacing <= 0.0) discard;
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  float core = 1.0 - smoothstep(0.12, 0.5, d);
  float shade = mix(0.2, 0.85, smoothstep(0.0, 0.55, vFacing));
  gl_FragColor = vec4(uColour * (0.75 + 0.5 * core), core * shade);
}`;

const ARC_VERTEX = /* glsl */ `
attribute float aAlong;
varying float vAlong;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vAlong = aAlong;
  vNormal = normalize(normalMatrix * normal);
  vView = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const ARC_FRAGMENT = /* glsl */ `
uniform vec3 uColour;
uniform float uHead;
uniform float uBase;
uniform float uTrail;
uniform float uDashed;
varying float vAlong;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  if (uDashed > 0.5 && fract(vAlong * 26.0) > 0.5) discard;
  float edge = pow(abs(dot(normalize(vNormal), normalize(vView))), 0.7);
  float d = uHead - vAlong;
  float trail = (uHead >= 0.0 && d >= 0.0 && d <= uTrail) ? pow(1.0 - d / uTrail, 1.8) : 0.0;
  float head = (uHead >= 0.0 && uHead <= 1.0 + 0.02 && d >= 0.0) ? exp(-d * 70.0) : 0.0;
  float alpha = max(uBase, trail) * edge + head * 0.7;
  if (alpha <= 0.003) discard;
  gl_FragColor = vec4(mix(uColour, vec3(1.0), head * 0.75), alpha);
}`;

const HEADS_VERTEX = /* glsl */ `
attribute vec3 aColour;
attribute float aAlpha;
attribute float aHollow;
uniform float uPixelRatio;
varying vec3 vColour;
varying float vAlpha;
varying float vHollow;
${HIDDEN_BEHIND_GLOBE}
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 centre = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vColour = aColour;
  vHollow = aHollow;
  vAlpha = aAlpha * (1.0 - behindGlobe(mv.xyz, centre));
  gl_PointSize = 18.0 * uPixelRatio;
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
  float halo = pow(1.0 - r, 2.2) * 0.55;
  float body = vHollow > 0.5
    ? 1.0 - smoothstep(0.06, 0.14, abs(r - 0.34))
    : 1.0 - smoothstep(0.22, 0.36, r);
  vec3 colour = mix(vColour, vec3(1.0), body * 0.6);
  gl_FragColor = vec4(colour, max(halo, body) * vAlpha);
}`;

/*
 * The marks: two per arc. The first at the arc's start: the category's shape
 * (filled for blocked, hollow for flagged) and a pulse when the head leaves.
 * The second at StockPilot: a pulse when the head lands. aShape below 0 means
 * no shape, only the pulse.
 */
const MARKS_VERTEX = /* glsl */ `
attribute vec3 aColour;
attribute float aShape;
attribute float aHollow;
attribute float aPulse;
uniform float uPixelRatio;
varying vec3 vColour;
varying float vShape;
varying float vHollow;
varying float vPulse;
varying float vSeen;
${HIDDEN_BEHIND_GLOBE}
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 centre = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vColour = aColour;
  vShape = aShape;
  vHollow = aHollow;
  vPulse = aPulse;
  vSeen = 1.0 - behindGlobe(mv.xyz, centre);
  gl_PointSize = 44.0 * uPixelRatio;
  gl_Position = projectionMatrix * mv;
}`;

const MARKS_FRAGMENT = /* glsl */ `
varying vec3 vColour;
varying float vShape;
varying float vHollow;
varying float vPulse;
varying float vSeen;
float shapeDistance(vec2 q, float shape) {
  if (shape < 0.5) return length(q);
  if (shape < 1.5) return (abs(q.x) + abs(q.y)) * 0.8;
  if (shape < 2.5) return max(abs(q.x), abs(q.y)) * 1.05;
  if (shape < 3.5) return max(abs(q.x) * 0.866 + q.y * 0.5, -q.y) * 1.6;
  return max(abs(q.x) * 0.866 + abs(q.y) * 0.5, abs(q.y)) * 1.1;
}
void main() {
  if (vSeen <= 0.0) discard;
  vec2 p = (gl_PointCoord - 0.5) * 2.0;
  p.y = -p.y;
  float r = length(p);
  float ring = 0.0;
  if (vPulse >= 0.0) {
    float at = mix(0.16, 1.0, vPulse);
    ring = (1.0 - smoothstep(0.0, 0.07, abs(r - at))) * (1.0 - vPulse);
  }
  float mark = 0.0;
  if (vShape >= 0.0) {
    float d = shapeDistance(p / 0.26, vShape);
    mark = vHollow > 0.5
      ? 1.0 - smoothstep(0.08, 0.2, abs(d - 0.82))
      : 1.0 - smoothstep(0.82, 1.0, d);
  }
  float alpha = max(ring, mark);
  if (alpha <= 0.01) discard;
  gl_FragColor = vec4(vColour, alpha);
}`;

const BEACON_VERTEX = /* glsl */ `
uniform float uPixelRatio;
varying float vSeen;
${HIDDEN_BEHIND_GLOBE}
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 centre = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vSeen = 1.0 - behindGlobe(mv.xyz, centre);
  gl_PointSize = 26.0 * uPixelRatio;
  gl_Position = projectionMatrix * mv;
}`;

const BEACON_FRAGMENT = /* glsl */ `
uniform vec3 uColour;
varying float vSeen;
void main() {
  if (vSeen <= 0.0) discard;
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float core = 1.0 - smoothstep(0.16, 0.26, r);
  float ring = 1.0 - smoothstep(0.05, 0.11, abs(r - 0.62));
  float halo = pow(1.0 - r, 2.0) * 0.35;
  gl_FragColor = vec4(uColour, max(max(core, ring), halo));
}`;

/* ─────────────────────────────── the globe ─────────────────────────────── */

const vec3 = (r: number, g: number, b: number): IUniform<Vector3> => ({
  value: new Vector3(r, g, b),
});

function dynamic(array: Float32Array, itemSize: number): BufferAttribute {
  return new BufferAttribute(array, itemSize).setUsage(DynamicDrawUsage);
}

/** The word "StockPilot", drawn once on a canvas of our own for its label. */
function labelTexture(text: string): { texture: CanvasTexture; aspect: number } | null {
  const canvas = document.createElement('canvas');
  const scale = 4;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const font = `600 ${13 * scale}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  context.font = font;
  const width = Math.ceil(context.measureText(text).width) + 22 * scale;
  const height = 24 * scale;
  canvas.width = width;
  canvas.height = height;
  context.font = font;
  context.fillStyle = 'rgba(5, 9, 18, 0.78)';
  const r = height / 2;
  context.beginPath();
  context.moveTo(r, 0);
  context.arcTo(width, 0, width, height, r);
  context.arcTo(width, height, 0, height, r);
  context.arcTo(0, height, 0, 0, r);
  context.arcTo(0, 0, width, 0, r);
  context.closePath();
  context.fill();
  context.fillStyle = '#ffffff';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, width / 2, height / 2 + scale);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return { texture, aspect: width / height };
}

/**
 * Makes the globe on `canvas`. Throws when the browser cannot give a WebGL 2
 * context (three.js r163 and later need one): the island then shows the flat
 * map.
 */
export function createGlobe(canvas: HTMLCanvasElement, options: GlobeOptions): GlobeHandle {
  const renderer = new WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'default',
  });
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, 50);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);

  const world = new Group();
  scene.add(world);

  const pixelRatio: IUniform<number> = { value: 1 };
  const disposables: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(thing: T): T => {
    disposables.push(thing);
    return thing;
  };

  // The body of the globe.
  const sphere = keep(new SphereGeometry(1, 96, 64));
  const body = new Mesh(
    sphere,
    keep(
      new ShaderMaterial({
        uniforms: {
          uCore: vec3(0.05, 0.09, 0.18),
          uEdge: vec3(0.008, 0.016, 0.04),
          uRim: vec3(0.16, 0.38, 0.85),
        },
        vertexShader: GLOBE_VERTEX,
        fragmentShader: GLOBE_FRAGMENT,
      }),
    ),
  );
  world.add(body);

  // The atmosphere: the inside of a larger sphere, glowing at the rim. It does
  // not turn with the world, so it is in the scene, not the group.
  const atmosphere = new Mesh(
    sphere,
    keep(
      new ShaderMaterial({
        uniforms: { uRim: vec3(0.24, 0.55, 1.0) },
        vertexShader: ATMOSPHERE_VERTEX,
        fragmentShader: ATMOSPHERE_FRAGMENT,
        side: BackSide,
        blending: AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    ),
  );
  atmosphere.scale.set(ATMOSPHERE_SCALE, ATMOSPHERE_SCALE, ATMOSPHERE_SCALE);
  scene.add(atmosphere);

  // The land: one point per dot.
  const dotsGeometry = keep(new BufferGeometry());
  dotsGeometry.setAttribute(
    'position',
    new BufferAttribute(dotPositions(options.land, DOT_RADIUS), 3),
  );
  const dotScale: IUniform<number> = { value: 1 };
  const dots = new Points(
    dotsGeometry,
    keep(
      new ShaderMaterial({
        uniforms: {
          uColour: vec3(0.44, 0.72, 1.0),
          // A dot's width on the globe, in globe radii (the dots are about 0.017 apart).
          uSize: { value: 0.0115 },
          uScale: dotScale,
        },
        vertexShader: DOTS_VERTEX,
        fragmentShader: DOTS_FRAGMENT,
        blending: AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    ),
  );
  world.add(dots);

  // The arcs: a tube each, made once at the most there can be.
  const indexes = tubeIndexes(ARC_SEGMENTS, TUBE_SIDES);
  const vertexCount = tubeVertexCount(ARC_SEGMENTS, TUBE_SIDES);
  const arcPoints = new Float32Array((ARC_SEGMENTS + 1) * 3 * GLOBE_MAX_ARCS);
  const slots = Array.from({ length: GLOBE_MAX_ARCS }, (_, i) => {
    const geometry = keep(new BufferGeometry());
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const along = new Float32Array(vertexCount);
    geometry.setAttribute('position', dynamic(positions, 3));
    geometry.setAttribute('normal', dynamic(normals, 3));
    geometry.setAttribute('aAlong', dynamic(along, 1));
    geometry.setIndex(new BufferAttribute(indexes.slice(), 1));
    const uniforms = {
      uColour: vec3(1, 1, 1),
      uHead: { value: -1 },
      uBase: { value: 0 },
      uTrail: { value: TRAIL },
      uDashed: { value: 0 },
    };
    const mesh = new Mesh(
      geometry,
      keep(
        new ShaderMaterial({
          uniforms,
          vertexShader: ARC_VERTEX,
          fragmentShader: ARC_FRAGMENT,
          blending: AdditiveBlending,
          transparent: true,
          depthWrite: false,
        }),
      ),
    );
    mesh.visible = false;
    mesh.frustumCulled = false;
    world.add(mesh);
    return {
      mesh,
      geometry,
      positions,
      normals,
      along,
      uniforms,
      points: arcPoints.subarray(i * (ARC_SEGMENTS + 1) * 3, (i + 1) * (ARC_SEGMENTS + 1) * 3),
      frame: createArcFrame(),
      offset: 0,
    };
  });

  // The heads: one point per arc.
  const headPositions = new Float32Array(GLOBE_MAX_ARCS * 3);
  const headColours = new Float32Array(GLOBE_MAX_ARCS * 3);
  const headAlphas = new Float32Array(GLOBE_MAX_ARCS);
  const headHollow = new Float32Array(GLOBE_MAX_ARCS);
  const headsGeometry = keep(new BufferGeometry());
  const headPositionAttribute = dynamic(headPositions, 3);
  const headColourAttribute = dynamic(headColours, 3);
  const headAlphaAttribute = dynamic(headAlphas, 1);
  const headHollowAttribute = dynamic(headHollow, 1);
  headsGeometry.setAttribute('position', headPositionAttribute);
  headsGeometry.setAttribute('aColour', headColourAttribute);
  headsGeometry.setAttribute('aAlpha', headAlphaAttribute);
  headsGeometry.setAttribute('aHollow', headHollowAttribute);
  const heads = new Points(
    headsGeometry,
    keep(
      new ShaderMaterial({
        uniforms: { uPixelRatio: pixelRatio },
        vertexShader: HEADS_VERTEX,
        fragmentShader: HEADS_FRAGMENT,
        blending: AdditiveBlending,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      }),
    ),
  );
  heads.frustumCulled = false;
  world.add(heads);

  // The marks and pulses: two points per arc.
  const markPositions = new Float32Array(GLOBE_MAX_ARCS * 2 * 3);
  const markColours = new Float32Array(GLOBE_MAX_ARCS * 2 * 3);
  const markShapes = new Float32Array(GLOBE_MAX_ARCS * 2);
  const markHollow = new Float32Array(GLOBE_MAX_ARCS * 2);
  const markPulses = new Float32Array(GLOBE_MAX_ARCS * 2);
  const marksGeometry = keep(new BufferGeometry());
  const markPositionAttribute = dynamic(markPositions, 3);
  const markColourAttribute = dynamic(markColours, 3);
  const markShapeAttribute = dynamic(markShapes, 1);
  const markHollowAttribute = dynamic(markHollow, 1);
  const markPulseAttribute = dynamic(markPulses, 1);
  marksGeometry.setAttribute('position', markPositionAttribute);
  marksGeometry.setAttribute('aColour', markColourAttribute);
  marksGeometry.setAttribute('aShape', markShapeAttribute);
  marksGeometry.setAttribute('aHollow', markHollowAttribute);
  marksGeometry.setAttribute('aPulse', markPulseAttribute);
  const marks = new Points(
    marksGeometry,
    keep(
      new ShaderMaterial({
        uniforms: { uPixelRatio: pixelRatio },
        vertexShader: MARKS_VERTEX,
        fragmentShader: MARKS_FRAGMENT,
        blending: AdditiveBlending,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      }),
    ),
  );
  marks.frustumCulled = false;
  world.add(marks);

  // StockPilot: a steady white beacon and its label.
  const beaconPosition = new Float32Array(3);
  lonLatToVector(options.stockpilot[0], options.stockpilot[1], MARK_RADIUS, beaconPosition);
  const beaconGeometry = keep(new BufferGeometry());
  beaconGeometry.setAttribute('position', new BufferAttribute(beaconPosition, 3));
  const beacon = new Points(
    beaconGeometry,
    keep(
      new ShaderMaterial({
        uniforms: { uPixelRatio: pixelRatio, uColour: vec3(1, 1, 1) },
        vertexShader: BEACON_VERTEX,
        fragmentShader: BEACON_FRAGMENT,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      }),
    ),
  );
  beacon.frustumCulled = false;
  world.add(beacon);

  const label = labelTexture(options.stockpilotLabel);
  if (label) {
    keep(label.texture);
    const sprite = new Sprite(
      keep(new SpriteMaterial({ map: label.texture, transparent: true, depthWrite: false })),
    );
    const at = new Float32Array(3);
    lonLatToVector(options.stockpilot[0], options.stockpilot[1] + 4.5, 1.05, at);
    sprite.position.set(at[0] as number, at[1] as number, at[2] as number);
    sprite.scale.set(0.085 * label.aspect, 0.085, 1);
    world.add(sprite);
  }

  /* ─────────────────────────────── state ─────────────────────────────── */

  const motion = createGlobeMotion(-options.stockpilot[0] * (Math.PI / 180), 0.32);
  let current: GlobeScene = {
    arcs: [],
    timing: 'still',
    startedAt: 0,
    focus: null,
    mayTurn: false,
  };
  let count = 0;
  let running = false;
  let lost = false;
  let disposed = false;
  let frame = 0;
  let lastTime = -1;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let lastMoveAt = 0;
  let width = 1;
  let height = 1;

  function writeArcs(scene: GlobeScene): void {
    count = Math.min(GLOBE_MAX_ARCS, scene.arcs.length);
    for (let i = 0; i < GLOBE_MAX_ARCS; i += 1) {
      const slot = slots[i]!;
      const arc = i < count ? scene.arcs[i] : undefined;
      slot.mesh.visible = arc !== undefined;
      headAlphas[i] = 0;
      markShapes[i * 2] = -1;
      markShapes[i * 2 + 1] = -1;
      markPulses[i * 2] = -1;
      markPulses[i * 2 + 1] = -1;
      if (!arc) continue;
      writeArcPoints(arc.from, options.stockpilot, slot.points);
      const thickness = (arc.flagged ? 0.0016 : 0.0026) * arc.width;
      writeTube(
        slot.points,
        ARC_SEGMENTS,
        TUBE_SIDES,
        thickness,
        slot.positions,
        slot.along,
        slot.normals,
      );
      slot.geometry.getAttribute('position').needsUpdate = true;
      slot.geometry.getAttribute('normal').needsUpdate = true;
      slot.geometry.getAttribute('aAlong').needsUpdate = true;
      (slot.uniforms.uColour.value as Vector3).set(arc.rgb[0], arc.rgb[1], arc.rgb[2]);
      slot.uniforms.uDashed.value = arc.flagged ? 1 : 0;
      slot.offset = arcOffset(arc.key);
      for (let k = 0; k < 3; k += 1) {
        headColours[i * 3 + k] = arc.rgb[k] as number;
        markColours[i * 6 + k] = arc.rgb[k] as number;
        markColours[i * 6 + 3 + k] = arc.rgb[k] as number;
      }
      headHollow[i] = arc.flagged ? 1 : 0;
      lonLatToVector(arc.from[0], arc.from[1], MARK_RADIUS, markPositions, i * 6);
      markPositions[i * 6 + 3] = beaconPosition[0] as number;
      markPositions[i * 6 + 4] = beaconPosition[1] as number;
      markPositions[i * 6 + 5] = beaconPosition[2] as number;
      markShapes[i * 2] = arc.shape;
      markHollow[i * 2] = arc.flagged ? 1 : 0;
    }
    headColourAttribute.needsUpdate = true;
    headHollowAttribute.needsUpdate = true;
    markPositionAttribute.needsUpdate = true;
    markColourAttribute.needsUpdate = true;
    markShapeAttribute.needsUpdate = true;
    markHollowAttribute.needsUpdate = true;
  }

  /** Each frame: where every head is, how bright every path is, every pulse. */
  function writeFrame(now: number): void {
    const elapsed = now - current.startedAt;
    for (let i = 0; i < count; i += 1) {
      const slot = slots[i]!;
      arcFrameAt(slot.frame, current.timing, elapsed, slot.offset);
      slot.uniforms.uHead.value = slot.frame.head;
      slot.uniforms.uBase.value = slot.frame.base;
      const head = slot.frame.head;
      if (head >= 0 && head <= 1) {
        pointAlong(slot.points, head, headPositions, i * 3);
        headAlphas[i] = 1;
      } else {
        headAlphas[i] = 0;
      }
      markPulses[i * 2] = slot.frame.startPulse;
      markPulses[i * 2 + 1] = slot.frame.landPulse;
    }
    headPositionAttribute.needsUpdate = true;
    headAlphaAttribute.needsUpdate = true;
    markPulseAttribute.needsUpdate = true;
  }

  function draw(now: number): void {
    const dt = lastTime < 0 ? 16 : now - lastTime;
    lastTime = now;
    advanceGlobeMotion(motion, {
      dtMs: dt,
      dragging,
      mayTurn: current.mayTurn,
      focus: current.focus,
    });
    world.rotation.set(motion.pitch, motion.yaw, 0);
    writeFrame(now);
    renderer.render(scene, camera);
  }

  /** Whether anything moves: if not, the loop stops after this frame and waits to be woken. */
  const busy = (): boolean =>
    current.timing !== 'still' ||
    current.mayTurn ||
    dragging ||
    motion.yawSpeed !== 0 ||
    motion.pitchSpeed !== 0;

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
    lastY = event.clientY;
    lastMoveAt = event.timeStamp;
    stopCoasting(motion);
    canvas.setPointerCapture(event.pointerId);
    wake();
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return;
    const dt = event.timeStamp - lastMoveAt;
    dragGlobe(
      motion,
      event.clientX - lastX,
      event.clientY - lastY,
      dt,
      Math.min(width, height) / 2,
    );
    lastX = event.clientX;
    lastY = event.clientY;
    lastMoveAt = event.timeStamp;
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

  return {
    show(next) {
      if (disposed) return;
      const arcsChanged = next.arcs !== current.arcs;
      current = next;
      if (arcsChanged) writeArcs(next);
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
    resize(w, h) {
      if (disposed || w <= 0 || h <= 0) return;
      width = w;
      height = h;
      const ratio = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
      pixelRatio.value = ratio;
      renderer.setPixelRatio(ratio);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      // Far enough that the globe and its glow fit the shorter side.
      const half = Math.tan(((CAMERA_FOV / 2) * Math.PI) / 180);
      camera.position.set(0, 0, FIT / (half * Math.min(1, camera.aspect)));
      camera.updateProjectionMatrix();
      // The dots' size on screen in device pixels, at the camera's distance.
      dotScale.value = (h * ratio) / (2 * half);
      if (running && !lost) {
        lastTime = -1;
        draw(performance.now());
      }
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
