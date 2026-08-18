/**
 * The cinematic film engine — scroll position drives a frame index.
 *
 * SCROLL = FRAME POSITION, never SCROLL = START PLAYBACK. Scrolling forward
 * advances the film; scrolling backward reverses it; stopping anywhere leaves a
 * usable still. That determinism is why this is a frame sequence rather than a
 * seeking <video>: video seeking is not frame-accurate, stutters under rapid
 * scrubbing, and cannot be driven backwards smoothly.
 *
 * Evolved from the original ScrollyLanding canvas, keeping what was already
 * good — device tiering, nearest-loaded gap tolerance, aspect-preserving cover
 * draw, DPR capped at 2, hidden-tab handling — and fixing what was not:
 *
 *   1. It preloaded ALL 546 frames immediately (~70MB before anything worked).
 *      This loads in PASSES: a sparse spread first so scrubbing is live almost
 *      at once at coarse temporal resolution, then progressively densifies.
 *   2. It mapped the film across the WHOLE document, so the footer scrubbed
 *      film too. This maps across an explicit element range, so the chapters
 *      and the footage stay in step.
 *   3. It had no reduced-motion path at all.
 *
 * The engine is deliberately framework-free: no React state per frame, no
 * re-render per scroll event. React mounts it once and it owns the canvas.
 */

/**
 * The assembled film, expressed as SEGMENTS rather than a flattened directory.
 *
 * The cut interleaves newly generated footage with the original sequence. The
 * obvious way to ship that is to materialise one directory of 786 files — and
 * the first attempt did exactly that, using symlinks back to the originals to
 * avoid duplicating 87MB. That is a deploy-breaking trap: git records a symlink
 * by its target string, the targets were absolute paths under a developer's home
 * directory, and every one of them would have resolved to nothing once deployed.
 *
 * Segments avoid the choice entirely. Only the ~42MB of genuinely new footage is
 * committed; the original sets are referenced in place, unmodified. Nothing is
 * duplicated, nothing is symlinked, and the cut is data rather than filesystem
 * layout — so re-ordering it later is an edit here, not a rebuild.
 */
export interface Segment {
  dir: string;
  /** 1-based index of this segment's first frame WITHIN its own directory. */
  from: number;
  /** Number of frames taken from that directory. */
  count: number;
}

export interface FrameSet {
  segments: Segment[];
  count: number;
  poster: string;
}

const HI_SEGMENTS: Segment[] = [
  { dir: '/landing/film-a-hi', from: 1, count: 120 },   // NEW  inbound dock
  { dir: '/landing/frames-hi', from: 1, count: 420 },   //      aisle → receive → staging
  { dir: '/landing/film-c-hi', from: 1, count: 120 },   // NEW  placement into a crate on a rack
  { dir: '/landing/frames-hi', from: 421, count: 126 }, //      on hand → transfer → count
];

const LO_SEGMENTS: Segment[] = [
  { dir: '/landing/film-a-lo', from: 1, count: 82 },
  { dir: '/landing/frames-lo', from: 1, count: 281 },
  { dir: '/landing/film-c-lo', from: 1, count: 81 },
  { dir: '/landing/frames-lo', from: 282, count: 85 },
];

const total = (segs: Segment[]) => segs.reduce((n, s) => n + s.count, 0);

export const HI: FrameSet = {
  segments: HI_SEGMENTS,
  count: total(HI_SEGMENTS),
  poster: '/landing/film-hi-poster.jpg',
};
export const LO: FrameSet = {
  segments: LO_SEGMENTS,
  count: total(LO_SEGMENTS),
  poster: '/landing/film-lo-poster.jpg',
};

/** Resolve a 0-based film index to the file that actually holds that frame. */
export function frameUrl(set: FrameSet, index0: number): string {
  let i = index0;
  for (const seg of set.segments) {
    if (i < seg.count) return `${seg.dir}/f_${String(seg.from + i).padStart(4, '0')}.jpg`;
    i -= seg.count;
  }
  const last = set.segments[set.segments.length - 1];
  if (!last) return set.poster;
  return `${last.dir}/f_${String(last.from + last.count - 1).padStart(4, '0')}.jpg`;
}

/** How much film the visitor is allowed to cost, by conditions. */
export type Tier = 'hi' | 'lo' | 'poster';

export interface Conditions {
  smallViewport: boolean;
  coarsePointer: boolean;
  saveData: boolean;
  slowConnection: boolean;
  reducedMotion: boolean;
}

export function readConditions(): Conditions {
  const conn = (
    navigator as unknown as {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  const effective = conn?.effectiveType ?? '';
  return {
    smallViewport: window.matchMedia('(max-width: 820px)').matches,
    coarsePointer: window.matchMedia('(pointer: coarse)').matches,
    saveData: conn?.saveData === true,
    slowConnection: /(^|\b)(2g|slow-2g)\b/.test(effective),
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  };
}

/**
 * Tier selection. Save-Data and slow connections get the poster ONLY — a person
 * who has asked their OS to spend less data has not asked for a 70MB film, and
 * the page's argument survives without it. Reduced motion likewise: it still
 * gets imagery, but as static chapter keyframes rather than a scrub.
 */
export function pickTier(c: Conditions): Tier {
  if (c.saveData || c.slowConnection) return 'poster';
  if (c.reducedMotion) return 'poster';
  if (c.smallViewport || c.coarsePointer) return 'lo';
  return 'hi';
}

/**
 * Chapter → film range.
 *
 * Read from the FOOTAGE, not invented. Ranges are normalised so the frame count
 * can change without touching the chapters — which is exactly what happened when
 * the inbound shot was welded on the front and the film went 546 → 666.
 *
 *   0.000–0.085  NEW: dock threshold, daylight, pallets  → hero
 *   0.085–0.230  NEW: dolly in from the dock, resolving
 *                onto the original establishing aisle    → 01 purchase order
 *   0.230–0.531  phone scanning a shelf label, then a
 *                carton barcode with the confirm beam    → 02 receive
 *   0.531–0.645  carton opened on a bench, scanner down  → 03 staging
 *   0.645–0.840  a blue crate riding a cart, THEN NEW:
 *                that crate seated on a rack shelf with
 *                a box lowered into it                   → 04 put away
 *   0.840–0.899  travelling through filled racks         → 05 on hand
 *   0.899–0.955  continued movement                      → 06 order / transfer
 *   0.955–1.000  elevated wide, the aisle in order       → 07 count
 *
 * Two shots were generated to close gaps the original footage could not fill:
 *
 *  - INBOUND makes chapter 01 honest. The film used to open INSIDE the building,
 *    so "a purchase order arrived" played over a figure walking down an aisle.
 *    Now the order physically arrives through a dock.
 *  - PLACEMENT makes chapter 04 honest. Nothing was ever placed ONTO a rack —
 *    the cart shot only implies transport — so StockPilot's sharpest domain
 *    claim, that a crate sits ON a rack rather than instead of one, had no
 *    image. Now it does.
 *
 * PRODUCTION NOTE, learned the expensive way: anchoring BOTH ends of a generated
 * shot to existing frames makes the model interpolate between them and ignore
 * the prompt entirely. The first placement attempt was pinned between two cart
 * frames and dutifully produced more cart. Dropping the end anchor and keeping
 * only the start let the prompt introduce the rack. Anchors outrank prompts.
 */
export const CHAPTER_RANGE: Record<string, [number, number]> = {
  hero: [0.0, 0.085],
  'purchase-order': [0.085, 0.23],
  receive: [0.23, 0.531],
  staging: [0.531, 0.645],
  'put-away': [0.645, 0.84],
  'on-hand': [0.84, 0.899],
  transfer: [0.899, 0.955],
  count: [0.955, 1.0],
};

/** A representative still per chapter, for the reduced-motion path. */
export function keyframeFor(chapter: string, count: number): number {
  const range = CHAPTER_RANGE[chapter] ?? [0, 0];
  const mid = (range[0] + range[1]) / 2;
  return Math.max(1, Math.min(count, Math.round(mid * (count - 1)) + 1));
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export interface FilmHandle {
  destroy: () => void;
  /** Current normalised playhead, for tests and debugging. */
  progress: () => number;
}

export interface FilmOptions {
  canvas: HTMLCanvasElement;
  /** The element whose scroll extent the film is mapped across. */
  range: HTMLElement;
  set: FrameSet;
  /** Static single-frame mode — used for reduced motion. */
  still?: number;
  onReady?: () => void;
}

/**
 * Mount the film. Returns a handle; call destroy() on unmount.
 */
export function mountFilm(opts: FilmOptions): FilmHandle {
  const { canvas, range, set, still, onReady } = opts;
  const ctx2d = canvas.getContext('2d', { alpha: false });
  if (!ctx2d) return { destroy: () => {}, progress: () => 0 };
  // Re-bound so the non-null narrowing survives into the hoisted draw()
  // closure below — the original implementation needed the same trick.
  const ctx = ctx2d;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const COUNT = set.count;
  const frames: Array<(HTMLImageElement & { _ok?: boolean }) | undefined> = new Array(COUNT);
  let ready = false;
  let destroyed = false;
  let curT = 0;
  let curFrame = -1;
  let cw = 0;
  let ch = 0;
  let raf = 0;

  /** Progress of the scroll position across the mapped range, 0..1. */
  const progress = (): number => {
    if (still != null) return (still - 1) / (COUNT - 1);
    const rect = range.getBoundingClientRect();
    const total = rect.height - window.innerHeight;
    if (total <= 0) return 0;
    // rect.top is negative once we are inside the range.
    return clamp01(-rect.top / total);
  };

  const nearestLoaded = (i: number): number => {
    if (frames[i]?._ok) return i;
    for (let d = 1; d < COUNT; d++) {
      if (i - d >= 0 && frames[i - d]?._ok) return i - d;
      if (i + d < COUNT && frames[i + d]?._ok) return i + d;
    }
    return -1;
  };

  function draw(f: number) {
    let i = Math.max(0, Math.min(COUNT - 1, Math.round(f)));
    if (i === curFrame) return;
    if (!frames[i]?._ok) {
      const j = nearestLoaded(i);
      if (j < 0) return;
      i = j;
    }
    const img = frames[i];
    if (!img) return;
    // Cover fit — never letterbox, never distort.
    const ir = img.naturalWidth / img.naturalHeight;
    const cr = cw / ch;
    let dw: number, dh: number, dx: number, dy: number;
    if (ir > cr) {
      dh = ch;
      dw = ch * ir;
      dx = (cw - dw) / 2;
      dy = 0;
    } else {
      dw = cw;
      dh = cw / ir;
      dx = 0;
      dy = (ch - dh) / 2;
    }
    ctx.drawImage(img, dx, dy, dw, dh);
    curFrame = i;
  }

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = canvas.clientWidth;
    ch = canvas.clientHeight;
    if (cw === 0 || ch === 0) return;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    curFrame = -1;
    draw(curT * (COUNT - 1));
  };

  const load = (index0: number) =>
    new Promise<void>((resolve) => {
      if (destroyed || frames[index0]) return resolve();
      const img = new Image() as HTMLImageElement & { _ok?: boolean };
      img.decoding = 'async';
      img.onload = () => {
        img._ok = true;
        if (!ready) {
          ready = true;
          resize();
          onReady?.();
        }
        resolve();
      };
      img.onerror = () => resolve();
      img.src = frameUrl(set, index0);
      frames[index0] = img;
    });

  /**
   * Progressive passes, ORDERED BY WHERE THE VISITOR IS LOOKING.
   *
   * The first version swept a uniform stride across the whole film, which meant
   * someone sitting at the top waited on frames from the far end before getting
   * any density where they actually were. Measured on Fast 3G that put the first
   * live frame at 10.4s. Seeding a small window around the current playhead
   * first makes the film come alive near the fold, then the global passes fill
   * everything else in.
   *
   * `nearestLoaded` covers whatever has not arrived, so there is never a blank
   * frame — a sparse film reads as slightly steppy, not broken. And the poster
   * is painted underneath the whole time, so the visitor is looking at the
   * warehouse from first paint regardless.
   */
  async function loadProgressively() {
    if (still != null) {
      await load(still - 1);
      return;
    }

    // Pass 0 — a tight window on the playhead. Small on purpose: every frame
    // here is one the visitor is about to scrub through.
    const here = Math.round(clamp01(progress()) * (COUNT - 1));
    for (let d = 0; d <= 4; d++) {
      for (const i of d === 0 ? [here] : [here + d, here - d]) {
        if (destroyed) return;
        if (i >= 0 && i < COUNT) await load(i);
      }
    }

    // Then the global spread, coarse to fine.
    for (const stride of [16, 8, 4, 2, 1]) {
      for (let i = 0; i < COUNT; i += stride) {
        if (destroyed) return;
        await load(i);
      }
      // Yield between passes so decoding never blocks interaction.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const tick = () => {
    if (destroyed) return;
    if (ready) {
      const target = progress();
      // Ease toward the target so a flung scroll does not strobe frames.
      curT += (target - curT) * 0.18;
      if (Math.abs(target - curT) < 0.0006) curT = target;
      draw(curT * (COUNT - 1));
    }
    raf = requestAnimationFrame(tick);
  };

  // A backgrounded tab stops rAF, so draw directly on those events instead.
  const onScrollHidden = () => {
    if (ready && document.hidden) {
      curT = progress();
      draw(curT * (COUNT - 1));
    }
  };
  const onVisible = () => {
    if (!document.hidden && ready) {
      curT = progress();
      draw(curT * (COUNT - 1));
    }
  };

  window.addEventListener('scroll', onScrollHidden, { passive: true });
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', onVisible);
  raf = requestAnimationFrame(tick);
  void loadProgressively();

  return {
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScrollHidden);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisible);
      for (let i = 0; i < COUNT; i++) {
        const img = frames[i];
        if (img) {
          img.onload = null;
          img.onerror = null;
          img.src = '';
        }
        frames[i] = undefined;
      }
    },
    progress: () => curT,
  };
}
