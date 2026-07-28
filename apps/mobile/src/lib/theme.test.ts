import { describe, expect, it } from 'vitest';

import { TYPE_CEILING, capTo, resolveFontCap } from './theme';

/**
 * Dynamic Type policy primitives. These two functions decide how far every
 * piece of chrome in the app is allowed to grow, so they are the one part of
 * the Dynamic Type work that is pure enough to pin with unit tests (the rest
 * is component layout, verified by typecheck + the simulator pass).
 */
describe('capTo', () => {
  it('turns a point ceiling into the multiplier that lands exactly on it', () => {
    // The whole justification for a ceiling over a flat multiplier: a 34pt
    // title and an 11pt eyebrow need very different multipliers to end up in
    // the same physical space.
    expect(capTo(34, 48)).toBeCloseTo(1.4118, 4); // page-title convention
    expect(capTo(18, 48)).toBeCloseTo(2.6667, 4); // smallest Display call site
    expect(capTo(40, 48)).toBeCloseTo(1.2, 4); // largest Display call site
    expect(capTo(11, 16)).toBeCloseTo(1.4545, 4); // eyebrow
    expect(capTo(13, 22)).toBeCloseTo(1.6923, 4); // small button label
  });

  it('resolves each named ceiling against its real base size', () => {
    expect(capTo(11, TYPE_CEILING.eyebrow)).toBeCloseTo(16 / 11, 6);
    expect(capTo(13, TYPE_CEILING.control)).toBeCloseTo(22 / 13, 6);
    expect(capTo(15.5, TYPE_CEILING.control)).toBeCloseTo(22 / 15.5, 6);
    expect(capTo(16, TYPE_CEILING.input)).toBeCloseTo(24 / 16, 6);
    expect(capTo(10.5, TYPE_CEILING.chrome)).toBeCloseTo(20 / 10.5, 6);
    expect(capTo(34, TYPE_CEILING.display)).toBeCloseTo(48 / 34, 6);
  });

  it('never returns below 1 — a cap may limit growth, never shrink text', () => {
    // 56pt item-detail hero and the 48pt ceiling itself both already sit at or
    // past the ceiling; they must render at 1x, not at 0.86x.
    expect(capTo(56, TYPE_CEILING.display)).toBe(1);
    expect(capTo(48, TYPE_CEILING.display)).toBe(1);
    expect(capTo(100, TYPE_CEILING.chrome)).toBe(1);

    for (let size = 1; size <= 120; size += 0.5) {
      for (const ceiling of Object.values(TYPE_CEILING)) {
        expect(capTo(size, ceiling)).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('keeps every ceiling above the default body size so nothing shrinks by default', () => {
    for (const ceiling of Object.values(TYPE_CEILING)) {
      expect(ceiling).toBeGreaterThan(14.5);
    }
  });
});

/**
 * The `label` ceiling is the one entry in the table that exists for a purely
 * accessibility reason rather than a layout one, so its relationships to the
 * other ceilings are worth pinning: a later "tidy up, these two are the same
 * 11pt line" edit is exactly how the regression comes back.
 */
describe('TYPE_CEILING.label — form field labels', () => {
  it('is more generous than the section-header ceiling', () => {
    // Same 11pt tracked uppercase mono line, different job. A section eyebrow
    // is a landmark you read once; a field label is the only thing naming the
    // box being typed into.
    expect(TYPE_CEILING.label).toBeGreaterThan(TYPE_CEILING.eyebrow);
  });

  it('is never below the ceiling on the input it names', () => {
    // Otherwise the label is guaranteed to be the smaller of the pair at every
    // accessibility size — the defect this entry was added to fix.
    expect(TYPE_CEILING.label).toBeGreaterThanOrEqual(TYPE_CEILING.input);
  });

  it('lands an 11pt label on its ceiling, well past the eyebrow multiplier', () => {
    expect(capTo(11, TYPE_CEILING.label)).toBeCloseTo(28 / 11, 6);
    expect(capTo(11, TYPE_CEILING.label)).toBeGreaterThan(capTo(11, TYPE_CEILING.eyebrow));
  });

  it('keeps the longest real field label on one line of the form column', () => {
    // "PRIMARY LOCATION" is the longest label on Add Item; Eyebrow prefixes
    // "— ", so 18 JetBrains Mono characters at 0.6em advance plus 1.98pt of
    // tracking (letterSpacing is applied in UNSCALED points and does not grow
    // with fontScale). The form column is 402pt of screen less 20pt gutters.
    const width = (chars: number, size: number) => chars * (size * 0.6 + 11 * 0.18);
    expect(width(18, TYPE_CEILING.label)).toBeLessThanOrEqual(362);
    // And it is genuinely the largest ceiling that does: one point more and
    // the same label no longer fits.
    expect(width(18, TYPE_CEILING.label + 3)).toBeGreaterThan(362);
  });

  it('holds a field label above half the height of its uncapped 15pt input at AX5', () => {
    // Add-Item inputs are 15pt and stay uncapped by design (plan §3). At the
    // old eyebrow ceiling the label was 30% of its own input at AX5.
    const AX5 = 3.57;
    const inputPt = 15 * AX5;
    expect(TYPE_CEILING.eyebrow / inputPt).toBeLessThan(0.35); // the defect
    expect(TYPE_CEILING.label / inputPt).toBeGreaterThan(0.5); // the fix
  });
});

describe('resolveFontCap', () => {
  it('applies the policy default when a call site says nothing', () => {
    expect(resolveFontCap(undefined, 1.45)).toBe(1.45);
  });

  it('lets a call site tighten the cap', () => {
    expect(resolveFontCap(1.2, 1.45)).toBe(1.2);
  });

  it('lets a call site loosen the cap', () => {
    expect(resolveFontCap(3, 1.45)).toBe(3);
  });

  it('passes RN\'s 0 "no limit" sentinel through instead of re-applying the default', () => {
    // This is the whole reason the helper exists: `n || fallback` and
    // `Number(n) ? n : fallback` both silently swallow 0 and re-clamp the
    // text the call site just opted out of clamping.
    expect(resolveFontCap(0, 1.45)).toBe(0);
  });

  it("passes RN's null \"inherit from parent\" sentinel through as well", () => {
    // `explicit ?? policyDefault` would swallow this one.
    expect(resolveFontCap(null, 1.45)).toBeNull();
  });

  it('returns undefined for the uncapped primitives (Body, Mono)', () => {
    expect(resolveFontCap(undefined, undefined)).toBeUndefined();
    expect(resolveFontCap(0, undefined)).toBe(0);
    expect(resolveFontCap(2, undefined)).toBe(2);
  });
});
