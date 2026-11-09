import { describe, expect, it } from 'vitest';

import {
  composite,
  contrastRatio,
  deltaE00,
  deltaE00Rgb,
  extremeCrops,
  isLargeText,
  parseCssColor,
  relativeLuminance,
  requiredTextRatio,
  ringProblems,
  worstContrast,
  type ComputedRing,
} from '../../tests/e2e/appearance/a11y-math';

/**
 * The arithmetic of the stage 5 accessibility and fidelity specs
 * (IMPLEMENTATION-PLAN.md 8.1-2, 8.3; R11): WCAG contrast, colour parsing and
 * compositing, CIEDE2000 and the glass focus ring rule. Each rule has a case
 * where it must FAIL, so a broken rule cannot pass silently.
 */

describe('WCAG contrast', () => {
  it('black on white is 21:1 and a colour on itself is 1:1', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([12, 34, 56], [12, 34, 56])).toBeCloseTo(1, 5);
  });
  it('#767676 on white passes 4.5:1 and #777777 just fails (the known boundary)', () => {
    expect(contrastRatio([0x76, 0x76, 0x76], [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio([0x77, 0x77, 0x77], [255, 255, 255])).toBeLessThan(4.5);
  });
  it('luminance is 0 for black and 1 for white', () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 10);
  });
  it('large text is 24 px, or 18.66 px bold', () => {
    expect(isLargeText(24, 400)).toBe(true);
    expect(isLargeText(19, 700)).toBe(true);
    expect(isLargeText(19, 600)).toBe(false);
    expect(requiredTextRatio(14, 400)).toBe(4.5);
    expect(requiredTextRatio(28, 400)).toBe(3);
  });
});

describe('colour parsing and compositing', () => {
  it('reads rgb(), rgba(), the space syntax, color(srgb) and hex', () => {
    expect(parseCssColor('rgb(11, 122, 92)')).toEqual({ r: 11, g: 122, b: 92, a: 1 });
    expect(parseCssColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseCssColor('rgb(255 255 255 / 50%)')).toEqual({ r: 255, g: 255, b: 255, a: 0.5 });
    expect(parseCssColor('color(srgb 1 0 0 / 0.25)')).toEqual({ r: 255, g: 0, b: 0, a: 0.25 });
    expect(parseCssColor('#0B7A5C')).toEqual({ r: 11, g: 122, b: 92, a: 1 });
    expect(parseCssColor('#fff8')!.a).toBeCloseTo(0x88 / 255, 5);
  });
  it('returns null for what is not a colour', () => {
    expect(parseCssColor('none')).toBeNull();
    expect(parseCssColor('linear-gradient(red, blue)')).toBeNull();
    expect(parseCssColor('#12345')).toBeNull();
  });
  it('composites a translucent colour over what is under it', () => {
    expect(composite({ r: 0, g: 0, b: 0, a: 0.5 }, [255, 255, 255])).toEqual([127.5, 127.5, 127.5]);
    expect(composite({ r: 10, g: 20, b: 30, a: 1 }, [255, 255, 255])).toEqual([10, 20, 30]);
  });
  it('the worst ratio is over the worst pixel, and a translucent text is composited first', () => {
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const ratio = worstContrast(white, [
      [0, 0, 0],
      [200, 200, 200],
    ]);
    expect(ratio).toBeCloseTo(contrastRatio([255, 255, 255], [200, 200, 200]), 5);
    // FAILING CASE: white text over a light scene pixel is far below 4.5.
    expect(ratio!).toBeLessThan(4.5);
    expect(worstContrast(white, [])).toBeNull();
    // Half-transparent black text on white reads as mid grey: about 3.9:1, a body-text miss.
    expect(worstContrast({ r: 0, g: 0, b: 0, a: 0.5 }, [[255, 255, 255]])!).toBeLessThan(4.5);
  });
  it('R11 crops take the darkest and the lightest tenth', () => {
    const px = Array.from({ length: 20 }, (_, i) => [i * 10, i * 10, i * 10] as const);
    const { dark, light } = extremeCrops(px);
    expect(dark).toEqual([
      [0, 0, 0],
      [10, 10, 10],
    ]);
    expect(light).toEqual([
      [180, 180, 180],
      [190, 190, 190],
    ]);
  });
});

describe('CIEDE2000', () => {
  it('matches the published Sharma test pairs', () => {
    expect(deltaE00([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
    expect(deltaE00([50, -1.3802, -84.2814], [50, 0, -82.7485])).toBeCloseTo(1.0, 3);
    expect(deltaE00([50, 2.5, 0], [56, -27, -3])).toBeCloseTo(31.903, 2);
    expect(deltaE00([60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387])).toBeCloseTo(
      1.2644,
      3,
    );
  });
  it('is 0 for the same colour and above 1 for a visible change', () => {
    expect(deltaE00Rgb([11, 122, 92], [11, 122, 92])).toBe(0);
    expect(deltaE00Rgb([11, 122, 92], [11, 140, 92])).toBeGreaterThan(1);
  });
});

describe('the glass focus ring', () => {
  const ring = (over: Partial<ComputedRing> = {}): ComputedRing => ({
    outlineStyle: 'solid',
    outlineColor: 'rgb(11, 122, 92)',
    outlineWidth: '2px',
    outlineOffset: '2px',
    boxShadow: 'none',
    ...over,
  });
  it('accepts the Day ring, the Night ring and the contrast rings', () => {
    expect(ringProblems(ring(), 'day', 'outline')).toEqual([]);
    expect(ringProblems(ring({ outlineColor: 'rgb(86, 214, 169)' }), 'night', 'outline')).toEqual(
      [],
    );
    expect(
      ringProblems(
        ring({ outlineColor: 'rgb(16, 20, 18)', outlineWidth: '3px' }),
        'contrast-day',
        'outline',
      ),
    ).toEqual([]);
    expect(
      ringProblems(
        ring({ outlineColor: 'rgb(255, 255, 255)', outlineWidth: '3px' }),
        'contrast-night',
        'outline',
      ),
    ).toEqual([]);
  });
  it('a segment draws its ring inside its edge', () => {
    expect(ringProblems(ring({ outlineOffset: '-2px' }), 'day', 'inset')).toEqual([]);
    expect(ringProblems(ring(), 'day', 'inset')).toHaveLength(1);
  });
  it('FAILS a missing outline, the wrong colour, width or offset', () => {
    expect(ringProblems(ring({ outlineStyle: 'none' }), 'day', 'outline')).toHaveLength(1);
    expect(ringProblems(ring(), 'night', 'outline')[0]).toMatch(/outline colour/u);
    expect(ringProblems(ring({ outlineWidth: '2px' }), 'contrast-day', 'outline').join()).toMatch(
      /width/u,
    );
    expect(ringProblems(ring({ outlineOffset: '0px' }), 'day', 'outline').join()).toMatch(
      /offset/u,
    );
  });
  it('a field shows the 3 px halo, and fails without it', () => {
    expect(
      ringProblems(ring({ boxShadow: 'rgba(11, 122, 92, 0.24) 0px 0px 0px 3px' }), 'day', 'halo'),
    ).toEqual([]);
    expect(ringProblems(ring({ boxShadow: 'none' }), 'day', 'halo')).toHaveLength(1);
  });
});
