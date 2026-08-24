import { describe, expect, it } from 'vitest';

import {
  CANDIDATE_MS,
  CAL_STABLE_MS,
  CLEAR_MAX,
  CLEAR_RELAXED_MAX,
  CLEAR_MS,
  FORCE_AFTER_MS,
  LOCKED_REBASE_MS,
  PRESENT_MIN,
  REFRACTORY_MS,
  SHARP_ENOUGH,
  STABLE_MOTION,
  createGateState,
  frameTimestampToMsFactor,
  resetGateState,
  stepGate,
  type GateAction,
  type GateState,
} from './size-scan-gate-core';

// ---------------------------------------------------------------------------
// This file imports NO React Native or vision-camera modules — the decision is
// pure and runs unchanged in node, so stepGate is tested DIRECTLY.
//
// THE HARNESS MODELS THE BUFFERS, NOT JUST THE DELTAS. Tests script a SCENE
// LEVEL (mean luma of the lane) per segment; the sim owns the background the
// way the worklet's buffers do — bgDelta is |scene − background|, and a
// 'setBackground'/'clearLane' action ADOPTS the current scene. Scripting raw
// deltas instead is how a first version of this suite lied to itself: after a
// re-baseline the same scene must read as ~0, which a scripted constant
// cannot express.
//
// THREE PRODUCTION FINDINGS ANCHOR THIS SUITE:
//   1. iOS timestamps are SECONDS (gate v1 assumed ns → fired never).
//   2. Scene-change ≠ identity (gate v2 fired 23× for ~10 shirts).
//   3. Adversarial review proved two DEADLOCKS in the first state machine:
//      calibration over a garment, and any permanent scene shift > CLEAR_MAX.
//      Their exact repro sequences are regressions below.
// ---------------------------------------------------------------------------

const FRAME_MS = 33;
const T0 = 12_345 * frameTimestampToMsFactor('ios'); // realistic iPhone uptime, ms

type Sim = {
  s: GateState;
  now: number;
  fires: number;
  actions: GateAction[];
  /** The adopted background scene level; null until first setBackground. */
  bgLevel: number | null;
};

function sim(): Sim {
  return { s: createGateState(), now: T0, fires: 0, actions: [], bgLevel: null };
}

/** Advance `ms` of camera time at a constant scene level + motion. The sim
 *  computes bgDelta against its OWN background and honours adoptions, exactly
 *  as the worklet's buffers do. */
function feed(m: Sim, ms: number, scene: number, motion: number, armed = true): void {
  const frames = Math.ceil(ms / FRAME_MS);
  for (let i = 0; i < frames; i += 1) {
    m.now += FRAME_MS;
    const bgDelta = m.bgLevel == null ? 0 : Math.abs(scene - m.bgLevel);
    const a = stepGate(m.s, m.now, bgDelta, motion, armed);
    m.actions.push(a);
    if (a === 'fire') m.fires += 1;
    if (a === 'setBackground' || a === 'clearLane') m.bgLevel = scene;
  }
}

/** Calibrate on a still lane at `scene` — every scenario starts here. */
function calibrated(scene = 0): Sim {
  const m = sim();
  feed(m, CAL_STABLE_MS + 100, scene, 0);
  expect(m.s.phase).toBe('waiting');
  expect(m.bgLevel).toBe(scene);
  return m;
}

/** One garment slides in (moving), lulls (sharp), then slides out. */
function passOneGarment(m: Sim, opts?: { garment?: number; empty?: number; skipClear?: boolean }): void {
  const g = opts?.garment ?? 40;
  const e = opts?.empty ?? (m.bgLevel ?? 0);
  feed(m, CANDIDATE_MS + 66, g, 15); // arriving: present, blurred
  feed(m, 66, g, 2); // lull → fire
  if (!opts?.skipClear) feed(m, CLEAR_MS + 66, e, 4); // slides out → lane clears
}

// ─── the reported production bug, as a regression ──────────────────────────

describe('SEQUENCE: one shirt moving/folding continuously (the 23-passed bug)', () => {
  it('fires exactly ONCE however long and however much the shirt moves', () => {
    const m = calibrated();
    feed(m, CANDIDATE_MS + 66, 40, 15); // shirt arrives
    feed(m, 66, 40, 2); // lull → FIRE
    expect(m.fires).toBe(1);
    // The shirt stays 10 SECONDS: folding (appearance jumps), briefly pausing
    // (short lulls the old gate fired on), fidgeting. The alternation keeps
    // any continuous stillness far under LOCKED_REBASE_MS, so the lock holds.
    for (let i = 0; i < 20; i += 1) {
      feed(m, 250, 25 + (i % 3) * 15, 12); // folds: big appearance changes
      feed(m, 250, 30, 2); // pauses: sharp lulls, way past every refractory
    }
    expect(m.fires).toBe(1);
    expect(m.s.phase).toBe('locked');
  });

  it('refractory expiry NEVER releases the lock while the garment is handled', () => {
    const m = calibrated();
    passOneGarment(m, { skipClear: true });
    expect(m.fires).toBe(1);
    // 20× the refractory with the garment in the lane, sharp enough to read
    // (motion 5 ≤ SHARP_ENOUGH) but never dead-still (motion > STABLE_MOTION),
    // so neither the timer nor the stillness recovery can fire it again.
    feed(m, REFRACTORY_MS * 20, 35, 5);
    expect(m.fires).toBe(1);
    expect(m.s.phase).toBe('locked');
  });

  it('VERBATIM legacy algorithm double-counts the same sequence', () => {
    // Copied word-for-word from the 1.4.0-OTA1 size-scan-gate-core.ts —
    // the algorithm the state machine replaces. Kept so the difference is
    // DEMONSTRATED, not asserted: same physics, old code fires 2+.
    const legacy = (
      timing: { changedAt: number; lastFiredAt: number },
      nowMs: number,
      sceneDelta: number,
      motion: number,
    ): boolean => {
      if (nowMs - timing.lastFiredAt < REFRACTORY_MS) return false;
      if (sceneDelta < 12) {
        timing.changedAt = 0;
        return false;
      }
      if (timing.changedAt === 0) timing.changedAt = nowMs;
      const waited = nowMs - timing.changedAt;
      if (motion > SHARP_ENOUGH && waited < FORCE_AFTER_MS) return false;
      timing.changedAt = 0;
      timing.lastFiredAt = nowMs;
      return true;
    };

    const timing = { changedAt: 0, lastFiredAt: 0 };
    let now = T0;
    let fires = 0;
    let sceneDelta = 255; // legacy semantics: no reference yet
    const frame = (delta: number, motion: number) => {
      now += FRAME_MS;
      if (legacy(timing, now, sceneDelta, motion)) {
        fires += 1;
        sceneDelta = 0; // capture re-references: scene now matches
      } else {
        sceneDelta = delta;
      }
    };
    // Shirt arrives and lulls → fire #1 (correct)…
    for (let i = 0; i < 8; i += 1) frame(40, 2);
    // …then THE SAME SHIRT folds (appearance jumps vs the captured frame) and
    // pauses again, past the refractory → the legacy gate fires AGAIN.
    for (let i = 0; i < 20; i += 1) frame(25, 2);
    expect(fires).toBeGreaterThanOrEqual(2); // the bug, demonstrated
  });
});

// ─── the brief's required sequences ─────────────────────────────────────────

describe('garment lifecycle sequences', () => {
  it('A: one shirt placed and left dead-still → 1 (adoption may occur, no extra fire)', () => {
    const m = calibrated();
    feed(m, CANDIDATE_MS + 66, 40, 8);
    feed(m, 66, 40, 1); // still → fire
    feed(m, 5000, 40, 0.5); // sits five seconds, dead still → may be adopted
    expect(m.fires).toBe(1);
  });

  it('B/C: one shirt in continuous motion (never a lull) → 1, via the deadline', () => {
    const m = calibrated();
    feed(m, CANDIDATE_MS + FORCE_AFTER_MS + 132, 40, 20); // never sharp
    expect(m.fires).toBe(1); // forced capture
    feed(m, 3000, 40, 20); // keeps writhing — motion blocks recovery too
    expect(m.fires).toBe(1);
    expect(m.s.phase).toBe('locked');
  });

  it('E: two clearly separated shirts → 2', () => {
    const m = calibrated();
    passOneGarment(m);
    passOneGarment(m);
    expect(m.fires).toBe(2);
  });

  it('F: three same-size shirts → 3 (identity is traversal, never the label)', () => {
    const m = calibrated();
    passOneGarment(m);
    passOneGarment(m);
    passOneGarment(m);
    expect(m.fires).toBe(3);
  });

  it('G/H: identical-looking consecutive shirts still count separately', () => {
    const m = calibrated();
    passOneGarment(m, { garment: 30 });
    passOneGarment(m, { garment: 30 });
    expect(m.fires).toBe(2);
  });

  it('I: shirt leaves and nothing follows → no phantom pass', () => {
    const m = calibrated();
    passOneGarment(m);
    expect(m.fires).toBe(1);
    feed(m, 8000, 0, 0.5); // empty lane for eight seconds
    expect(m.fires).toBe(1);
    expect(m.s.phase).toBe('waiting');
  });

  it('J: empty lane with exposure drift → 0 (adaptation absorbs it)', () => {
    const m = calibrated();
    // Slow permanent creep: scene walks up a little at a time; each quiet
    // ADAPT_MS the background re-adopts and the delta resets.
    for (let i = 0; i < 10; i += 1) {
      feed(m, 1500, 4 + i, 1);
    }
    expect(m.fires).toBe(0);
    expect(m.actions.filter((a) => a === 'setBackground').length).toBeGreaterThan(1);
  });

  it('K: a hand flashes across the lane → 0', () => {
    const m = calibrated();
    feed(m, CANDIDATE_MS - 66, 60, 25); // big but shorter than the dwell
    feed(m, 1000, 0, 0.5);
    expect(m.fires).toBe(0);
    expect(m.s.phase).toBe('waiting');
  });

  it('K2: something arrives but is snatched away before a photo → 0', () => {
    const m = calibrated();
    feed(m, CANDIDATE_MS + 66, 40, 20); // present, never sharp yet
    feed(m, 200, 0, 10); // gone before lull/deadline
    feed(m, 500, 0, 0.5);
    expect(m.fires).toBe(0);
    expect(m.s.phase).toBe('waiting');
  });

  it('L: garments at a brisk one-per-second pace → one fire each', () => {
    const m = calibrated();
    for (let i = 0; i < 10; i += 1) {
      feed(m, 300, 40, 12); // in
      feed(m, 66, 40, 2); // lull
      feed(m, CLEAR_MS + 66, 0, 6); // out
    }
    expect(m.fires).toBe(10);
  });
});

// ─── adversarial-review regressions ─────────────────────────────────────────
//
// Each sequence below was CONFIRMED as a deadlock or contract break by an
// independent reviewer running the previous revision of this module — the
// code before the fix fails these.

describe('REVIEW REGRESSION: calibration over a garment must self-heal', () => {
  it('start with a shirt already in the lane: at most one phantom, then every real garment counts', () => {
    const m = sim();
    // Operator taps Start (or Keep-going) with shirt #1 already placed and
    // holds still: the garment scene (40) becomes the "empty" background —
    // unavoidable, since no true background exists yet to check against.
    feed(m, CAL_STABLE_MS + 100, 40, 1);
    expect(m.s.phase).toBe('waiting');
    expect(m.bgLevel).toBe(40);
    // Shirt lifted out: the EMPTY lane (0) reads as presence vs the garment
    // background → ONE phantom fire (lands as unread in the UI).
    feed(m, CANDIDATE_MS + 66, 0, 12);
    feed(m, 66, 0, 2);
    const phantoms = m.fires;
    expect(phantoms).toBeLessThanOrEqual(1);
    // The empty lane sits dead still. Previously: LOCKED FOREVER — the
    // reviewer measured 10 straight silently-uncounted garments. Now: the
    // stillness recovery adopts the true empty lane.
    feed(m, LOCKED_REBASE_MS + 500, 0, 0.5);
    expect(m.s.phase).toBe('waiting');
    expect(m.bgLevel).toBe(0);
    // Ten real garments must now ALL count.
    for (let i = 0; i < 10; i += 1) passOneGarment(m);
    expect(m.fires).toBe(phantoms + 10);
  });
});

describe('REVIEW REGRESSION: a permanent scene shift must never stall the count', () => {
  it('shift during a traversal (> CLEAR_MAX): the lock recovers and later garments count', () => {
    const m = calibrated(0);
    // Garment arrives and fires; while it is in the lane the light steps
    // permanently: the empty lane will now sit at 12 (below PRESENT_MIN,
    // above CLEAR_MAX — the reviewer's exact band).
    feed(m, CANDIDATE_MS + 66, 40, 12);
    feed(m, 66, 40, 2);
    expect(m.fires).toBe(1);
    // Garment leaves; lane reads 12 vs the old background. Previously:
    // clearStart never accrued (12 > CLEAR_MAX) → locked for good. Now the
    // RELAXED clear (12 <= CLEAR_RELAXED_MAX) releases and re-baselines
    // within CLEAR_MS — no stillness wait needed at this magnitude.
    feed(m, LOCKED_REBASE_MS + 500, 12, 0.5);
    expect(m.s.phase).toBe('waiting');
    expect(m.bgLevel).toBe(12);
    // The machine keeps counting real garments in the shifted world.
    for (let i = 0; i < 10; i += 1) passOneGarment(m, { garment: 52, empty: 12 });
    expect(m.fires).toBe(11);
  });

  it('shift into the 9..12 band while WAITING: healed by the RELAXED clear on the next pass', () => {
    const m = calibrated(0);
    // Permanent +12 while waiting. Adaptation deliberately does NOT absorb it
    // (the widened band was proven to adopt pale garments — 1/10 counted), so
    // the background stays stale here…
    feed(m, 3000, 12, 0.5);
    expect(m.bgLevel).toBe(0);
    expect(m.fires).toBe(0);
    // …and the heal happens at the LOCK instead: the next garment fires, and
    // when it leaves, the lane reads 12 <= CLEAR_RELAXED_MAX — the counted
    // garment (which proved >= PRESENT_MIN) is demonstrably gone, so the
    // clear re-baselines onto the shifted lane.
    passOneGarment(m, { garment: 52, empty: 12 });
    expect(m.fires).toBe(1);
    expect(m.s.phase).toBe('waiting');
    expect(m.bgLevel).toBe(12);
    // Counting continues cleanly in the shifted world.
    for (let i = 0; i < 5; i += 1) passOneGarment(m, { garment: 52, empty: 12 });
    expect(m.fires).toBe(6);
  });

  it('REVIEW REGRESSION: a pale sub-threshold garment pausing in the lane is NOT adopted', () => {
    // The widened-band poisoning, exactly as the reviewer simulated it: a
    // garment at bgDelta 12 pauses dead-still past ADAPT_MS. Under the
    // widened band it became the background and a following brisk stream
    // counted 1 of 10. The tight band must leave the background alone.
    const m = calibrated(0);
    feed(m, 2000, 12, 0.5); // pale garment, parked still, well past ADAPT_MS
    expect(m.bgLevel).toBe(0); // NOT adopted
    feed(m, 300, 0, 6); // it leaves
    // Ten normal garments at a brisk pace: every one must count.
    for (let i = 0; i < 10; i += 1) passOneGarment(m);
    expect(m.fires).toBe(10);
  });
});

describe('REVIEW REGRESSION: a pause never banks a fire', () => {
  it('present-then-disarm does not fire instantly on re-arm', () => {
    const m = calibrated();
    // Garment sustains presence, never sharp — 'present' with the force
    // deadline running.
    feed(m, CANDIDATE_MS + 66, 40, 20);
    expect(m.s.phase).toBe('present');
    // Pause 2s (longer than FORCE_AFTER_MS) with the lane still occupied.
    feed(m, 2000, 40, 20, false);
    expect(m.s.phase).toBe('waiting'); // demoted, not banked
    // Re-arm: the first frames must NOT fire — presence re-proves itself.
    feed(m, 66, 40, 20);
    expect(m.fires).toBe(0);
    // …and a fresh sustained presence still fires normally.
    feed(m, CANDIDATE_MS + 66, 40, 20);
    feed(m, 66, 40, 2);
    expect(m.fires).toBe(1);
  });
});

describe('the accepted trade: a garment parked dead-still gets adopted', () => {
  it('parking a counted shirt 2.5s+ costs at most one phantom pass on departure — never a stall', () => {
    const m = calibrated();
    feed(m, CANDIDATE_MS + 66, 40, 12);
    feed(m, 66, 40, 2); // counted
    expect(m.fires).toBe(1);
    // Operator parks it, dead still, past the recovery window: adopted.
    feed(m, LOCKED_REBASE_MS + 500, 40, 0.5);
    expect(m.s.phase).toBe('waiting');
    expect(m.bgLevel).toBe(40);
    // Departure of the adopted shirt reads as presence → one phantom fire,
    // which the reader reports as unread (it photographs an empty lane).
    feed(m, CANDIDATE_MS + 66, 0, 12);
    feed(m, 66, 0, 2);
    expect(m.fires).toBe(2); // 1 real + 1 phantom, bounded and visible
    // Self-heal: the still empty lane is re-adopted, and counting continues.
    feed(m, LOCKED_REBASE_MS + 500, 0, 0.5);
    expect(m.s.phase).toBe('waiting');
    for (let i = 0; i < 3; i += 1) passOneGarment(m);
    expect(m.fires).toBe(5);
  });

  it('a garment still being HANDLED (motion) is never adopted — the lock holds', () => {
    const m = calibrated();
    passOneGarment(m, { skipClear: true });
    expect(m.fires).toBe(1);
    // Ten seconds of the shirt moving/folding: motion stays above
    // STABLE_MOTION, so the recovery window never opens.
    feed(m, 10_000, 35, 8);
    expect(m.s.phase).toBe('locked');
    expect(m.fires).toBe(1);
  });
});

// ─── mechanics ──────────────────────────────────────────────────────────────

describe('state machine mechanics', () => {
  it('calibration will not complete over a moving scene', () => {
    const m = sim();
    feed(m, 2000, 0, 10); // never still
    expect(m.s.phase).toBe('calibrating');
    feed(m, CAL_STABLE_MS + 100, 0, 1);
    expect(m.s.phase).toBe('waiting');
  });

  it('hysteresis: bgDelta hovering in the dead band moves no state while handled', () => {
    const m = calibrated(0);
    const mid = (PRESENT_MIN + CLEAR_MAX) / 2;
    // motion 5: above STABLE_MOTION so neither adaptation nor recovery can
    // adopt — this isolates pure hysteresis behaviour.
    feed(m, 3000, mid, 5);
    expect(m.fires).toBe(0);
    expect(m.s.phase).toBe('waiting');
    // …and while locked, the same band HOLDS the lock.
    passOneGarment(m, { skipClear: true });
    expect(m.s.phase).toBe('locked');
    feed(m, 3000, m.bgLevel! + mid, 5);
    expect(m.s.phase).toBe('locked');
    expect(m.fires).toBe(1);
  });

  it('a single clear-looking frame does not release the lock', () => {
    const m = calibrated();
    passOneGarment(m, { skipClear: true });
    feed(m, FRAME_MS, 0, 20); // one deceptive near-background frame mid-motion
    feed(m, 500, 40, 5); // garment again, handled
    expect(m.s.phase).toBe('locked');
    expect(m.fires).toBe(1);
  });

  it('clearLane re-baselines: a box that empties shirt by shirt keeps working', () => {
    const m = calibrated(0);
    // Each clear leaves the lane slightly different (a shirt gone from the
    // visible box below): empty level walks 0 → 3 → 6 → …
    for (let step = 0; step < 5; step += 1) {
      passOneGarment(m, { garment: 40 + step * 3, empty: step * 3 });
    }
    expect(m.fires).toBe(5);
    expect(m.s.phase).toBe('waiting');
  });

  it('disarmed frames accrue nothing — a pause cannot bank a transition', () => {
    const m = calibrated();
    feed(m, CANDIDATE_MS * 4, 40, 2, false); // huge presence, but disarmed
    expect(m.s.phase).toBe('waiting');
    expect(m.fires).toBe(0);
    // Re-armed: the window starts FRESH (still needs CANDIDATE_MS).
    feed(m, CANDIDATE_MS - 66, 40, 2);
    expect(m.s.phase).toBe('waiting');
    feed(m, 132, 40, 2);
    expect(m.s.phase === 'present' || m.s.phase === 'locked').toBe(true);
  });

  it('resetGateState returns to a fresh calibration', () => {
    const m = calibrated();
    passOneGarment(m, { skipClear: true });
    resetGateState(m.s);
    expect(m.s.phase).toBe('calibrating');
    expect(m.s.lastFiredAt).toBe(0);
  });

  it('timestamp conversion: iOS seconds ×1000, Android ns ÷1e6', () => {
    expect(12_345.678 * frameTimestampToMsFactor('ios')).toBeCloseTo(12_345_678, 3);
    expect(1_750_000_000_000 * frameTimestampToMsFactor('android')).toBeCloseTo(1_750_000, 3);
  });

  it('the tuning constants are the documented starting points', () => {
    expect([
      PRESENT_MIN,
      CLEAR_MAX,
      CANDIDATE_MS,
      CLEAR_MS,
      CAL_STABLE_MS,
      STABLE_MOTION,
      SHARP_ENOUGH,
      FORCE_AFTER_MS,
      REFRACTORY_MS,
      LOCKED_REBASE_MS,
      CLEAR_RELAXED_MAX,
    ]).toEqual([18, 8, 150, 250, 600, 3, 6, 700, 350, 2500, 12]);
  });
});

describe('CHARACTERIZATION: the adoption cascade keeps count parity', () => {
  it('after a parked-garment adoption, a same-level stream still fires once per garment', () => {
    // The known residual (see the core header): garments fire at DEPARTURE,
    // photographing an empty lane, until the screen-level breaker
    // recalibrates. What the MACHINE must guarantee is parity — one fire per
    // traversal, never zero, never two.
    const m = calibrated(0);
    feed(m, CANDIDATE_MS + 66, 40, 12);
    feed(m, 66, 40, 2); // garment 1 counted
    feed(m, LOCKED_REBASE_MS + 500, 40, 0.5); // parked → adopted (bg=40)
    expect(m.s.phase).toBe('waiting');
    const before = m.fires;
    // Five same-level garments, paced, with visible gaps.
    for (let i = 0; i < 5; i += 1) {
      feed(m, 400, 40, 8); // garment in (reads ~0 vs adopted bg)
      feed(m, 400, 0, 8); // garment out (empty reads as presence)
      feed(m, 100, 0, 2); // brief lull on the empty lane → departure fire
    }
    const cascadeFires = m.fires - before;
    expect(cascadeFires).toBeGreaterThanOrEqual(4);
    expect(cascadeFires).toBeLessThanOrEqual(6); // parity, ±1 at the seams
  });
});
