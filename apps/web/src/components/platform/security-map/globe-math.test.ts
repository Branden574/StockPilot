// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  ARC_MAX_HEIGHT,
  ARC_MIN_HEIGHT,
  ARC_SEGMENTS,
  FITS_IN_VIEW,
  LIVE_PERIOD_MS,
  LIVE_TRAVEL_MS,
  MAX_PITCH,
  PULSE_MS,
  REPLAY_SPREAD_MS,
  REPLAY_TRAVEL_MS,
  RESUME_AFTER_MS,
  TURN_MS,
  advanceGlobeMotion,
  arcFrameAt,
  arcHeight,
  arcOffset,
  centralAngle,
  createArcFrame,
  createGlobeMotion,
  dotPositions,
  dragGlobe,
  facingOf,
  lonLatToVector,
  pointAlong,
  stopCoasting,
  tubeIndexes,
  tubeVertexCount,
  turnPoint,
  wrapAngle,
  writeArcPoints,
  writeTube,
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
  it('yaw = -longitude, then pitch = latitude, brings the place to the front (+z)', () => {
    for (const [lon, lat] of [
      [30, 10],
      [-77.5, 39],
      [139.7, 35.7],
      [-58, -34],
    ] as const) {
      const facing = facingOf([[lon, lat]])!;
      near(facing.yaw, (-lon * Math.PI) / 180);
      near(facing.pitch, (lat * Math.PI) / 180);
      near(facing.spread, 0);
      const v = vec(lon, lat);
      turnPoint(v, facing.yaw, facing.pitch);
      near(v[0]!, 0);
      near(v[1]!, 0);
      near(v[2]!, 1);
    }
  });

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

  it('several places: their middle, and how far the farthest is from it', () => {
    const facing = facingOf([
      [-10, 0],
      [10, 0],
    ])!;
    near(facing.yaw, 0);
    near(facing.pitch, 0);
    near(facing.spread, (10 * Math.PI) / 180);
    expect(facingOf([])).toBeNull();
    // Places all round the equator have no middle.
    expect(
      facingOf([
        [0, 0],
        [90, 0],
        [180, 0],
        [-90, 0],
      ]),
    ).toBeNull();
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

  it('a tube around the arc: rings of vertices at the radius, thinner at the ends, with how far along each is', () => {
    const segments = 8;
    const sides = 5;
    const points = new Float32Array((segments + 1) * 3);
    writeArcPoints([0, 0], [60, 0], points, segments);
    const positions = new Float32Array(tubeVertexCount(segments, sides) * 3);
    const along = new Float32Array(tubeVertexCount(segments, sides));
    const normals = new Float32Array(tubeVertexCount(segments, sides) * 3);
    writeTube(points, segments, sides, 0.01, positions, along, normals);
    // Each normal is a unit vector pointing from the line out to its vertex.
    for (let v = 0; v < tubeVertexCount(segments, sides); v += 1) {
      near(Math.hypot(normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!), 1, 5);
    }
    const i0 = segments / 2;
    const out0 = [0, 1, 2].map(
      (k) => (positions[i0 * sides * 3 + k]! - points[i0 * 3 + k]!) / 0.01,
    );
    // Float32 positions: four places.
    for (let k = 0; k < 3; k += 1) near(out0[k]!, normals[i0 * sides * 3 + k]!, 4);
    expect(positions.every(Number.isFinite)).toBe(true);
    const ringRadius = (i: number) => {
      const c = [points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!];
      const v = i * sides;
      return Math.hypot(
        positions[v * 3]! - c[0]!,
        positions[v * 3 + 1]! - c[1]!,
        positions[v * 3 + 2]! - c[2]!,
      );
    };
    near(ringRadius(segments / 2), 0.01, 6);
    expect(ringRadius(0)).toBeLessThan(ringRadius(segments / 2));
    expect(along[0]).toBe(0);
    expect(along[along.length - 1]).toBe(1);
    const indexes = tubeIndexes(segments, sides);
    expect(indexes).toHaveLength(segments * sides * 6);
    // Every triangle faces out of the tube: its normal points the way its
    // vertices' own normals do.
    const p = (v: number) => [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
    for (let t = 0; t < indexes.length; t += 3) {
      const [a, b, c] = [p(indexes[t]!), p(indexes[t + 1]!), p(indexes[t + 2]!)];
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const face = [
        u[1]! * w[2]! - u[2]! * w[1]!,
        u[2]! * w[0]! - u[0]! * w[2]!,
        u[0]! * w[1]! - u[1]! * w[0]!,
      ];
      const v0 = indexes[t]!;
      const out =
        face[0]! * normals[v0 * 3]! +
        face[1]! * normals[v0 * 3 + 1]! +
        face[2]! * normals[v0 * 3 + 2]!;
      expect(out, `triangle ${t / 3}`).toBeGreaterThan(0);
    }
    expect(Math.max(...indexes)).toBe(tubeVertexCount(segments, sides) - 1);
  });
});

describe("the globe's turn", () => {
  const still = { dtMs: 16, dragging: false, mayTurn: true, focus: null };

  it('turns slowly on its own when there is nothing to face, one turn per TURN_MS', () => {
    const m = createGlobeMotion(0, 0.32);
    advanceGlobeMotion(m, still);
    near(m.yaw, (2 * Math.PI * 16) / TURN_MS);
  });

  it('never turns on its own while paused, stopped or hidden (mayTurn false), nor while dragged', () => {
    const m = createGlobeMotion(0.5, 0.2);
    for (let i = 0; i < 100; i += 1) advanceGlobeMotion(m, { ...still, mayTurn: false });
    expect(m.yaw).toBe(0.5);
    expect(m.pitch).toBe(0.2);
    advanceGlobeMotion(m, { ...still, dragging: true });
    expect(m.yaw).toBe(0.5);
    expect(m.idleMs).toBe(0);
  });

  it('waits after the viewer lets go, then eases toward the places that are active', () => {
    const m = createGlobeMotion(0, 0);
    dragGlobe(m, 0, 0, 16, 300);
    stopCoasting(m);
    const focus = { yaw: 1, pitch: 0.3, spread: 0.2 };
    advanceGlobeMotion(m, { ...still, focus });
    expect(m.yaw).toBe(0);
    for (let t = 0; t < RESUME_AFTER_MS; t += 16) advanceGlobeMotion(m, { ...still, focus });
    for (let t = 0; t < 20_000; t += 16) advanceGlobeMotion(m, { ...still, focus });
    // Within the sway of the target.
    expect(Math.abs(wrapAngle(m.yaw - 1))).toBeLessThan(0.2);
    expect(Math.abs(m.pitch - 0.24)).toBeLessThan(0.05);
  });

  it('places spread too far to fit in view: a steady turn instead of facing them', () => {
    const m = createGlobeMotion(0, 0.32);
    advanceGlobeMotion(m, { ...still, focus: { yaw: 2, pitch: 0, spread: FITS_IN_VIEW + 0.1 } });
    near(m.yaw, (2 * Math.PI * 16) / TURN_MS);
  });

  it('a drag turns the globe with the pointer, then coasts and slows to a stop', () => {
    const m = createGlobeMotion(0, 0);
    dragGlobe(m, 30, 0, 16, 300);
    near(m.yaw, 0.1);
    expect(m.yawSpeed).toBeGreaterThan(0);
    const before = m.yaw;
    advanceGlobeMotion(m, { ...still, mayTurn: false });
    expect(m.yaw).toBeGreaterThan(before);
    for (let i = 0; i < 2000; i += 1) advanceGlobeMotion(m, { ...still, mayTurn: false });
    expect(m.yawSpeed).toBe(0);
  });

  it('the pitch stays within its bounds; a long gap between frames is not a jump', () => {
    const m = createGlobeMotion(0, 0);
    dragGlobe(m, 0, 10_000, 16, 300);
    expect(m.pitch).toBe(MAX_PITCH);
    const n = createGlobeMotion(0, 0.32);
    advanceGlobeMotion(n, { ...still, dtMs: 60_000 });
    expect(n.yaw).toBeLessThan((2 * Math.PI * 100) / TURN_MS);
  });
});

describe("the arcs' heads", () => {
  it('a still arc: the whole path, no head, no pulse', () => {
    const f = createArcFrame();
    arcFrameAt(f, 'still', 1234, 0.5);
    expect(f).toEqual({ head: -1, base: 0.6, startPulse: -1, landPulse: -1 });
  });

  it('live: the head goes from the start to StockPilot in LIVE_TRAVEL_MS and starts again every LIVE_PERIOD_MS', () => {
    const f = createArcFrame();
    arcFrameAt(f, 'live', 0, 0);
    expect(f.head).toBe(0);
    expect(f.startPulse).toBe(0);
    arcFrameAt(f, 'live', LIVE_TRAVEL_MS, 0);
    expect(f.head).toBe(1);
    expect(f.landPulse).toBe(0);
    arcFrameAt(f, 'live', LIVE_TRAVEL_MS + PULSE_MS / 2, 0);
    expect(f.landPulse).toBe(0.5);
    arcFrameAt(f, 'live', LIVE_PERIOD_MS + 100, 0);
    near(f.head, 100 / LIVE_TRAVEL_MS);
    // The offset moves an arc along its own loop.
    arcFrameAt(f, 'live', 0, 0.5);
    near(f.head, (0.5 * LIVE_PERIOD_MS) / LIVE_TRAVEL_MS);
  });

  it('replay: an arc starts within the spread of its step and plays once', () => {
    const f = createArcFrame();
    arcFrameAt(f, 'replay', 100, 0.5);
    expect(f.head).toBe(-1);
    expect(f.base).toBe(0);
    arcFrameAt(f, 'replay', 0.5 * REPLAY_SPREAD_MS + REPLAY_TRAVEL_MS, 0.5);
    expect(f.head).toBe(1);
    expect(f.landPulse).toBe(0);
    arcFrameAt(f, 'replay', 10_000, 0.5);
    expect(f.head).toBeGreaterThan(2);
    expect(f.landPulse).toBe(-1);
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
    expect(countryPoint('XK')).toBeNull();
    expect(countryPoint('toString')).toBeNull();
    expect(countryPoint('')).toBeNull();
  });
});
