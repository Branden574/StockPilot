import { describe, expect, it } from 'vitest';

import {
  filePixels,
  neededIntrinsicWidth,
  pickSizesLength,
  srcsetDensity,
  visibleBox,
  type Box,
} from './photo-geometry';

const VIEWPORT: Box = { left: 0, top: 0, right: 1440, bottom: 900 };
const box = (left: number, top: number, width: number, height: number): Box => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

describe('visibleBox', () => {
  // The storefront on 2026-09-21, 1440x900: six cards in one strip. The strip
  // ends at x=1055; cards five and six sit at x=1069 and x=1267, INSIDE the
  // viewport's box and entirely outside the strip.
  const STRIP = { box: box(277, 440, 778, 260), x: true, y: true };

  it('keeps a card inside its strip', () => {
    expect(visibleBox(box(871, 479, 184, 111), VIEWPORT, [STRIP])).toEqual({
      left: 871,
      top: 479,
      right: 1055,
      bottom: 590,
    });
  });

  it('drops a card the strip clips away although it is inside the viewport', () => {
    expect(visibleBox(box(1069, 479, 184, 111), VIEWPORT, [STRIP])).toBeNull();
    expect(visibleBox(box(1267, 479, 184, 111), VIEWPORT, [STRIP])).toBeNull();
    // The same two cards against the viewport ALONE are "visible": the old rule.
    expect(visibleBox(box(1069, 479, 184, 111), VIEWPORT, [])).not.toBeNull();
  });

  it('counts a sliver: that is when a browser starts a lazy load', () => {
    expect(visibleBox(box(1054, 479, 184, 111), VIEWPORT, [STRIP])).toEqual({
      left: 1054,
      top: 479,
      right: 1055,
      bottom: 590,
    });
    // Touching edges share no pixel.
    expect(visibleBox(box(1055, 479, 184, 111), VIEWPORT, [STRIP])).toBeNull();
  });

  it('clips only on the axes the ancestor clips', () => {
    const sideways = { box: box(277, 440, 778, 50), x: true, y: false };
    // Below the ancestor's box, but it does not clip vertically.
    expect(visibleBox(box(300, 600, 100, 100), VIEWPORT, [sideways])).not.toBeNull();
    expect(visibleBox(box(300, 600, 100, 100), VIEWPORT, [{ ...sideways, y: true }])).toBeNull();
  });

  it('still applies the viewport when an ancestor clips too (a strip below the fold)', () => {
    const below = { box: box(277, 1150, 778, 260), x: true, y: true };
    expect(visibleBox(box(300, 1200, 184, 111), VIEWPORT, [below])).toBeNull();
    const straddling = { box: box(277, 800, 778, 260), x: true, y: true };
    // The viewport's edge cuts, not the strip's.
    expect(visibleBox(box(300, 850, 184, 111), VIEWPORT, [straddling])).toEqual({
      left: 300,
      top: 850,
      right: 484,
      bottom: 900,
    });
    // And the strip's edge cuts where the viewport would not.
    const narrow = { box: box(277, 440, 100, 260), x: true, y: true };
    expect(visibleBox(box(300, 479, 184, 111), VIEWPORT, [narrow])).toEqual({
      left: 300,
      top: 479,
      right: 377,
      bottom: 590,
    });
  });

  it('applies every ancestor, and the viewport', () => {
    const outer = { box: box(0, 0, 500, 900), x: true, y: true };
    expect(visibleBox(box(600, 479, 100, 100), VIEWPORT, [STRIP, outer])).toBeNull();
    expect(visibleBox(box(1500, 100, 100, 100), VIEWPORT, [])).toBeNull();
    expect(visibleBox(box(100, 950, 100, 100), VIEWPORT, [])).toBeNull();
    expect(visibleBox(box(-50, -50, 100, 100), VIEWPORT, [])).toEqual(box(0, 0, 50, 50));
  });
});

describe('pickSizesLength', () => {
  const at = (width: number) => (condition: string) => {
    const max = /max-width:\s*(\d+)px/.exec(condition);
    const min = /min-width:\s*(\d+)px/.exec(condition);
    if (max) return width <= Number(max[1]);
    if (min) return width >= Number(min[1]);
    throw new Error(`unexpected condition ${condition}`);
  };

  it('reads the strings the app really uses', () => {
    const storefront = '(max-width: 560px) 45vw, 220px';
    expect(pickSizesLength(storefront, at(1440))).toBe('220px');
    expect(pickSizesLength(storefront, at(390))).toBe('45vw');
    expect(pickSizesLength('28px', at(1440))).toBe('28px');
    const uploader = '(max-width: 640px) 33vw, (max-width: 1024px) 25vw, 200px';
    expect(pickSizesLength(uploader, at(800))).toBe('25vw');
    expect(pickSizesLength(uploader, at(1440))).toBe('200px');
  });

  it('keeps a calc() whole, commas and spaces inside it included', () => {
    expect(pickSizesLength('(min-width: 800px) calc(50vw - 16px), 100vw', at(1440))).toBe(
      'calc(50vw - 16px)',
    );
    expect(pickSizesLength('min(600px, 100vw)', at(1440))).toBe('min(600px, 100vw)');
  });

  it('skips an auto entry (the caller handles auto itself) and uses what follows', () => {
    expect(pickSizesLength('auto, 300px', at(1440))).toBe('300px');
    expect(pickSizesLength('auto, (max-width: 560px) 45vw, 220px', at(390))).toBe('45vw');
  });

  it('says null when there is nothing to use', () => {
    expect(pickSizesLength('', at(1440))).toBeNull();
    expect(pickSizesLength('auto', at(1440))).toBeNull();
    expect(pickSizesLength('(max-width: 560px) 45vw', at(1440))).toBeNull();
  });
});

describe('srcsetDensity', () => {
  const resolve = (u: string) => new URL(u, 'https://app.test/').href;
  const SRCSET =
    '/_next/image?url=x&w=256&q=75 256w, /_next/image?url=x&w=384&q=75 384w, /_next/image?url=x&w=640&q=75 640w';

  it('is the w descriptor over the source size: a 640 px file in a 220 px slot', () => {
    const density = srcsetDensity(
      SRCSET,
      'https://app.test/_next/image?url=x&w=640&q=75',
      220,
      resolve,
    );
    expect(density).toBeCloseTo(640 / 220, 10);
    // What the harness does with it: naturalWidth 220 is a 640 px file.
    expect(Math.round(220 * (density as number))).toBe(640);
  });

  it('reads x descriptors, and a bare URL as 1x', () => {
    expect(srcsetDensity('a.jpg 1x, b.jpg 2x', 'https://app.test/b.jpg', null, resolve)).toBe(2);
    expect(srcsetDensity('a.jpg, b.jpg 2x', 'https://app.test/a.jpg', null, resolve)).toBe(1);
  });

  it('says null rather than guess', () => {
    const shown = 'https://app.test/_next/image?url=x&w=640&q=75';
    expect(srcsetDensity(SRCSET, 'https://app.test/other.jpg', 220, resolve)).toBeNull();
    expect(srcsetDensity(SRCSET, shown, null, resolve)).toBeNull();
    expect(srcsetDensity(SRCSET, shown, 0, resolve)).toBeNull();
    expect(srcsetDensity('', shown, 220, resolve)).toBeNull();
  });

  it('matches the WHOLE url, never a tail of it', () => {
    expect(srcsetDensity('b.jpg 1x, ab.jpg 2x', 'https://app.test/ab.jpg', null, resolve)).toBe(2);
    expect(
      srcsetDensity(
        'https://cdn.test/a.jpg 1x, /proxy?u=https://cdn.test/a.jpg 2x',
        'https://app.test/proxy?u=https://cdn.test/a.jpg',
        null,
        resolve,
      ),
    ).toBe(2);
  });

  it('reads a decimal descriptor', () => {
    expect(srcsetDensity('a.jpg 1.5x', 'https://app.test/a.jpg', null, resolve)).toBe(1.5);
  });

  it('skips a candidate whose URL cannot be resolved, and keeps looking', () => {
    const picky = (u: string) => {
      if (u === 'bad') throw new TypeError('Invalid URL');
      return resolve(u);
    };
    expect(srcsetDensity('bad 1x, good.jpg 2x', 'https://app.test/good.jpg', null, picky)).toBe(2);
  });

  it('does not split a URL at a comma that is part of it', () => {
    expect(
      srcsetDensity('/i/a,b.jpg 320w, /i/c.jpg 640w', 'https://app.test/i/a,b.jpg', 160, resolve),
    ).toBe(2);
  });
});

describe('filePixels', () => {
  // Every case below was MEASURED in Chromium 153 and WebKit 26.6 with files of
  // known width: both engines round the density-corrected size DOWN.
  it('is the width that was asked for when the rounded-down natural size allows it', () => {
    // 64 px file, sizes="28px", DPR 2: naturalWidth 27, not 28.
    expect(filePixels(27, 64 / 28, 64)).toBe(64);
    // 750 px file, sizes="220px", DPR 3: naturalWidth 219.
    expect(filePixels(219, 750 / 220, 750)).toBe(750);
    // 640 px file at 45vw of a 501 px viewport: naturalWidth 225.
    expect(filePixels(225, 640 / (0.45 * 501), 640)).toBe(640);
    // The storefront: exact.
    expect(filePixels(220, 640 / 220, 640)).toBe(640);
  });

  it('takes the middle of the possible range for a file the optimizer did not enlarge', () => {
    // A 500 x 667 master asked for at w=640 in a 220 px slot says 171 x 229.
    expect(filePixels(171, 640 / 220, 640)).toBe(499); // true 500
    expect(filePixels(229, 640 / 220, null)).toBe(668); // true 667
    // Never further off than half a density unit.
    expect(Math.abs(499 - 500)).toBeLessThanOrEqual(640 / 220 / 2);
    expect(Math.abs(668 - 667)).toBeLessThanOrEqual(640 / 220 / 2);
  });

  it('is exact without a density, and UNKNOWN (never "x 1") when the density cannot be rebuilt', () => {
    expect(filePixels(200, 1, null)).toBe(200);
    expect(filePixels(220, null, 640)).toBeNull();
    expect(filePixels(220, 0, 640)).toBeNull();
    expect(filePixels(220, Number.NaN, 640)).toBeNull();
  });

  it('does not snap to an asked width the natural size rules out', () => {
    // naturalWidth 100 at density 2 means a file of 200 or 201 px: not 640.
    expect(filePixels(100, 2, 640)).toBe(201);
    expect(filePixels(100, 2, 200)).toBe(200);
    expect(filePixels(100, 2, 202)).toBe(202);
    expect(filePixels(100, 2, 203)).toBe(201);
  });
});

describe('neededIntrinsicWidth', () => {
  it('cover: the tighter axis decides', () => {
    // A portrait cover (3:4) in the storefront's 184x111 box at DPR 2 is scaled
    // to the box WIDTH: 184 CSS px wide, so 368 file px.
    expect(
      neededIntrinsicWidth({ width: 184, height: 111 }, { width: 640, height: 852 }, 2, 'cover'),
    ).toBe(368);
    // A wide panorama in the same box is scaled to the box HEIGHT.
    expect(
      neededIntrinsicWidth({ width: 184, height: 111 }, { width: 3000, height: 1000 }, 2, 'cover'),
    ).toBe(666);
  });

  it('contain: the looser axis decides', () => {
    expect(
      neededIntrinsicWidth({ width: 184, height: 111 }, { width: 640, height: 852 }, 2, 'contain'),
    ).toBeCloseTo(((111 * 640) / 852) * 2, 6);
    expect(
      neededIntrinsicWidth({ width: 28, height: 28 }, { width: 200, height: 150 }, 3, 'contain'),
    ).toBe(84);
  });

  it('treats the default (fill) like cover, and a photo of unknown shape by its box', () => {
    expect(
      neededIntrinsicWidth({ width: 100, height: 50 }, { width: 400, height: 400 }, 2, undefined),
    ).toBe(200);
    expect(
      neededIntrinsicWidth({ width: 100, height: 50 }, { width: 0, height: 0 }, 2, 'cover'),
    ).toBe(200);
  });
});

describe('injection safety', () => {
  // The harness ships these into the page as source text. A function that leans
  // on anything outside its own body works here and breaks there.
  it('every injected function still works when rebuilt from its own source', () => {
    const rebuild = <T>(fn: T): T => new Function(`return (${String(fn)})`)() as T;
    expect(
      rebuild(visibleBox)(box(1069, 479, 184, 111), VIEWPORT, [
        { box: box(277, 440, 778, 260), x: true, y: true },
      ]),
    ).toBeNull();
    expect(rebuild(pickSizesLength)('(max-width: 560px) 45vw, 220px', () => false)).toBe('220px');
    expect(
      rebuild(srcsetDensity)(
        'a.jpg 320w',
        'https://app.test/a.jpg',
        160,
        (u) => new URL(u, 'https://app.test/').href,
      ),
    ).toBe(2);
    expect(rebuild(filePixels)(27, 64 / 28, 64)).toBe(64);
  });
});
