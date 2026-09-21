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

function mount(rangeHeight = 10000, startAt = 0) {
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

  const film = mountFilm({ canvas, range, set: SET });
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

describe('the film loads more than one frame per round trip', () => {
  it('keeps several frames in flight at once', async () => {
    autoLoad = false;
    const f = mount();
    for (let i = 0; i < 4; i++) await flush();
    // Nothing has completed, so everything made so far is in flight together.
    expect(pending.length).toBeGreaterThan(1);
    expect(pending.length).toBeLessThanOrEqual(6);
    f.film.destroy();
  });

  it('still asks for the frames under the playhead first, wherever the visitor entered', async () => {
    autoLoad = false;
    // Entering half way down (a shared link, a restored scroll position): the
    // first frames requested are the ones about to be scrubbed through, not the
    // top of the film.
    const f = mount(10000, 0.5);
    for (let i = 0; i < 4; i++) await flush();
    expect(pending.length).toBeGreaterThan(1);
    for (const img of pending) expect(Math.abs(indexOf(img) - 10)).toBeLessThanOrEqual(4);
    f.film.destroy();

    made = [];
    pending = [];
    const top = mount(10000, 0);
    for (let i = 0; i < 4; i++) await flush();
    for (const img of pending) expect(indexOf(img)).toBeLessThanOrEqual(4);
    top.film.destroy();
  });

  it('asks for every frame exactly once, however many passes run', async () => {
    const f = mount();
    for (let i = 0; i < 12; i++) await flush();
    const indices = made.map(indexOf).sort((a, b) => a - b);
    expect(indices).toEqual(Array.from({ length: COUNT }, (_, i) => i));
    f.film.destroy();
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
