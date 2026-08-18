import { describe, expect, it } from 'vitest';

import { LANDING_CSS } from './styles';
import { CHAPTER_RANGE, frameUrl, HI, keyframeFor, LO, pickTier, type Conditions } from './film';
import { STAGES } from './fixture';

const base: Conditions = {
  smallViewport: false,
  coarsePointer: false,
  saveData: false,
  slowConnection: false,
  reducedMotion: false,
};

describe('film tiering — nobody gets a 70MB film they did not ask for', () => {
  it('serves the full sequence to a desktop on a normal connection', () => {
    expect(pickTier(base)).toBe('hi');
  });

  it('serves the light sequence to small viewports and touch devices', () => {
    expect(pickTier({ ...base, smallViewport: true })).toBe('lo');
    expect(pickTier({ ...base, coarsePointer: true })).toBe('lo');
  });

  it('serves the poster only when the user asked to spend less data', () => {
    // Save-Data is an explicit request. A cinematic scrub is exactly the kind of
    // thing it is asking us not to do.
    expect(pickTier({ ...base, saveData: true })).toBe('poster');
    expect(pickTier({ ...base, slowConnection: true })).toBe('poster');
  });

  it('serves the poster for reduced motion, on any device', () => {
    expect(pickTier({ ...base, reducedMotion: true })).toBe('poster');
    expect(pickTier({ ...base, reducedMotion: true, smallViewport: true })).toBe('poster');
  });

  it('lets Save-Data win over a fast desktop', () => {
    expect(pickTier({ ...base, saveData: true, smallViewport: false })).toBe('poster');
  });
});

describe('chapter → film mapping', () => {
  it('covers the whole film with no gap and no overlap', () => {
    const ordered = Object.values(CHAPTER_RANGE).sort((a, b) => a[0] - b[0]);
    expect(ordered[0]?.[0]).toBe(0);
    expect(ordered[ordered.length - 1]?.[1]).toBe(1);
    for (let i = 1; i < ordered.length; i++) {
      // Each range must start exactly where the previous one ended. A gap means
      // a stretch of footage nothing narrates; an overlap means two chapters
      // fighting over the same shot.
      expect(ordered[i]?.[0]).toBeCloseTo(ordered[i - 1]?.[1] as number, 6);
    }
  });

  it('every range moves forward', () => {
    for (const [key, [from, to]] of Object.entries(CHAPTER_RANGE)) {
      expect(to, `${key} must advance`).toBeGreaterThan(from);
    }
  });

  it('every story stage has a film range, and vice versa', () => {
    // THIS IS THE ONE THAT MATTERS. If a stage key has no matching film range,
    // that chapter's copy plays over whatever footage happens to be there — the
    // exact "foreground says Purchase Orders, background shows a forklift"
    // failure the design forbids.
    const stageKeys = STAGES.map((s) => s.key).sort();
    const filmKeys = Object.keys(CHAPTER_RANGE)
      .filter((k) => k !== 'hero')
      .sort();
    expect(filmKeys).toEqual(stageKeys);
  });

  it('gives the hero its own establishing range before the story starts', () => {
    expect(CHAPTER_RANGE.hero?.[0]).toBe(0);
    const firstStage = STAGES[0];
    expect(firstStage).toBeDefined();
    expect(CHAPTER_RANGE[firstStage!.key]?.[0]).toBe(CHAPTER_RANGE.hero?.[1]);
  });

  it('spends the most film on receiving, which carries the over-receipt beat', () => {
    const span = ([a, b]: [number, number]) => b - a;
    const receive = span(CHAPTER_RANGE.receive as [number, number]);
    for (const [key, range] of Object.entries(CHAPTER_RANGE)) {
      if (key === 'receive') continue;
      expect(receive).toBeGreaterThanOrEqual(span(range));
    }
  });
});

describe('reduced-motion keyframes', () => {
  it('lands inside the frame set for every chapter, in both tiers', () => {
    for (const set of [HI, LO]) {
      for (const key of Object.keys(CHAPTER_RANGE)) {
        const f = keyframeFor(key, set.count);
        expect(f).toBeGreaterThanOrEqual(1);
        expect(f).toBeLessThanOrEqual(set.count);
        expect(Number.isInteger(f)).toBe(true);
      }
    }
  });

  it('orders keyframes the same way the chapters are ordered', () => {
    const keys = Object.entries(CHAPTER_RANGE)
      .sort((a, b) => a[1][0] - b[1][0])
      .map(([k]) => k);
    const frames = keys.map((k) => keyframeFor(k, HI.count));
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]).toBeGreaterThan(frames[i - 1] as number);
    }
  });

  it('falls back to the first frame for an unknown chapter rather than throwing', () => {
    expect(keyframeFor('does-not-exist', HI.count)).toBe(1);
  });
});


describe('segment resolution — the cut is data, not filesystem layout', () => {
  it('counts match the sum of the segments', () => {
    for (const set of [HI, LO]) {
      expect(set.count).toBe(set.segments.reduce((n, s) => n + s.count, 0));
    }
    expect(HI.count).toBe(786);
    expect(LO.count).toBe(529);
  });

  it('maps each HI segment boundary to the right file', () => {
    // The cut: new inbound (1-120), original (121-540), new placement
    // (541-660), original tail (661-786). Indices below are 0-based.
    expect(frameUrl(HI, 0)).toBe('/landing/film-a-hi/f_0001.jpg');
    expect(frameUrl(HI, 119)).toBe('/landing/film-a-hi/f_0120.jpg');
    expect(frameUrl(HI, 120)).toBe('/landing/frames-hi/f_0001.jpg');
    expect(frameUrl(HI, 539)).toBe('/landing/frames-hi/f_0420.jpg');
    expect(frameUrl(HI, 540)).toBe('/landing/film-c-hi/f_0001.jpg');
    expect(frameUrl(HI, 659)).toBe('/landing/film-c-hi/f_0120.jpg');
    expect(frameUrl(HI, 660)).toBe('/landing/frames-hi/f_0421.jpg');
    expect(frameUrl(HI, 785)).toBe('/landing/frames-hi/f_0546.jpg');
  });

  it('maps each LO segment boundary to the right file', () => {
    expect(frameUrl(LO, 0)).toBe('/landing/film-a-lo/f_0001.jpg');
    expect(frameUrl(LO, 82)).toBe('/landing/frames-lo/f_0001.jpg');
    expect(frameUrl(LO, 363)).toBe('/landing/film-c-lo/f_0001.jpg');
    expect(frameUrl(LO, 444)).toBe('/landing/frames-lo/f_0282.jpg');
    expect(frameUrl(LO, 528)).toBe('/landing/frames-lo/f_0366.jpg');
  });

  it('never emits an absolute filesystem path', () => {
    // REGRESSION GUARD. The first cut materialised one directory of symlinks
    // whose targets were absolute paths under a developer's home directory.
    // Committed, every one of them would have resolved to nothing on deploy.
    for (const set of [HI, LO]) {
      for (let i = 0; i < set.count; i++) {
        const u = frameUrl(set, i);
        expect(u.startsWith('/landing/')).toBe(true);
        expect(u).not.toContain('/Users/');
      }
    }
  });

  it('is total over the whole range — no index yields a broken url', () => {
    for (const set of [HI, LO]) {
      for (let i = 0; i < set.count; i++) {
        expect(frameUrl(set, i)).toMatch(/^\/landing\/[a-z-]+\/f_\d{4}\.jpg$/);
      }
    }
  });
});


describe('landing stylesheet — guards that keep costing real time', () => {
  it('contains no backtick or interpolation that would break the template literal', () => {
    // This has broken the build three times: a backtick inside a CSS comment
    // silently terminates the template literal and the failure surfaces as an
    // unrelated TypeScript parse error hundreds of lines away.
    expect(LANDING_CSS).not.toContain('`');
    expect(LANDING_CSS).not.toContain('${');
  });

  it('keeps the hero ground byte-identical to the loading intro ink', () => {
    // #sp-stage must equal LI.ink (#0b0c0a) or the branded intro's reveal shows
    // a seam. The intro paints that exact value in its pre-hydration curtain.
    expect(LANDING_CSS).toContain('#sp-stage{position:fixed;inset:0;z-index:0;background:#0b0c0a');
  });

  it('keeps the nav glyph at the size the intro flight hard-codes', () => {
    // LI.NAV_MARK_PX = 26. The flight scale is 26 / markSize; resizing this
    // lands the flown mark at the wrong size and no test would catch it.
    expect(LANDING_CSS).toContain('#sp-landing .glyph{width:26px;height:26px');
  });

  it('does not reintroduce per-frame compositing over the film', () => {
    // Measured: a CSS filter on the full-screen canvas, a mix-blend-mode layer
    // above it, and backdrop-filter panels sampling it took scrolling to 10fps
    // with every single frame janked. These are the three that must not return.
    //
    // Comments are stripped first — the rules explaining WHY these were removed
    // naturally mention them by name, and matching prose made this fail on its
    // own documentation.
    const css = LANDING_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css, 'no declared mix-blend-mode').not.toMatch(/mix-blend-mode\s*:/);
    expect(css, 'no declared backdrop-filter').not.toMatch(/backdrop-filter\s*:/);
    // A filter on the full-screen film or poster layer specifically.
    expect(css, 'no filter on the film layers').not.toMatch(
      /#sp-(film|poster)[^{}]*\{[^}]*[^-]filter\s*:/,
    );
  });
});
