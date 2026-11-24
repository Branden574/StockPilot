// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  ARC_BOW,
  ARC_MAX_HEIGHT,
  ARC_MIN_HEIGHT,
  ARC_SEGMENTS,
  DRIFT_TURN_MS,
  EASE_MS,
  FLIGHT_MAX_MS,
  FLIGHT_MIN_MS,
  GLOBE_HEIGHT_SHARE,
  GLOBE_TILT,
  LIVE_PERIOD_MS,
  REPLAY_FLIGHT_MS,
  REPLAY_SPREAD_MS,
  RETURN_AFTER_MS,
  RING_MS,
  SOURCE_SEEN,
  STAGE_HEADROOM,
  STILL_TRACK,
  STOCKPILOT_GONE,
  STOCKPILOT_SEEN,
  SWAY,
  SWAY_PERIOD_MS,
  TARGET_MOVE,
  TRACK_HOLD_MS,
  TRACK_IN_MS,
  TRACK_OUT_MS,
  TRAIL,
  advanceGlobeMotion,
  angleFromView,
  arcBow,
  arcBowAt,
  arcFrameAt,
  arcHeight,
  arcOffset,
  centralAngle,
  createArcFrame,
  createGlobeMotion,
  dotPositions,
  dragGlobe,
  easeInOut,
  facingYaw,
  flightMs,
  heatOf,
  limbFade,
  lonLatToVector,
  placeLabels,
  pointAlong,
  projectToStage,
  ribbonIndexes,
  ribbonVertexCount,
  sourceMarkSize,
  stopCoasting,
  swayAt,
  turnPoint,
  wrapAngle,
  writeArcPoints,
  writeRibbon,
  writeStars,
  type LabelAnchor,
  type PlacedLabel,
  type RibbonArrays,
  type StageCamera,
} from './globe-math';
import {
  FLAT_HEIGHT,
  FLAT_WIDTH,
  STOCKPILOT_LON_LAT,
  countryPoint,
  flatArcPath,
  projectFlat,
  worldDotsPath,
} from './world-geometry';

/** The globe's arithmetic, and the flat map's. */

const near = (a: number, b: number, digits = 6) => expect(a).toBeCloseTo(b, digits);
const vec = (lon: number, lat: number, r = 1) => {
  const v = [0, 0, 0];
  lonLatToVector(lon, lat, r, v);
  return v;
};
const DEG = Math.PI / 180;

describe('places on the sphere', () => {
  it('longitude 0 faces the viewer (+z), 90 east is +x, the north pole is +y', () => {
    const cases: Array<[number, number, number[]]> = [
      [0, 0, [0, 0, 1]],
      [90, 0, [1, 0, 0]],
      [-90, 0, [-1, 0, 0]],
      [180, 0, [0, 0, -1]],
      [0, 90, [0, 1, 0]],
      [0, -90, [0, -1, 0]],
    ];
    for (const [lon, lat, want] of cases) {
      const v = vec(lon, lat);
      for (let k = 0; k < 3; k += 1) near(v[k]!, want[k]!);
    }
    const out = new Float32Array(6);
    lonLatToVector(0, 0, 2, out, 3);
    expect([...out]).toEqual([0, 0, 0, 0, 0, 2]);
  });

  it('the dots become points on the sphere, three numbers each', () => {
    const p = dotPositions(new Float32Array([0, 0, 90, 0]), 1.5);
    expect(p).toHaveLength(6);
    near(p[2]!, 1.5);
    near(p[3]!, 1.5);
  });

  it('the angle between two places', () => {
    near(centralAngle([0, 0], [90, 0]), Math.PI / 2);
    near(centralAngle([0, 0], [180, 0]), Math.PI);
    near(centralAngle([10, 20], [10, 20]), 0);
    near(centralAngle([0, 90], [123, -90]), Math.PI);
  });
});

describe('turning the globe to face a place', () => {
  it('turnPoint is the same turn as three.js applies for rotation (pitch, yaw, 0) in the order XYZ', () => {
    // three.js Matrix4.makeRotationFromEuler, order XYZ, z = 0: the rows below
    // are its elements, read from the installed package's source.
    const yaw = 0.7;
    const pitch = -0.4;
    const a = Math.cos(pitch);
    const b = Math.sin(pitch);
    const c = Math.cos(yaw);
    const d = Math.sin(yaw);
    const m = [
      [c, 0, d],
      [b * d, a, -b * c],
      [-a * d, b, a * c],
    ];
    const v = [0.3, -0.5, 0.81];
    const want = m.map((row) => row[0]! * v[0]! + row[1]! * v[1]! + row[2]! * v[2]!);
    turnPoint(v, yaw, pitch);
    for (let k = 0; k < 3; k += 1) near(v[k]!, want[k]!);
  });

  it("the angle from the middle of the view: the yaw faces longitude -yaw at the tilt's latitude", () => {
    near(angleFromView(-40 * DEG, [40, GLOBE_TILT / DEG]), 0);
    near(angleFromView(0, [0, GLOBE_TILT / DEG + 30]), 30 * DEG);
    near(GLOBE_TILT, 18 * DEG);
  });

  it('nothing to play: the globe faces StockPilot', () => {
    near(facingYaw([], STOCKPILOT_LON_LAT), wrapAngle(-STOCKPILOT_LON_LAT[0] * DEG));
    // A weight of nothing (or not a number) is no place at all.
    near(
      facingYaw(
        [
          { lonLat: [100, 30], weight: 0 },
          { lonLat: [120, 30], weight: Number.NaN },
        ],
        STOCKPILOT_LON_LAT,
      ),
      wrapAngle(-STOCKPILOT_LON_LAT[0] * DEG),
    );
  });

  it("sources on StockPilot's side: StockPilot and every source are in view", () => {
    const places = [
      { lonLat: [-100, 40] as const, weight: 3 },
      { lonLat: [10, 50] as const, weight: 4 },
      { lonLat: [-50, -15] as const, weight: 2 },
    ];
    const yaw = facingYaw(places, STOCKPILOT_LON_LAT);
    expect(angleFromView(yaw, STOCKPILOT_LON_LAT)).toBeLessThanOrEqual(STOCKPILOT_SEEN);
    for (const p of places) expect(angleFromView(yaw, p.lonLat)).toBeLessThan(76 * DEG);
  });

  it('sources east of StockPilot: the globe turns from their middle toward StockPilot, keeping it in view', () => {
    // Facing these three alone puts the middle of the view near 6 E and StockPilot
    // past the limb (74 degrees out); what StockPilot is worth turns the globe
    // west until it is just inside, the sources still well in view.
    const places = [
      { lonLat: [10, 50] as const, weight: 3 },
      { lonLat: [8, 9] as const, weight: 3 },
      { lonLat: [-4, 40] as const, weight: 2 },
    ];
    const yaw = facingYaw(places, STOCKPILOT_LON_LAT);
    expect(-yaw / DEG).toBeLessThan(-15);
    expect(angleFromView(yaw, STOCKPILOT_LON_LAT)).toBeLessThan(50 * DEG);
    for (const p of places) expect(angleFromView(yaw, p.lonLat)).toBeLessThan(46 * DEG);
  });

  it('a play from the far side of the world faces its sources, not StockPilot', () => {
    const places = [
      { lonLat: [105, 35] as const, weight: 5 },
      { lonLat: [78, 21] as const, weight: 4 },
      { lonLat: [135, 36] as const, weight: 3 },
      { lonLat: [120, 15] as const, weight: 2 },
    ];
    const yaw = facingYaw(places, STOCKPILOT_LON_LAT);
    for (const p of places) expect(angleFromView(yaw, p.lonLat)).toBeLessThanOrEqual(SOURCE_SEEN);
    expect(angleFromView(yaw, STOCKPILOT_LON_LAT)).toBeGreaterThan(STOCKPILOT_GONE);
  });

  it('a heavier source pulls the facing toward itself', () => {
    const light = facingYaw(
      [
        { lonLat: [10, 50], weight: 1 },
        { lonLat: [30, 50], weight: 1 },
      ],
      [20, 50],
    );
    const heavy = facingYaw(
      [
        { lonLat: [10, 50], weight: 1 },
        { lonLat: [30, 50], weight: 9 },
      ],
      [20, 50],
    );
    // A yaw of -longitude faces that longitude: heavier on the east, a smaller yaw.
    expect(heavy).toBeLessThan(light);
  });

  it('angles wrap into (-pi, pi]', () => {
    near(wrapAngle(3 * Math.PI), Math.PI);
    near(wrapAngle(-Math.PI), Math.PI);
    near(wrapAngle(Math.PI / 2 + 4 * Math.PI), Math.PI / 2);
    near(wrapAngle(-0.25), -0.25);
  });
});

describe('arcs', () => {
  it('rise higher the farther they go, within their bounds', () => {
    near(arcHeight(0), ARC_MIN_HEIGHT);
    near(arcHeight(Math.PI), ARC_MAX_HEIGHT);
    expect(arcHeight(1)).toBeGreaterThan(arcHeight(0.5));
    near(arcHeight(10), ARC_MAX_HEIGHT);
  });

  it('start and end on the surface, rise to their height in the middle, along the great circle', () => {
    const out = new Float32Array((ARC_SEGMENTS + 1) * 3);
    const from = [10, 50] as const;
    const to = STOCKPILOT_LON_LAT;
    writeArcPoints(from, to, out);
    const at = (i: number) => [out[i * 3]!, out[i * 3 + 1]!, out[i * 3 + 2]!];
    const length = (v: number[]) => Math.hypot(v[0]!, v[1]!, v[2]!);
    const start = vec(from[0], from[1]);
    const end = vec(to[0], to[1]);
    for (let k = 0; k < 3; k += 1) {
      near(at(0)[k]!, start[k]!, 5);
      near(at(ARC_SEGMENTS)[k]!, end[k]!, 5);
    }
    near(length(at(ARC_SEGMENTS / 2)), 1 + arcHeight(centralAngle(from, to)), 5);
    // Every point lies in the plane of the two ends and the centre.
    const normal = [
      start[1]! * end[2]! - start[2]! * end[1]!,
      start[2]! * end[0]! - start[0]! * end[2]!,
      start[0]! * end[1]! - start[1]! * end[0]!,
    ];
    for (let i = 0; i <= ARC_SEGMENTS; i += 1) {
      const p = at(i);
      near(p[0]! * normal[0]! + p[1]! * normal[1]! + p[2]! * normal[2]!, 0, 5);
      expect(length(p)).toBeGreaterThanOrEqual(1 - 1e-6);
    }
  });

  it('the same place twice is a small loop straight up; opposite places go over the north side', () => {
    const out = new Float32Array((ARC_SEGMENTS + 1) * 3);
    writeArcPoints([20, 10], [20, 10], out);
    const top = [
      out[(ARC_SEGMENTS / 2) * 3]!,
      out[(ARC_SEGMENTS / 2) * 3 + 1]!,
      out[(ARC_SEGMENTS / 2) * 3 + 2]!,
    ];
    near(Math.hypot(top[0]!, top[1]!, top[2]!), 1 + ARC_MIN_HEIGHT, 5);
    expect(out.every(Number.isFinite)).toBe(true);
    writeArcPoints([0, 0], [180, 0], out);
    expect(out.every(Number.isFinite)).toBe(true);
    // The middle is over the north pole.
    near(out[(ARC_SEGMENTS / 2) * 3 + 1]!, 1 + ARC_MAX_HEIGHT, 4);
  });

  it('bow to one side: always the same side for the same pair, at most ARC_BOW, less for a short arc', () => {
    const far = [28, -26] as const;
    const bow = arcBow(far, STOCKPILOT_LON_LAT);
    expect(Math.abs(bow)).toBeCloseTo(ARC_BOW, 9);
    expect(arcBow(far, STOCKPILOT_LON_LAT)).toBe(bow);
    // A short arc (30 degrees) bows half as much.
    const short = arcBow([0, 0], [30, 0]);
    near(Math.abs(short), ARC_BOW / 2, 9);
    near(arcBow([20, 10], [20, 10]), 0, 9);
    // Both sides happen.
    const sides = new Set<number>();
    for (let lon = -170; lon <= 170; lon += 10)
      sides.add(Math.sign(arcBow([lon, 5], STOCKPILOT_LON_LAT)));
    expect([...sides].sort()).toEqual([-1, 1]);
    // Lopsided: none at the ends, widest a third of the way from the source.
    near(arcBowAt(0), 0, 9);
    near(arcBowAt(1), 0, 9);
    near(arcBowAt(1 / 3), 1, 9);
    expect(arcBowAt(0.25)).toBeLessThan(1);
    expect(arcBowAt(0.5)).toBeLessThan(1);
    expect(arcBowAt(0.5)).toBeGreaterThan(arcBowAt(2 / 3));
  });

  it('a bowed arc keeps its ends and its rise, and leaves its plane by the bow', () => {
    const from = [28, -26] as const;
    const to = STOCKPILOT_LON_LAT;
    const flat = new Float32Array((ARC_SEGMENTS + 1) * 3);
    const bowed = new Float32Array((ARC_SEGMENTS + 1) * 3);
    const bow = arcBow(from, to);
    writeArcPoints(from, to, flat);
    writeArcPoints(from, to, bowed, ARC_SEGMENTS, bow);
    const at = (out: Float32Array, i: number) => [out[i * 3]!, out[i * 3 + 1]!, out[i * 3 + 2]!];
    for (const i of [0, ARC_SEGMENTS]) {
      for (let k = 0; k < 3; k += 1) near(at(bowed, i)[k]!, at(flat, i)[k]!, 5);
    }
    const start = vec(from[0], from[1]);
    const end = vec(to[0], to[1]);
    const normal = [
      start[1]! * end[2]! - start[2]! * end[1]!,
      start[2]! * end[0]! - start[0]! * end[2]!,
      start[0]! * end[1]! - start[1]! * end[0]!,
    ];
    const nLength = Math.hypot(normal[0]!, normal[1]!, normal[2]!);
    for (let i = 0; i <= ARC_SEGMENTS; i += 1) {
      const p = at(bowed, i);
      const q = at(flat, i);
      const length = Math.hypot(p[0]!, p[1]!, p[2]!);
      // The same height off the surface as the arc without a bow.
      near(length, Math.hypot(q[0]!, q[1]!, q[2]!), 5);
      // Off the plane by bow * arcBowAt(t), on the bow's side.
      const off = Math.asin(
        (p[0]! * normal[0]! + p[1]! * normal[1]! + p[2]! * normal[2]!) / nLength / length,
      );
      near(off, bow * arcBowAt(i / ARC_SEGMENTS), 4);
    }
  });

  it('seen from any direction, a long bowed arc is never a straight line', () => {
    // Without the bow every arc is flat, and from some direction it is a
    // straight line across the globe's face. The bow must leave a curve of at
    // least 2.5% of the globe's radius (about 5 px on a 1440 x 900 page) from
    // every direction that shows the arc at least 0.8 radii long.
    const straightest = (from: readonly [number, number], bow: number) => {
      const points = new Float32Array((ARC_SEGMENTS + 1) * 3);
      writeArcPoints(from, STOCKPILOT_LON_LAT, points, ARC_SEGMENTS, bow);
      let least = Infinity;
      for (let lat = -60; lat <= 60; lat += 3) {
        for (let lon = -180; lon < 180; lon += 3) {
          const eye = vec(lon, lat);
          // Two screen directions at right angles to the eye.
          const right = [eye[2]!, 0, -eye[0]!];
          const r = Math.hypot(right[0]!, right[2]!);
          right[0]! /= r;
          right[2]! /= r;
          const up = [
            eye[1]! * right[2]! - eye[2]! * right[1]!,
            eye[2]! * right[0]! - eye[0]! * right[2]!,
            eye[0]! * right[1]! - eye[1]! * right[0]!,
          ];
          const screen = (i: number) => {
            const p = [points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!];
            return [
              p[0]! * right[0]! + p[1]! * right[1]! + p[2]! * right[2]!,
              p[0]! * up[0]! + p[1]! * up[1]! + p[2]! * up[2]!,
            ];
          };
          const a = screen(0);
          const b = screen(ARC_SEGMENTS);
          const chord = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!);
          if (chord < 0.8) continue;
          let widest = 0;
          for (let i = 1; i < ARC_SEGMENTS; i += 1) {
            const p = screen(i);
            const away =
              Math.abs((b[0]! - a[0]!) * (a[1]! - p[1]!) - (a[0]! - p[0]!) * (b[1]! - a[1]!)) /
              chord;
            widest = Math.max(widest, away);
          }
          least = Math.min(least, widest);
        }
      }
      return least;
    };
    for (const from of [
      [28, -26],
      [-50, -12],
      [100, 35],
      [10, 50],
    ] as const) {
      expect(straightest(from, 0)).toBeLessThan(0.005);
      expect(straightest(from, arcBow(from, STOCKPILOT_LON_LAT))).toBeGreaterThan(0.025);
    }
  });

  it('a point along the line, straight between its two nearest points', () => {
    const line = new Float32Array([0, 0, 0, 1, 0, 0, 1, 2, 0]);
    const out = new Float32Array(6);
    pointAlong(line, 0.25, out, 3);
    expect([...out.slice(3)]).toEqual([0.5, 0, 0]);
    pointAlong(line, 1, out);
    expect([...out.slice(0, 3)]).toEqual([1, 2, 0]);
    pointAlong(line, -1, out);
    expect([...out.slice(0, 3)]).toEqual([0, 0, 0]);
  });

  it('the highest arc stays inside the stage above and below the globe', () => {
    // The globe's radius is GLOBE_HEIGHT_SHARE of the stage's height: an arc's
    // top, (1 + its height) radii from the centre, is inside half the stage.
    expect((1 + ARC_MAX_HEIGHT) * GLOBE_HEIGHT_SHARE).toBeLessThanOrEqual(0.5);
    expect(ARC_MAX_HEIGHT).toBeLessThanOrEqual(STAGE_HEADROOM);
    expect(ARC_MIN_HEIGHT).toBeGreaterThan(0);
  });

  it('a ribbon: two vertices for each point, one either side, with the points before and after it', () => {
    const segments = 6;
    const points = new Float32Array((segments + 1) * 3);
    writeArcPoints([0, 0], [60, 0], points, segments);
    const n = ribbonVertexCount(segments) * 2;
    const out: RibbonArrays = {
      position: new Float32Array(n * 3),
      previous: new Float32Array(n * 3),
      next: new Float32Array(n * 3),
      side: new Float32Array(n),
      along: new Float32Array(n),
      distance: new Float32Array(n),
    };
    const first = ribbonVertexCount(segments);
    const length = writeRibbon(points, segments, out, first);
    // Nothing before `first` is written.
    expect(out.side.slice(0, first).every((v) => v === 0)).toBe(true);
    let sum = 0;
    for (let i = 0; i <= segments; i += 1) {
      if (i > 0) {
        sum += Math.hypot(
          points[i * 3]! - points[(i - 1) * 3]!,
          points[i * 3 + 1]! - points[(i - 1) * 3 + 1]!,
          points[i * 3 + 2]! - points[(i - 1) * 3 + 2]!,
        );
      }
      for (let s = 0; s < 2; s += 1) {
        const v = first + i * 2 + s;
        expect(out.side[v]).toBe(s === 0 ? -1 : 1);
        near(out.along[v]!, i / segments);
        near(out.distance[v]!, sum, 5);
        const before = Math.max(0, i - 1);
        const after = Math.min(segments, i + 1);
        for (let k = 0; k < 3; k += 1) {
          expect(out.position[v * 3 + k]).toBe(points[i * 3 + k]);
          expect(out.previous[v * 3 + k]).toBe(points[before * 3 + k]);
          expect(out.next[v * 3 + k]).toBe(points[after * 3 + k]);
        }
      }
    }
    near(length, sum, 5);
    // A line of 60 degrees that rises: longer than the ground under it.
    expect(length).toBeGreaterThan(60 * DEG);
  });

  it("the ribbons' triangles: two for each segment, each ribbon's within its own vertices", () => {
    const segments = 4;
    const count = 3;
    const per = ribbonVertexCount(segments);
    const indexes = ribbonIndexes(segments, count);
    expect(indexes).toHaveLength(segments * 6 * count);
    for (let r = 0; r < count; r += 1) {
      const own = indexes.slice(r * segments * 6, (r + 1) * segments * 6);
      expect(Math.min(...own)).toBe(r * per);
      expect(Math.max(...own)).toBe((r + 1) * per - 1);
    }
    // One segment: the quad of points i and i + 1, both sides, cut along one diagonal.
    expect([...indexes.slice(0, 6)]).toEqual([0, 2, 1, 1, 2, 3]);
  });
});

describe('the stage', () => {
  const camera = (width: number, height: number, radiusPx: number, shift = 0): StageCamera => {
    // As the renderer lays it out: the distance that makes the globe radiusPx across its half.
    const tanHalf = Math.tan(15 * DEG);
    const tanA = (radiusPx / (height / 2)) * tanHalf;
    return {
      distance: 1 / Math.sin(Math.atan(tanA)),
      tanHalf,
      aspect: width / height,
      width,
      height,
      shift,
    };
  };

  it('the point facing the viewer is in the middle of the stage, less the shift', () => {
    const out = [0, 0, 0];
    projectToStage([0, 0, 1], 0, 0, camera(1200, 600, 216), out);
    near(out[0]!, 600);
    near(out[1]!, 300);
    near(out[2]!, 1);
    projectToStage([0, 0, 1], 0, 0, camera(1200, 600, 216, 160), out);
    near(out[0]!, 440);
  });

  it('the limb is drawn radiusPx from the middle', () => {
    const cam = camera(1200, 600, 216);
    const limbCos = 1 / cam.distance;
    const out = [0, 0, 0];
    projectToStage([Math.sqrt(1 - limbCos * limbCos), 0, limbCos], 0, 0, cam, out);
    near(out[0]! - 600, 216, 4);
    near(out[2]!, limbCos);
  });

  it('a place turned by its yaw and the tilt comes to the middle; north is up', () => {
    const cam = camera(800, 600, 200);
    const out = [0, 0, 0];
    projectToStage(vec(40, GLOBE_TILT / DEG), -40 * DEG, GLOBE_TILT, cam, out);
    near(out[0]!, 400, 4);
    near(out[1]!, 300, 4);
    projectToStage(vec(40, GLOBE_TILT / DEG + 10), -40 * DEG, GLOBE_TILT, cam, out);
    expect(out[1]!).toBeLessThan(300);
  });

  it('a place fades over the last degrees before the limb and is gone past it', () => {
    const limbCos = Math.cos(70 * DEG);
    near(limbFade(Math.cos(20 * DEG), limbCos, 12 * DEG), 1);
    near(limbFade(Math.cos(64 * DEG), limbCos, 12 * DEG), 0.5);
    near(limbFade(Math.cos(70 * DEG), limbCos, 12 * DEG), 0);
    near(limbFade(Math.cos(120 * DEG), limbCos, 12 * DEG), 0);
  });
});

describe('labels', () => {
  const anchor = (x: number, y: number, more: Partial<LabelAnchor> = {}): LabelAnchor => ({
    x,
    y,
    w: 100,
    h: 20,
    visible: true,
    spots: ['right', 'left', 'above', 'below'],
    ...more,
  });
  const bounds = { w: 800, h: 500 };

  it('beside its mark, on the right when it fits', () => {
    const out: PlacedLabel[] = [];
    placeLabels([anchor(300, 200)], bounds, [], out);
    expect(out[0]).toEqual({ x: 310, y: 190, shown: true });
  });

  it('flips to the left near the right edge, and is never cut by the stage', () => {
    const out: PlacedLabel[] = [];
    placeLabels([anchor(740, 200)], bounds, [], out);
    expect(out[0]).toEqual({ x: 630, y: 190, shown: true });
    placeLabels([anchor(790, 4, { spots: ['right', 'left'] })], bounds, [], out);
    expect(out[0]!.shown).toBe(false);
  });

  it('keeps clear of the panels on the stage and of the labels placed before it', () => {
    const out: PlacedLabel[] = [];
    placeLabels([anchor(300, 200)], bounds, [{ x: 305, y: 150, w: 200, h: 100 }], out);
    expect(out[0]).toEqual({ x: 190, y: 190, shown: true });
    placeLabels([anchor(300, 200), anchor(305, 200)], bounds, [], out);
    expect(out[0]).toEqual({ x: 310, y: 190, shown: true });
    expect(out[1]!.shown).toBe(true);
    expect(out[1]!.x).not.toBe(315);
  });

  it('a label whose mark is behind the globe is not shown', () => {
    const out: PlacedLabel[] = [];
    placeLabels([anchor(300, 200, { visible: false })], bounds, [], out);
    expect(out[0]!.shown).toBe(false);
  });
});

describe("the globe's turn", () => {
  const frame = { dtMs: 16, dragging: false, mayTurn: true, still: false, target: null };
  const run = (m: ReturnType<typeof createGlobeMotion>, ms: number, more = {}) => {
    for (let t = 0; t < ms; t += 16) advanceGlobeMotion(m, { ...frame, ...more });
  };

  it('starts at the tilt, which never changes: the globe only turns left and right', () => {
    const m = createGlobeMotion(0.3);
    expect(m.pitch).toBe(GLOBE_TILT);
    dragGlobe(m, 50, 16, 200);
    run(m, 10_000, { target: 1 });
    expect(m.pitch).toBe(GLOBE_TILT);
  });

  it('eases to its target over EASE_MS, slow at both ends', () => {
    near(easeInOut(0), 0);
    near(easeInOut(0.5), 0.5);
    near(easeInOut(1), 1);
    expect(easeInOut(0.1)).toBeLessThan(0.1);
    const m = createGlobeMotion(0);
    run(m, EASE_MS / 2, { target: 1 });
    expect(Math.abs(m.yaw - 0.5)).toBeLessThan(0.05);
    run(m, EASE_MS / 2 + 32, { target: 1 });
    expect(m.easeMs).toBe(-1);
    expect(Math.abs(m.yaw - 1)).toBeLessThan(0.05);
  });

  it('then sways either side of it, never faster than one turn per DRIFT_TURN_MS', () => {
    near(SWAY_PERIOD_MS, SWAY * DRIFT_TURN_MS);
    const m = createGlobeMotion(0);
    run(m, EASE_MS + 100, { target: 0 });
    let last = m.yaw;
    let fastest = 0;
    let reach = 0;
    for (let t = 0; t < SWAY_PERIOD_MS; t += 16) {
      advanceGlobeMotion(m, { ...frame, target: 0 });
      fastest = Math.max(fastest, Math.abs(wrapAngle(m.yaw - last)) / 16);
      reach = Math.max(reach, Math.abs(m.yaw));
      last = m.yaw;
    }
    expect(fastest).toBeLessThanOrEqual((2 * Math.PI) / DRIFT_TURN_MS + 1e-9);
    expect(reach).toBeLessThanOrEqual(SWAY + 1e-9);
    expect(reach).toBeGreaterThan(SWAY * 0.95);
    near(swayAt(SWAY_PERIOD_MS / 4), SWAY);
  });

  it('a target that hardly moves is not a new ease', () => {
    const m = createGlobeMotion(0);
    run(m, EASE_MS + 100, { target: 0 });
    advanceGlobeMotion(m, { ...frame, target: TARGET_MOVE / 2 });
    expect(m.easeMs).toBe(-1);
    expect(m.target).toBe(0);
    advanceGlobeMotion(m, { ...frame, target: TARGET_MOVE * 2 });
    expect(m.easeMs).toBeGreaterThanOrEqual(0);
    expect(m.target).toBe(TARGET_MOVE * 2);
  });

  it('never turns on its own while paused, stopped or hidden (mayTurn false); its first target is taken straight', () => {
    const m = createGlobeMotion(0.5);
    advanceGlobeMotion(m, { ...frame, mayTurn: false, target: 1.2 });
    near(m.yaw, 1.2);
    const first = m.yaw;
    run(m, 30_000, { mayTurn: false, target: 2 });
    expect(m.yaw).toBe(first);
    expect(m.target).toBe(2);
  });

  it('reduced motion (still): straight on its target, no ease, no sway, and a drag does not coast', () => {
    const m = createGlobeMotion(0);
    advanceGlobeMotion(m, { ...frame, still: true, target: 0.8 });
    near(m.yaw, 0.8);
    run(m, 20_000, { still: true, target: 0.8 });
    near(m.yaw, 0.8);
    dragGlobe(m, 40, 16, 200, true);
    expect(m.yawSpeed).toBe(0);
    near(m.yaw, 1);
    run(m, 20_000, { still: true, target: 0.8 });
    near(m.yaw, 1);
  });

  it('a drag turns the globe with the pointer, coasts, waits RETURN_AFTER_MS, then eases back', () => {
    const m = createGlobeMotion(0);
    run(m, EASE_MS + 100, { target: 0 });
    const before = m.yaw;
    dragGlobe(m, 60, 16, 200);
    near(m.yaw, wrapAngle(before + 0.3));
    expect(m.yawSpeed).toBeGreaterThan(0);
    advanceGlobeMotion(m, { ...frame, dragging: true, target: 0 });
    expect(m.idleMs).toBe(0);
    const held = m.yaw;
    advanceGlobeMotion(m, { ...frame, target: 0 });
    expect(m.yaw).toBeGreaterThan(held);
    run(m, 4000, { target: 0 });
    expect(m.yawSpeed).toBe(0);
    const away = m.yaw;
    run(m, RETURN_AFTER_MS - 4000 - 100, { target: 0 });
    expect(m.yaw).toBe(away);
    run(m, 200 + EASE_MS, { target: 0 });
    expect(Math.abs(m.yaw)).toBeLessThanOrEqual(SWAY + 0.01);
  });

  it('a pointer held still before letting go does not coast; a long gap between frames is not a jump', () => {
    const m = createGlobeMotion(0);
    dragGlobe(m, 60, 16, 200);
    stopCoasting(m);
    expect(m.yawSpeed).toBe(0);
    const n = createGlobeMotion(0);
    advanceGlobeMotion(n, { ...frame, target: 2 });
    advanceGlobeMotion(n, { ...frame, dtMs: 60_000, target: 2 });
    expect(n.easeMs).toBeLessThan(EASE_MS / 4);
  });
});

describe("the arcs' comets", () => {
  it('a still arc: its whole track, no head, no ring', () => {
    const f = createArcFrame();
    arcFrameAt(f, 'still', 1234, 0.5);
    expect(f).toEqual({ head: -1, track: STILL_TRACK, ring: -1 });
    // Drawn plainly, not as the faint track a flight leaves.
    expect(STILL_TRACK).toBeGreaterThanOrEqual(0.5);
    expect(STILL_TRACK).toBeLessThanOrEqual(1);
  });

  it('a flight takes 1.6 to 2.4 seconds, the same for the same arc', () => {
    expect(FLIGHT_MIN_MS).toBe(1600);
    expect(FLIGHT_MAX_MS).toBe(2400);
    const seenMs = new Set<number>();
    for (let k = 0; k < 50; k += 1) {
      const ms = flightMs(k / 50);
      expect(ms).toBeGreaterThanOrEqual(FLIGHT_MIN_MS);
      expect(ms).toBeLessThanOrEqual(FLIGHT_MAX_MS);
      seenMs.add(Math.round(ms));
    }
    expect(seenMs.size).toBeGreaterThan(20);
    expect(flightMs(0.37)).toBe(flightMs(0.37));
  });

  it('live: the head flies to StockPilot, its ring runs, its tail drains, once every LIVE_PERIOD_MS', () => {
    const f = createArcFrame();
    const flight = flightMs(0);
    arcFrameAt(f, 'live', 0, 0);
    expect(f.head).toBe(0);
    expect(f.track).toBe(0);
    expect(f.ring).toBe(-1);
    arcFrameAt(f, 'live', TRACK_IN_MS, 0);
    expect(f.track).toBe(1);
    arcFrameAt(f, 'live', flight, 0);
    expect(f.head).toBe(1);
    expect(f.ring).toBe(0);
    arcFrameAt(f, 'live', flight + RING_MS / 2, 0);
    near(f.ring, 0.5);
    arcFrameAt(f, 'live', flight * (1 + TRAIL) + 1, 0);
    expect(f.head).toBe(-1);
    arcFrameAt(f, 'live', flight + TRACK_HOLD_MS + TRACK_OUT_MS / 2, 0);
    near(f.track, 0.5);
    arcFrameAt(f, 'live', LIVE_PERIOD_MS + 100, 0);
    near(f.head, 100 / flight);
  });

  it("live: every arc's track is gone before it launches again", () => {
    expect(FLIGHT_MAX_MS + TRACK_HOLD_MS + TRACK_OUT_MS).toBeLessThan(LIVE_PERIOD_MS);
    const f = createArcFrame();
    for (let k = 0; k < 20; k += 1) {
      const offset = k / 20;
      // Just before its own next launch.
      arcFrameAt(f, 'live', LIVE_PERIOD_MS * (2 - offset) - 1, offset);
      expect(f.track).toBe(0);
      expect(f.head).toBe(-1);
    }
  });

  it('an offset moves an arc along its own loop, so arcs launch at different moments', () => {
    const f = createArcFrame();
    const g = createArcFrame();
    arcFrameAt(f, 'live', 0, 0.1);
    arcFrameAt(g, 'live', 0, 0.6);
    expect(f.head).not.toBe(g.head);
  });

  it('replay: an arc launches within the spread of its step, flies once, and leaves with the step', () => {
    const f = createArcFrame();
    arcFrameAt(f, 'replay', 100, 0.5, 2500);
    expect(f.head).toBe(-1);
    expect(f.track).toBe(0);
    arcFrameAt(f, 'replay', 0.5 * REPLAY_SPREAD_MS + REPLAY_FLIGHT_MS, 0.5, 2500);
    expect(f.head).toBe(1);
    expect(f.ring).toBe(0);
    arcFrameAt(f, 'replay', 2500 - 175, 0.5, 2500);
    near(f.track, 0.5);
    arcFrameAt(f, 'replay', 2500, 0.5, 2500);
    expect(f.track).toBe(0);
    arcFrameAt(f, 'replay', 10_000, 0.5);
    expect(f.head).toBe(-1);
    expect(f.ring).toBe(-1);
  });

  it('an offset is the same for the same key, and between 0 and 1', () => {
    expect(arcOffset('DE:exploit:blocked')).toBe(arcOffset('DE:exploit:blocked'));
    expect(arcOffset('DE:exploit:blocked')).not.toBe(arcOffset('DE:exploit:flagged'));
    for (const key of ['', 'a', 'US:bots:blocked', 'x'.repeat(300)]) {
      expect(arcOffset(key)).toBeGreaterThanOrEqual(0);
      expect(arcOffset(key)).toBeLessThan(1);
    }
  });
});

describe('marks, glow and scenery', () => {
  it("a source's mark is 10 to 18 pixels across, by core's width for its count", () => {
    expect(sourceMarkSize(1)).toBe(10);
    expect(sourceMarkSize(4)).toBe(18);
    expect(sourceMarkSize(2.5)).toBe(14);
    expect(sourceMarkSize(0)).toBe(10);
    expect(sourceMarkSize(9)).toBe(18);
    expect(sourceMarkSize(Number.NaN)).toBe(10);
  });

  it("a country's glow grows with its share of the play, on a log scale; none without events", () => {
    expect(heatOf(0, 100)).toBe(0);
    expect(heatOf(5, 0)).toBe(0);
    expect(heatOf(100, 100)).toBe(1);
    near(heatOf(10, 100), 0.35 + (0.65 * Math.log(11)) / Math.log(101));
    expect(heatOf(1, 1000)).toBeGreaterThan(0.35);
    expect(heatOf(10, 1000)).toBeGreaterThan(heatOf(1, 1000));
    expect(heatOf(100, 1000)).toBeGreaterThan(heatOf(10, 1000));
    expect(heatOf(5000, 1000)).toBe(1);
  });

  it('the stars are the same on every load, inside the stage, never brighter than 1', () => {
    const a = writeStars(200, 7);
    expect(a).toEqual(writeStars(200, 7));
    expect(a).not.toEqual(writeStars(200, 8));
    for (let i = 0; i < 200; i += 1) {
      expect(Math.abs(a[i * 3]!)).toBeLessThanOrEqual(1);
      expect(Math.abs(a[i * 3 + 1]!)).toBeLessThanOrEqual(1);
      expect(a[i * 3 + 2]!).toBeGreaterThanOrEqual(0.25);
      expect(a[i * 3 + 2]!).toBeLessThanOrEqual(1);
    }
  });
});

describe('the flat map', () => {
  it('projects into its own box; latitudes past its edges are drawn on the edge', () => {
    const [x0] = projectFlat(-180, 0);
    const [x1] = projectFlat(180, 0);
    near(x0, 0);
    near(x1, FLAT_WIDTH);
    const [, top] = projectFlat(0, 84);
    const [, bottom] = projectFlat(0, -58);
    near(top, 0);
    near(bottom, FLAT_HEIGHT, 0);
    expect(projectFlat(0, -85)).toEqual(projectFlat(0, -58));
    const [xm, ym] = projectFlat(0, 0);
    near(xm, FLAT_WIDTH / 2);
    expect(ym).toBeGreaterThan(0);
    expect(ym).toBeLessThan(FLAT_HEIGHT);
  });

  it('the dots are ONE path of zero-length segments; dots past the edge are left out', () => {
    const path = worldDotsPath(new Float32Array([0, 0, 10, 20, 0, -80]));
    expect(path.match(/M/g)).toHaveLength(2);
    expect(path).toMatch(/^M[\d.]+ [\d.]+h0M[\d.]+ [\d.]+h0$/);
  });

  it('an arc is a curve that bows north from the country to StockPilot', () => {
    const d = flatArcPath([10, 50], STOCKPILOT_LON_LAT);
    const [x0, y0] = projectFlat(10, 50);
    expect(d.startsWith(`M${Math.round(x0 * 10) / 10} ${Math.round(y0 * 10) / 10}Q`)).toBe(true);
    const numbers = d.match(/-?[\d.]+/g)!.map(Number);
    // The control point is above (smaller y than) both ends.
    expect(numbers[3]!).toBeLessThan(Math.min(numbers[1]!, numbers[5]!));
  });

  it('a code with no point has none; never a made-up one', () => {
    expect(countryPoint('DE')).not.toBeNull();
    // Kosovo is not an ISO 3166-1 code; its point is written by hand.
    expect(countryPoint('XK')).not.toBeNull();
    expect(countryPoint('QY')).toBeNull();
    expect(countryPoint('toString')).toBeNull();
    expect(countryPoint('')).toBeNull();
  });
});
