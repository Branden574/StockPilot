import { describe, expect, it } from 'vitest';

import {
  FORCE_AFTER_MS,
  REFRACTORY_MS,
  SCENE_CHANGED,
  SHARP_ENOUGH,
  decideGate,
  frameTimestampToMsFactor,
  type GateTiming,
} from './size-scan-gate-core';

// This file imports NO React Native or vision-camera modules — the whole point
// of size-scan-gate-core is that the decision is pure and runs unchanged in
// node. So decideGate is tested DIRECTLY (not a mirror): a change to its real
// comparison logic fails a test here.

// ---------------------------------------------------------------------------
// THE BUG THIS FILE EXISTS FOR — hands-free counted NOTHING on the first real
// phone (1.4.0). `Frame.timestamp` is SECONDS on iOS, NANOSECONDS on Android;
// the gate assumed ns and multiplied its ms thresholds by 1e6, so on an iPhone
// the refractory window `now - lastFired < 350e6` was true forever.
// ---------------------------------------------------------------------------

describe('frameTimestampToMsFactor — the unit that jammed the gate', () => {
  it('scales iOS SECONDS to milliseconds (×1000)', () => {
    expect(12_345.678 * frameTimestampToMsFactor('ios')).toBeCloseTo(12_345_678, 3);
  });
  it('scales Android NANOSECONDS to milliseconds (÷1e6)', () => {
    expect(1_750_000_000_000 * frameTimestampToMsFactor('android')).toBeCloseTo(1_750_000, 3);
  });
});

/** Run a frame stream through the REAL decideGate and count fires. Times are in
 *  milliseconds, exactly what the worklet passes after the TS_TO_MS scale. */
function runGate(frames: { ms: number; sceneDelta: number; motion: number; armed?: boolean }[]): number {
  const timing: GateTiming = { changedAt: 0, lastFiredAt: 0 };
  let fires = 0;
  for (const f of frames) {
    if (decideGate(timing, f.ms, f.sceneDelta, f.motion, f.armed ?? true)) fires += 1;
  }
  return fires;
}

describe('decideGate with realistic iOS (seconds→ms) timing', () => {
  // ~12345 s of iOS uptime, in ms, 100 ms apart — what the camera delivers.
  // The OLD ×1e6 code produced ZERO fires for every one of these.
  const t0 = 12_345 * frameTimestampToMsFactor('ios');
  const at = (n: number) => t0 + n * 100;

  it('fires ONCE for a single new garment that settles', () => {
    expect(
      runGate([
        { ms: at(0), sceneDelta: 40, motion: 20 }, // new, blurred
        { ms: at(1), sceneDelta: 40, motion: 3 }, // sharp → FIRE
        { ms: at(2), sceneDelta: 2, motion: 3 }, // same garment
      ]),
    ).toBe(1);
  });

  it('does NOT double-count one garment lingering under the camera', () => {
    const frames = [
      { ms: at(0), sceneDelta: 40, motion: 3 },
      ...Array.from({ length: 10 }, (_, i) => ({ ms: at(1 + i), sceneDelta: 3, motion: 3 })),
    ];
    expect(runGate(frames)).toBe(1);
  });

  it('fires TWICE for two different garments, even the same size', () => {
    expect(
      runGate([
        { ms: at(0), sceneDelta: 40, motion: 3 }, // A → FIRE
        { ms: at(1), sceneDelta: 2, motion: 3 }, // A present
        { ms: at(8), sceneDelta: 45, motion: 3 }, // B past refractory → FIRE
      ]),
    ).toBe(2);
  });

  it('the refractory blocks a second fire within REFRACTORY_MS', () => {
    expect(
      runGate([
        { ms: at(0), sceneDelta: 40, motion: 3 },
        { ms: at(1), sceneDelta: 40, motion: 3 }, // +100ms < 350 → blocked
      ]),
    ).toBe(1);
    expect(REFRACTORY_MS).toBeGreaterThan(100);
  });

  it('the force-deadline fires a soft frame when no lull ever comes', () => {
    const frames = Array.from({ length: 12 }, (_, i) => ({
      ms: at(i),
      sceneDelta: 40,
      motion: SHARP_ENOUGH + 20, // never sharp
    }));
    expect(runGate(frames)).toBeGreaterThanOrEqual(1);
  });

  it('does not accumulate a change window while DISARMED, and fires fresh on re-arm', () => {
    // Review sheet open: armed=false. A big scene change during that time must
    // not carry over into an immediate fire the instant the sheet closes.
    const timing: GateTiming = { changedAt: 0, lastFiredAt: 0 };
    expect(decideGate(timing, at(0), 40, 3, false)).toBe(false);
    expect(timing.changedAt).toBe(0);
    // Re-armed, but this frame has NOT yet been seen as changed for long enough
    // to matter — it fires on its own merits (sharp + changed), not on a stale
    // window. Here it is sharp, so it fires this frame; changedAt was reset.
    expect(decideGate(timing, at(1), 40, 3, true)).toBe(true);
  });

  it('REGRESSION: the shipped ×1e6 formula never fired', () => {
    // The exact 1.4.0 mistake: refractory `< REFRACTORY_MS * 1e6` against
    // seconds-scale ms timestamps. Prove it is stuck at zero.
    let fires = 0;
    const lastFiredAt = 0;
    for (const ms of [at(0), at(1)]) {
      if (ms - lastFiredAt < REFRACTORY_MS * 1e6) continue; // 3.5e8 — always true
      fires += 1;
    }
    expect(fires).toBe(0);
    // And the FIXED comparison (no ×1e6) does fire on the same inputs.
    expect(at(1) - 0 < REFRACTORY_MS).toBe(false);
  });

  it('the tuning constants are the documented starting points', () => {
    expect([SCENE_CHANGED, SHARP_ENOUGH, FORCE_AFTER_MS, REFRACTORY_MS]).toEqual([12, 6, 700, 350]);
  });
});
