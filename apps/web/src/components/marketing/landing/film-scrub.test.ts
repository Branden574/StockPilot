import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountFilm, type FrameSet } from './film';

/**
 * The scrub itself: does the picture follow the scroll, and does the film arrive
 * at more than one frame per round trip?
 *
 * Both were measured as defects on the deployed site (2026-09-21, 1440x900 at
 * 120 Hz, every frame already decoded): the painted frame trailed a gentle
 * wheel by 9 frames of 786 and a flick by up to 184, and the loader took about
 * 180 seconds to fetch the film because it awaited one file at a time.
 */

const COUNT = 20;
const SET: FrameSet = {
  segments: [{ dir: '/film', from: 1, count: COUNT }],
  count: COUNT,
  poster: '/poster.jpg',
};
/** Long enough that the loader's bands are narrower than the film. */
const LONG = 400;
const LONG_SET: FrameSet = {
  segments: [{ dir: '/film', from: 1, count: LONG }],
  count: LONG,
  poster: '/poster.jpg',
};

interface FakeImage {
  src: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  naturalWidth: number;
  naturalHeight: number;
  decoding: string;
  _ok?: boolean;
}

/** Every `new Image()` the engine makes, in order, plus who is still pending. */
let made: FakeImage[] = [];
let pending: FakeImage[] = [];
/** false = hold every load open, so "how many at once" can be counted. */
let autoLoad = true;

function installImage() {
  class StubImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 1920;
    naturalHeight = 1080;
    decoding = 'auto';
    #src = '';
    get src() {
      return this.#src;
    }
    set src(value: string) {
      this.#src = value;
      if (!value) return;
      const self = this as unknown as FakeImage;
      made.push(self);
      if (autoLoad) this.onload?.();
      else pending.push(self);
    }
  }
  vi.stubGlobal('Image', StubImage as unknown as typeof Image);
}

/** Frame index (0-based) a stub image stands for, from its url. */
const indexOf = (img: { src: string }) => Number(/f_(\d+)\.jpg/.exec(img.src)?.[1] ?? 0) - 1;

function mount(rangeHeight = 10000, startAt = 0, set: FrameSet = SET) {
  const drawn: number[] = [];
  const ctx = {
    drawImage: (img: { src: string }) => drawn.push(indexOf(img)),
    setTransform: vi.fn(),
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'high',
  };
  const canvas = {
    getContext: () => ctx,
    clientWidth: 1425,
    clientHeight: 900,
    width: 0,
    height: 0,
  } as unknown as HTMLCanvasElement;

  let top = -startAt * (rangeHeight - 900);
  const range = document.createElement('div');
  range.getBoundingClientRect = () =>
    ({
      top,
      height: rangeHeight,
      bottom: top + rangeHeight,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: top,
    }) as DOMRect;

  // rAF under our control: the engine registers one callback per tick.
  let next: FrameRequestCallback | null = null;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    next = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});

  const film = mountFilm({ canvas, range, set });
  return {
    film,
    drawn,
    ctx,
    /** Put the scroll at `p` of the film's range. */
    scrollTo(p: number) {
      top = -p * (rangeHeight - window.innerHeight);
    },
    /** One animation frame, `dt` ms after the previous one. */
    tick(dt = 16.7) {
      const cb = next;
      next = null;
      cb?.((tick.now += dt));
    },
  };
}
const tick = { now: 0 };

beforeEach(() => {
  made = [];
  pending = [];
  autoLoad = true;
  tick.now = 1000;
  window.innerHeight = 900;
  installImage();
});
afterEach(() => vi.unstubAllGlobals());

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the painted frame follows the scroll', () => {
  it('lands on the frame the scroll asks for in ONE animation frame, not over many', async () => {
    const f = mount();
    for (let i = 0; i < 8; i++) await flush(); // let every frame load
    f.scrollTo(0.5);
    f.tick();
    // 0.5 of 20 frames = index 9.5 -> 10 (Math.round). No easing, so this is
    // exact on the FIRST frame after the scroll.
    expect(f.drawn[f.drawn.length - 1]).toBe(10);
    f.scrollTo(1);
    f.tick();
    expect(f.drawn[f.drawn.length - 1]).toBe(COUNT - 1);
    f.film.destroy();
  });

  it('does not keep moving once the scroll has stopped', async () => {
    const f = mount();
    for (let i = 0; i < 8; i++) await flush();
    f.scrollTo(0.75);
    f.tick();
    const settled = f.drawn.length;
    for (let i = 0; i < 20; i++) f.tick();
    // Every later frame is the same one, so nothing is redrawn.
    expect(f.drawn.length).toBe(settled);
    f.film.destroy();
  });

  it('is FRAME-RATE INDEPENDENT: a 30 fps machine lands where a 120 fps one does', async () => {
    const at = async (dt: number) => {
      const f = mount();
      for (let i = 0; i < 8; i++) await flush();
      f.scrollTo(0.5);
      f.tick(dt);
      const painted = f.drawn[f.drawn.length - 1];
      f.film.destroy();
      return painted;
    };
    // 120 Hz, 60 Hz, 30 fps, and one long stall.
    expect([await at(8.3), await at(16.7), await at(33), await at(250)]).toEqual([10, 10, 10, 10]);
  });

  it('follows the scroll backwards just as closely', async () => {
    const f = mount();
    for (let i = 0; i < 8; i++) await flush();
    f.scrollTo(1);
    f.tick();
    f.scrollTo(0.25);
    f.tick();
    expect(f.drawn[f.drawn.length - 1]).toBe(5);
    f.film.destroy();
  });
});

describe('the film loads around the visitor, not in full', () => {
  it('keeps several frames in flight at once', async () => {
    autoLoad = false;
    const f = mount();
    for (let i = 0; i < 4; i++) await flush();
    // Nothing has completed, so everything made so far is in flight together.
    expect(pending.length).toBeGreaterThan(1);
    expect(pending.length).toBeLessThanOrEqual(6);
    f.film.destroy();
  });

  it('asks for the frames under the playhead first, wherever the visitor entered', async () => {
    autoLoad = false;
    // Entering half way down (a shared link, a restored scroll position): the
    // first frames requested are the ones about to be scrubbed through, not the
    // top of the film.
    const f = mount(10000, 0.5, LONG_SET);
    for (let i = 0; i < 4; i++) await flush();
    expect(pending.length).toBeGreaterThan(1);
    const here = Math.round(0.5 * (LONG - 1));
    for (const img of pending) expect(Math.abs(indexOf(img) - here)).toBeLessThanOrEqual(24);
    f.film.destroy();
  });

  it('NEVER loads the whole film: the far end a visitor has not reached stays sparse', async () => {
    const f = mount(10000, 0, LONG_SET);
    for (let i = 0; i < 60; i++) await flush();
    const asked = new Set(made.map(indexOf));
    // Everything within the near band of the top is there...
    for (let i = 0; i <= 24; i++) expect(asked.has(i), `frame ${i}`).toBe(true);
    // ...and the far end has only the coarse spread, one frame in 24.
    const farEnd = [...asked].filter((i) => i > 300);
    expect(farEnd.length).toBeGreaterThan(0);
    for (const i of farEnd) expect(i % 24, `frame ${i} at the far end`).toBe(0);
    // In total, a fraction of the film rather than all of it.
    expect(asked.size).toBeLessThan(LONG / 2);
    f.film.destroy();
  });

  it('follows the visitor: scrolling somewhere new fetches the frames there', async () => {
    const f = mount(10000, 0, LONG_SET);
    for (let i = 0; i < 40; i++) await flush();
    await new Promise((r) => setTimeout(r, 300));
    const before = new Set(made.map(indexOf));
    const target = 300;
    expect(before.has(target + 1)).toBe(false);
    f.scrollTo(target / (LONG - 1));
    // REAL time: once its bands are full the loop idles, so following a scroll
    // takes one re-check rather than one microtask.
    await new Promise((r) => setTimeout(r, 400));
    for (let i = 0; i < 40; i++) await flush();
    const after = new Set(made.map(indexOf));
    for (let i = target - 8; i <= target + 8; i++) expect(after.has(i), `frame ${i}`).toBe(true);
    f.film.destroy();
  });

  it('asks for every frame exactly once, and stops asking when its bands are full', async () => {
    const f = mount();
    for (let i = 0; i < 12; i++) await flush();
    const indices = made.map(indexOf).sort((a, b) => a - b);
    // The test film is shorter than the near band, so all of it is "near".
    expect(indices).toEqual(Array.from({ length: COUNT }, (_, i) => i));
    const settled = made.length;
    for (let i = 0; i < 20; i++) await flush();
    expect(made.length).toBe(settled);
    f.film.destroy();
  });

  it('fills the band BEYOND the dense one at half density', async () => {
    const f = mount(10000, 0, LONG_SET);
    for (let i = 0; i < 40; i++) await flush();
    await new Promise((r) => setTimeout(r, 300));
    const asked = new Set(made.map(indexOf));
    // Past the near band (24) and inside the mid band (120): every SECOND
    // frame, and no odd ones. Without this the loop can spin on frames it
    // already holds and never reach the band beyond.
    const mid = [...asked].filter((i) => i > 30 && i <= 120);
    expect(mid.length).toBeGreaterThan(20);
    for (const i of mid) expect(i % 2, `frame ${i} in the mid band`).toBe(0);
    f.film.destroy();
  });

  it('stops following once the film is unmounted', async () => {
    const f = mount(10000, 0, LONG_SET);
    for (let i = 0; i < 20; i++) await flush();
    f.film.destroy();
    const afterDestroy = made.length;
    f.scrollTo(0.9);
    for (let i = 0; i < 20; i++) await flush();
    expect(made.length).toBe(afterDestroy);
  });

  it('schedules no further work at all once unmounted', async () => {
    const f = mount(10000, 0, LONG_SET);
    for (let i = 0; i < 20; i++) await flush();
    f.film.destroy();
    // The loop runs until it is told to stop. If it only stopped LOADING, it
    // would spin on an unmounted page for as long as the tab is open.
    const real = globalThis.setTimeout;
    let scheduled = 0;
    (globalThis as { setTimeout: typeof globalThis.setTimeout }).setTimeout = ((
      fn: () => void,
      ms?: number,
    ) => {
      scheduled += 1;
      return real(fn, ms);
    }) as typeof globalThis.setTimeout;
    await new Promise((r) => real(r, 300));
    globalThis.setTimeout = real;
    expect(scheduled).toBeLessThan(10);
  });
});

describe('the canvas keeps the cheap resampling it chose', () => {
  it('does not raise smoothing back to high when the backing store is sized', async () => {
    const f = mount();
    for (let i = 0; i < 4; i++) await flush();
    expect(f.ctx.imageSmoothingQuality).toBe('low');
    expect(f.ctx.imageSmoothingEnabled).toBe(true);
    f.film.destroy();
  });
});
