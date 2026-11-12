import { describe, expect, it } from 'vitest';

import {
  byteCounts,
  cumulativeLayoutShift,
  frameSummary,
  glassCssBytes,
  interactionToNextPaint,
} from '../../tests/perf/appearance-metrics';

/**
 * Plan 8.4 / R12: the arithmetic appearance.perf.ts applies to what the
 * browser reports (CLS session windows, INP, the scroll's frames, the glass
 * CSS a Classic visitor downloads, transfer bytes by kind).
 */

describe('CLS (largest session window)', () => {
  it('sums shifts less than 1 s apart inside 5 s', () => {
    expect(
      cumulativeLayoutShift([
        { t: 0, v: 0.05 },
        { t: 500, v: 0.04 },
      ]),
    ).toBeCloseTo(0.09, 10);
  });
  it('a 1 s gap starts a new window: the largest one counts', () => {
    expect(
      cumulativeLayoutShift([
        { t: 0, v: 0.05 },
        { t: 2000, v: 0.02 },
        { t: 2500, v: 0.02 },
      ]),
    ).toBeCloseTo(0.05, 10);
  });
  it('FAILS the R12 budget on a large shift (above 0.1)', () => {
    expect(
      cumulativeLayoutShift([
        { t: 0, v: 0.08 },
        { t: 100, v: 0.05 },
      ]),
    ).toBeGreaterThan(0.1);
  });
});

describe('INP', () => {
  it("takes each interaction's longest event, then the worst interaction", () => {
    const events = [
      { id: 1, d: 40, name: 'pointerdown', t: 10 },
      { id: 1, d: 96, name: 'click', t: 12 },
      { id: 2, d: 230, name: 'keydown', t: 50 },
    ];
    expect(interactionToNextPaint(events)).toBe(230);
    expect(interactionToNextPaint(events, 20)).toBe(230);
    expect(interactionToNextPaint(events.slice(0, 2))).toBe(96);
  });
  it('is null with no interaction', () => {
    expect(interactionToNextPaint([])).toBeNull();
    expect(interactionToNextPaint([{ id: 1, d: 30, name: 'click', t: 5 }], 10)).toBeNull();
  });
});

describe('scroll frames', () => {
  it('counts frames over 50 and 100 ms, long animation frames in the window only', () => {
    const f = frameSummary(
      [16, 17, 60, 16],
      [
        { t: 5, d: 120, b: 70 },
        { t: 9999, d: 300, b: 250 },
      ],
      {
        start: 0,
        end: 5000,
      },
    );
    expect(f).toEqual({ maxFrameMs: 120, over50: 2, over100: 1, loafCount: 1 });
  });
  it('an even scroll has no long frame', () => {
    expect(frameSummary([16, 16, 17], [], { start: 0, end: 1 }).over50).toBe(0);
  });
});

describe('glass CSS bytes', () => {
  it('counts rules scoped to the glass design, nested at-rules included, once', () => {
    const glassRule = ":root[data-appearance='liquid-glass'] .a{color:red}";
    const css = `.classic{color:blue}@layer lg{@media screen{${glassRule}}}/* {data-glass} */`;
    expect(glassCssBytes(css)).toBe(Buffer.byteLength(glassRule));
  });
  it('counts a whole glass block once, not its nested rules again', () => {
    const block = '[data-appearance="liquid-glass"]{.x{color:red}.y{color:blue}}';
    expect(glassCssBytes(block)).toBe(Buffer.byteLength(block));
  });
  it('is 0 for Classic CSS (FAILING CASE for a glass rule leaking: any glass rule counts)', () => {
    expect(glassCssBytes('.a{content:"}"}.b{color:red}')).toBe(0);
    expect(glassCssBytes('[data-glass-only]{display:none}')).toBeGreaterThan(0);
  });
});

describe('transfer bytes by kind', () => {
  it('splits scripts, CSS, images and the scene photos', () => {
    const o = 'http://127.0.0.1:3400';
    const b = byteCounts(
      [
        {
          name: `${o}/_next/static/chunks/a.js`,
          initiatorType: 'script',
          transferSize: 100,
          encodedBodySize: 90,
        },
        {
          name: `${o}/_next/static/css/b.css`,
          initiatorType: 'link',
          transferSize: 50,
          encodedBodySize: 45,
        },
        {
          name: `${o}/liquid-glass/scene-day.jpg`,
          initiatorType: 'css',
          transferSize: 400,
          encodedBodySize: 400,
        },
        {
          name: `${o}/_next/image?url=x.png`,
          initiatorType: 'img',
          transferSize: 30,
          encodedBodySize: 30,
        },
        { name: 'not a url', initiatorType: 'other', transferSize: 1, encodedBodySize: 1 },
      ],
      o,
    );
    expect(b).toEqual({
      jsBytes: 100,
      cssBytes: 50,
      imgBytes: 430,
      sceneBytes: 400,
      sceneCount: 1,
      cssUrls: [`${o}/_next/static/css/b.css`],
    });
  });
});
