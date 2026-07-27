import { describe, expect, it } from 'vitest';

import {
  animDoneFor,
  dimsFor,
  frameAt,
  LI,
  brandRevealAt,
  schedule,
  seg,
  easeOut,
  easeInOut,
  clamp01,
} from './timeline';

const DESK = dimsFor(1200, 780);
const MOB = dimsFor(390, 720);
const LOCK_W = 340;

describe('easings', () => {
  it('clamps and normalises', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(seg(50, 0, 100)).toBe(0.5);
    expect(seg(-10, 0, 100)).toBe(0);
    expect(seg(999, 0, 100)).toBe(1);
  });

  it('eases from 0 to 1 without overshoot', () => {
    for (const f of [easeOut, easeInOut]) {
      expect(f(0)).toBeCloseTo(0, 5);
      expect(f(1)).toBeCloseTo(1, 5);
      expect(f(0.5)).toBeGreaterThan(0);
      expect(f(0.5)).toBeLessThan(1);
    }
  });
});

describe('exit schedule (ES) math', () => {
  // The three cases named in the design's definition of done.
  it('ready@300 exits at 900 — the animation is the binding constraint', () => {
    expect(schedule('first', 300).exitStart).toBe(900);
  });

  it('ready@1200 exits at 1200 — readiness is the binding constraint', () => {
    expect(schedule('first', 1200).exitStart).toBe(1200);
  });

  it('ready@2600 forces the exit at the 1500 cap and flags it', () => {
    const s = schedule('first', 2600);
    expect(s.exitStart).toBe(1500);
    expect(s.forced).toBe(true);
  });

  it('holds the 450ms floor so a fast page cannot flash the brand', () => {
    // Repeat lane finishes animating at 320, but the floor keeps it visible.
    expect(schedule('repeat', 0).exitStart).toBe(LI.MIN_VISIBLE);
  });

  it('does not flag forced when readiness lands exactly on the cap', () => {
    expect(schedule('first', LI.MAX_CAP).forced).toBe(false);
  });

  it('never returns an exit past the hard cap, whatever readiness says', () => {
    for (const ready of [0, 500, 1499, 1500, 5000, Number.POSITIVE_INFINITY]) {
      expect(schedule('first', ready).exitStart).toBeLessThanOrEqual(LI.MAX_CAP);
    }
  });

  it('reduced motion completes within the 550ms budget', () => {
    const s = schedule('reduced', 0);
    // Exempt from the 450 floor on purpose — see timeline.ts.
    expect(s.hiddenAt).toBeLessThanOrEqual(550);
  });

  it('uses the documented per-lane animation lengths', () => {
    expect(animDoneFor('first')).toBe(900);
    expect(animDoneFor('repeat')).toBe(320);
    expect(animDoneFor('reduced')).toBe(300);
  });
});

describe('first-visit frames', () => {
  const s = schedule('first', 300);
  const at = (t: number) => frameAt(t, 'first', s, DESK, LOCK_W, null);

  it('starts on ink with the lockup unrevealed', () => {
    const f = at(0);
    expect(f.lockOpacity).toBe(0);
    expect(f.beam).toBeNull();
    expect(f.gridOpacity).toBeCloseTo(0, 3);
  });

  it('brings the grid up by 200ms', () => {
    expect(at(200).gridOpacity).toBeCloseTo(0.9, 3);
  });

  it('sweeps the beam only between 120 and 650ms', () => {
    expect(at(100).beam).toBeNull();
    expect(at(400).beam).not.toBeNull();
    expect(at(700).beam).toBeNull();
  });

  it('moves the beam left to right', () => {
    const a = at(200)!.beam!.x;
    const b = at(500)!.beam!.x;
    expect(b).toBeGreaterThan(a);
  });

  it('fully reveals the lockup by 620ms and holds it', () => {
    expect(at(620).lockClip).toBe('inset(-20% 0% -20% -8%)');
    expect(at(800).lockOpacity).toBe(1);
  });

  it('pulses the pip between 640 and 900ms only', () => {
    expect(at(600).pulse).toBe(0);
    expect(at(770).pulse).toBeGreaterThan(0);
    expect(at(900).pulse).toBe(1);
  });

  it('is not hidden before its scheduled end', () => {
    expect(at(s.hiddenAt - 1).hidden).toBe(false);
    expect(at(s.hiddenAt).hidden).toBe(true);
  });
});

describe('holding for slow content', () => {
  it('breathes the pip while waiting and never moves anything else', () => {
    const s = schedule('first', 1400);
    const held = frameAt(1100, 'first', s, DESK, LOCK_W, null);
    expect(held.breathe).toBeLessThan(1);
    expect(held.breathe).toBeGreaterThan(0.69);
    // The lockup is still fully revealed and still — no fake progress.
    expect(held.lockOpacity).toBe(1);
    expect(held.flightP).toBe(0);
  });
});

describe('exit flight', () => {
  const s = schedule('first', 300);
  const flight = { tx: -400, ty: -260, s: 26 / 76 };

  it('does not move before ES', () => {
    expect(frameAt(s.exitStart - 1, 'first', s, DESK, LOCK_W, flight).flightP).toBe(0);
  });

  it('lands the flight after 420ms', () => {
    expect(frameAt(s.exitStart + LI.EXIT_FLIGHT, 'first', s, DESK, LOCK_W, flight).flightP).toBeCloseTo(1, 3);
  });

  it('fades the overlay out and drops the grid first', () => {
    const mid = frameAt(s.exitStart + 200, 'first', s, DESK, LOCK_W, flight);
    expect(mid.gridOpacity).toBeLessThan(0.9);
    const late = frameAt(s.exitStart + LI.EXIT_FADE, 'first', s, DESK, LOCK_W, flight);
    expect(late.rootOpacity).toBeCloseTo(0, 3);
  });

  it('crossfades the overlay lockup out around the handoff', () => {
    expect(frameAt(s.exitStart + 440, 'first', s, DESK, LOCK_W, flight).lockOpacity).toBeCloseTo(0, 3);
  });

  it('reveals the page brand as the mark lands, not before', () => {
    expect(brandRevealAt('first', s)).toBe(s.exitStart + 330);
    expect(brandRevealAt('reduced', s)).toBe(s.exitStart + 100);
  });
});

describe('reduced motion', () => {
  const s = schedule('reduced', 0);
  const flight = { tx: -400, ty: -260, s: 0.34 };

  it('never renders a beam', () => {
    for (const t of [0, 150, 300, 450]) {
      expect(frameAt(t, 'reduced', s, DESK, LOCK_W, flight).beam).toBeNull();
    }
  });

  it('never translates or scales, even with a flight vector available', () => {
    for (const t of [0, s.exitStart, s.exitStart + 120, s.hiddenAt - 1]) {
      expect(frameAt(t, 'reduced', s, DESK, LOCK_W, flight).flightP).toBe(0);
    }
  });

  it('never breathes', () => {
    expect(frameAt(s.exitStart - 1, 'reduced', s, DESK, LOCK_W, flight).breathe).toBe(1);
  });

  it('holds the grid static at half strength', () => {
    expect(frameAt(0, 'reduced', s, DESK, LOCK_W, flight).gridOpacity).toBe(0.5);
    expect(frameAt(200, 'reduced', s, DESK, LOCK_W, flight).gridOpacity).toBe(0.5);
  });

  it('fades in opacity only', () => {
    expect(frameAt(0, 'reduced', s, DESK, LOCK_W, flight).lockOpacity).toBe(0);
    expect(frameAt(300, 'reduced', s, DESK, LOCK_W, flight).lockOpacity).toBeCloseTo(1, 3);
  });
});

describe('repeat visit', () => {
  const s = schedule('repeat', 0);

  it('skips the beam and fades the finished lockup in over 320ms', () => {
    expect(frameAt(160, 'repeat', s, DESK, LOCK_W, null).beam).toBeNull();
    expect(frameAt(320, 'repeat', s, DESK, LOCK_W, null).lockOpacity).toBeCloseTo(1, 3);
  });

  it('still honours the 450ms floor before exiting', () => {
    expect(s.exitStart).toBe(450);
  });
});

describe('breakpoints', () => {
  it('uses the small lockup at and below 480px', () => {
    expect(MOB.markSize).toBe(56);
    expect(MOB.wordSize).toBe(34);
    expect(MOB.gap).toBe(14);
    expect(dimsFor(480, 800).markSize).toBe(56);
    expect(dimsFor(481, 800).markSize).toBe(76);
  });

  it('uses the full lockup on desktop', () => {
    expect(DESK.markSize).toBe(76);
    expect(DESK.wordSize).toBe(50);
    expect(DESK.gap).toBe(20);
  });

  it('scales the beam sweep to the viewport and caps it', () => {
    const s = schedule('first', 300);
    const wide = frameAt(400, 'first', s, dimsFor(2560, 1400), LOCK_W, null)!.beam!.x;
    const narrow = frameAt(400, 'first', s, MOB, LOCK_W, null)!.beam!.x;
    // Both sweep, but the wide one is capped at a 700px span rather than 0.56*2560.
    expect(wide).toBeGreaterThan(2560 / 2 - 700);
    expect(narrow).toBeGreaterThan(0);
    expect(narrow).toBeLessThan(390);
  });
});
