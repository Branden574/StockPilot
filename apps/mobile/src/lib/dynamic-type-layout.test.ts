import { describe, expect, it } from 'vitest';

import {
  FOOTER_CLEARANCE,
  ROW_STACK_FONT_SCALE,
  footerReservation,
  shouldStackRow,
} from './dynamic-type-layout';

describe('shouldStackRow', () => {
  it('keeps a multi-column row side-by-side at default text size', () => {
    expect(shouldStackRow(1)).toBe(false);
  });

  it('keeps it side-by-side through the non-accessibility sizes', () => {
    // iOS Larger Text tops out at 1.35x before the AX sizes begin.
    for (const scale of [0.882, 0.941, 1, 1.118, 1.235, 1.35]) {
      expect(shouldStackRow(scale)).toBe(false);
    }
  });

  it('stacks once past the threshold', () => {
    expect(shouldStackRow(ROW_STACK_FONT_SCALE + 0.01)).toBe(true);
    // The iOS accessibility ramp: AX1 1.643 … AX5 3.571.
    for (const scale of [1.643, 1.929, 2.286, 2.643, 3.571]) {
      expect(shouldStackRow(scale)).toBe(true);
    }
  });

  it('treats the threshold itself as "still fits" (strictly greater, per plan)', () => {
    expect(shouldStackRow(ROW_STACK_FONT_SCALE)).toBe(false);
  });

  it('sits between the last non-accessibility size and AX1, so ONE threshold serves every screen', () => {
    // Follow-ups 1-2 (viewfinder chrome, and long item names breaking per
    // character) both reuse this single threshold rather than adding a second
    // breakpoint. That only holds while it stays in the gap: raise it past
    // 1.643 and the Items/Books rows silently stop stacking at AX1-AX2, which
    // is exactly where `Sunglasse/s` was reported.
    expect(ROW_STACK_FONT_SCALE).toBeGreaterThan(1.35);
    expect(ROW_STACK_FONT_SCALE).toBeLessThan(1.643);
  });

  it('stacks at both reported repro sizes', () => {
    // AX3 — the Items/Books row where `Sunglasses` broke mid-word.
    expect(shouldStackRow(2.286)).toBe(true);
    // AX5 — the size-count viewfinder chrome that overlapped its hint copy.
    expect(shouldStackRow(3.571)).toBe(true);
  });

  it('honours a caller-supplied threshold', () => {
    expect(shouldStackRow(1.2, 1.1)).toBe(true);
    expect(shouldStackRow(1.2, 1.3)).toBe(false);
  });

  it('falls back to "does not stack" for a missing or nonsense scale', () => {
    // useWindowDimensions().fontScale is always a number on device, but a
    // stacked layout appearing because of a NaN would be a silent regression
    // for every default-size user, so the degenerate cases pin to false.
    expect(shouldStackRow(undefined)).toBe(false);
    expect(shouldStackRow(null)).toBe(false);
    expect(shouldStackRow(Number.NaN)).toBe(false);
    expect(shouldStackRow(0)).toBe(false);
    expect(shouldStackRow(-1)).toBe(false);
    expect(shouldStackRow(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('footerReservation', () => {
  it('uses the hand-tuned fallback until the footer has been measured', () => {
    expect(footerReservation(null, 140)).toBe(140);
    expect(footerReservation(0, 140)).toBe(140);
  });

  it('never reserves less than the fallback', () => {
    // A measured 95pt footer + clearance is still under the old constant; the
    // constant was correct at default size, so it stays the floor and this
    // change can only ever ADD room, never take it away.
    expect(footerReservation(95, 140)).toBe(140);
  });

  it('grows past the fallback once the footer outgrows it', () => {
    expect(footerReservation(160, 140)).toBe(160 + FOOTER_CLEARANCE);
    // The reported AX5 case: a 3-line "Sync pending edits to post" footer.
    expect(footerReservation(170, 140)).toBeGreaterThan(170);
  });

  it('clears the footer by the full clearance at every measured height', () => {
    for (let h = 1; h <= 400; h += 1) {
      expect(footerReservation(h, 140)).toBeGreaterThanOrEqual(h + FOOTER_CLEARANCE);
    }
  });

  it('ignores a nonsense measurement rather than reserving NaN', () => {
    expect(footerReservation(Number.NaN, 140)).toBe(140);
    expect(footerReservation(Number.POSITIVE_INFINITY, 140)).toBe(140);
    expect(footerReservation(-20, 140)).toBe(140);
  });

  it('honours a caller-supplied clearance', () => {
    expect(footerReservation(200, 140, 0)).toBe(200);
    expect(footerReservation(200, 140, 50)).toBe(250);
  });
});
