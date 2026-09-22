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
  { dir: '/landing/film-a-hi', from: 1, count: 120 }, // NEW  inbound dock
  { dir: '/landing/frames-hi', from: 1, count: 420 }, //      aisle → receive → staging
  { dir: '/landing/film-c-hi', from: 1, count: 120 }, // NEW  placement into a crate on a rack
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

/**
 * Backing-store scale for the film canvas, as a fraction of CSS pixels.
 *
 * Not devicePixelRatio, and deliberately BELOW 1. This is a soft background
 * sitting under a tint, a shaped scrim, grain and a vignette; it is never read
 * for detail. Drawing it at ~0.6 of viewport size and letting the compositor
 * scale the element up is visually indistinguishable and cuts the per-frame
 * blit by roughly a third of the pixels.
 *
 * Measured on the production build, scrolling the film range: DPR 2 cost ~10fps
 * (though it also carried CSS filter / blend / backdrop-filter at the time), and
 * 1.0 measured 44fps. Dropping to 0.6 measured 41fps — i.e. NOT a win, which is
 * how we learned the blit was never the bottleneck. Decode was. Left at 1 for
 * quality; raise above 1 only with a fresh profile in hand.
 */
const FILM_SCALE = 1;

/**
 * How closely the film follows the scroll, as a time constant in milliseconds.
 *
 * THE SMOOTHER USED TO BE FRAME-RATE DEPENDENT: `curT += (target - curT) * 0.18`
 * applied once per animation frame. That is 0.18 per 8.3 ms on a 120 Hz display
 * and 0.18 per 16.7 ms on a 60 Hz one, so the SLOWER the machine, the further
 * the film trailed the scroll — and a machine dropping to 30 fps trailed four
 * times as far as this one measured.
 *
 * An exponential follower lags a moving target by (time constant x speed).
 * Measured on the deployed film, 1440x900 at 120 Hz, every frame already
 * decoded in the browser, no long tasks and no dropped animation frames:
 *
 *   | scroll        | painted frame behind the scroll (of 786) |
 *   | ---           | ---                                      |
 *   | gentle wheel  | p50 9, p95 28                            |
 *   | fast flick    | p50 84, p95 177, max 184                 |
 *
 * and the film kept moving for 233 ms after the scroll stopped. At 60 Hz those
 * lags double. The film also grew 546 -> 786 frames in the redesign, which
 * stretched the same lag by 44% more frames.
 *
 * So: measured in TIME, not in animation frames, and short enough that the
 * picture is attached to the scroll. 0 means "the frame IS the scroll position",
 * which is what this file's header promises; a small positive value only damps
 * sub-pixel jitter. Raise it only with a fresh measurement in hand.
 */
const FOLLOW_MS = 0;

/*
 * NO REPAINT CAP. A 24fps cap was tried: it measured a marginal ~2fps and made
 * the film visibly STEP — on a 120Hz display it painted every fifth refresh and
 * each paint skipped several film frames. Frame continuity matters more than a
 * couple of fps; the film paints on every animation frame the scrub moves.
 */

/*
 * NO EVICTION WINDOW. Bounding retained frames to a window around the playhead
 * was tried on the theory that browser eviction was forcing re-decodes inside
 * the scroll. It measured no gain, and it caused the exact symptom it was meant
 * to prevent: outrun the window and nearestLoaded hands you a frame from far
 * away — a visible jump. The browser manages its own bitmap cache; let it.
 */

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
  // 'high' resampling on a full-screen surface redrawn on every frame change is
  // not worth it for a soft, heavily scrimmed background — nobody inspects this
  // at pixel level, and it is measurably expensive.
  ctx.imageSmoothingQuality = 'low';

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
    /* FILM_DPR is deliberately 1, not devicePixelRatio.
     *
     * At DPR 2 a 1440x900 viewport means a 2880x1800 backing store: four times
     * the pixels to draw, and four times the surface for every compositing pass
     * layered above it. This is a soft background sitting under a scrim, a tint
     * and a vignette — the extra density is invisible and it was a large part of
     * a measured 10fps scroll. */
    const dpr = FILM_SCALE;
    cw = canvas.clientWidth;
    ch = canvas.clientHeight;
    if (cw === 0 || ch === 0) return;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // NOT re-raised to 'high' here. Setting the backing store size resets the
    // context state, so the 'low' chosen above (deliberately: this is a soft
    // background under a tint, a scrim, grain and a vignette, and 'high'
    // resampling of a 1920 px frame into a ~1425 px canvas on every frame
    // change is measurably expensive) has to be re-applied, not overridden.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    curFrame = -1;
    draw(curT * (COUNT - 1));
  };

  const load = (index0: number) =>
    new Promise<void>((resolve) => {
      if (destroyed || frames[index0]) return resolve();
      const img = new Image() as HTMLImageElement & { _ok?: boolean };
      img.decoding = 'async';

      /**
       * A frame is only marked usable once it is DECODED, not merely loaded.
       *
       * drawImage on an undecoded image forces a synchronous decode on the main
       * thread, and scrubbing walks onto new frames constantly — so the decode
       * cost lands inside the scroll handler, exactly where it hurts. Awaiting
       * decode() here moves it off the draw path entirely; `nearestLoaded` shows
       * an already-decoded neighbour in the meantime, so nothing stalls waiting.
       *
       * This was the actual bottleneck. Shrinking the canvas backing store was
       * tried first and measured slightly WORSE, which ruled out the blit.
       */
      const markReady = () => {
        img._ok = true;
        if (!ready) {
          ready = true;
          resize();
          onReady?.();
        }
        resolve();
      };

      img.onload = () => {
        if (typeof img.decode === 'function') {
          img.decode().then(markReady, markReady);
        } else {
          markReady();
        }
      };
      img.onerror = () => resolve();
      img.src = frameUrl(set, index0);
      frames[index0] = img;
    });

  /**
   * How many frames may be in flight at once.
   *
   * The passes used to `await load(i)` one frame at a time, so the film arrived
   * at whatever ONE round trip per frame allowed: measured against the deployed
   * site, 787 files and 99.4 MB took about 180 SECONDS to finish, roughly 8
   * frames a second, on a fast connection. Until a frame arrives the engine
   * shows the nearest decoded neighbour, so the film stayed visibly coarse for
   * minutes. Six at a time keeps the ordering of the passes (the playhead
   * window still lands first) while letting the connection do what it can.
   */
  const IN_FLIGHT = 6;

  /** Loads `indices` in order, `IN_FLIGHT` at a time. Stops on destroy. */
  async function loadAll(indices: number[]) {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(IN_FLIGHT, indices.length) }, async () => {
        while (next < indices.length) {
          if (destroyed) return;
          const i = indices[next];
          next += 1;
          if (i !== undefined) await load(i);
        }
      }),
    );
  }

  /**
   * THE FILM IS LOADED AROUND THE VISITOR, NOT IN FULL.
   *
   * The passes used to end with a stride-1 sweep of the whole film, so everyone
   * fetched all of it: 787 files and 99.4 MB on the desktop tier, whether they
   * read the whole page or bounced after the first chapter. Nothing on screen
   * needs that. `nearestLoaded` already shows the closest decoded neighbour, so
   * what matters is density WHERE THE PLAYHEAD IS, and enough of a spread
   * elsewhere that a flick lands near something rather than far from it.
   *
   * Three bands, re-evaluated as the visitor moves:
   *
   *   NEAR  every frame within 24 either side — what is being scrubbed now.
   *   MID   every second frame out to 120 either side — the next chapter or two,
   *         close enough that arriving there is never a jump.
   *   FLICK one frame in 24 across the WHOLE film, so a throw to the footer
   *         lands within 12 frames of the right one while NEAR catches up.
   *
   * There is no global full-density pass, and that is the point: a visitor who
   * never reaches chapter 6 never downloads chapter 6 at full density.
   */
  const NEAR_BAND = 24;
  const MID_BAND = 120;
  const FLICK_STRIDE = 24;
  /**
   * Frames queued per round of the loop.
   *
   * ONE WAVE, not more. The loop reads the playhead, queues a batch, then waits
   * for the whole batch; everything in it was aimed at where the visitor WAS
   * when it was queued. A batch several waves deep meant the loader chased a
   * stale position and a brisk scroll stayed a step behind for the rest of the
   * film — measured on the deployed site as up to 17 frames of 786 on a fast
   * first scroll. At one wave the aim is refreshed as often as the connection
   * allows.
   */
  const BATCH = IN_FLIGHT;
  /** How often the loop looks again once the bands around the visitor are full. */
  const IDLE_RECHECK_MS = 150;

  /** The playhead, as a frame index. */
  const playhead = () => Math.round(clamp01(progress()) * (COUNT - 1));

  /**
   * Not-yet-requested frames within `radius` of `here`, NEAREST FIRST, taking
   * only every `stride`-th frame (aligned to absolute indices, so the mid band
   * asks for a stable set rather than a different one each time it is called).
   */
  function missingNear(here: number, radius: number, stride: number, cap: number): number[] {
    const out: number[] = [];
    for (let d = 0; d <= radius && out.length < cap; d++) {
      for (const i of d === 0 ? [here] : [here - d, here + d]) {
        if (i < 0 || i >= COUNT) continue;
        if (stride > 1 && i % stride !== 0) continue;
        if (frames[i]) continue;
        out.push(i);
        if (out.length >= cap) break;
      }
    }
    return out;
  }

  async function loadProgressively() {
    if (still != null) {
      await load(still - 1);
      return;
    }

    // A TIGHT seed where the visitor is — enough to scrub immediately, not so
    // much that an early flick has to wait for it. Widening the near band to 24
    // before the coarse spread ran would have made a flick in the first moments
    // paint an opening-chapter frame for five times as long as it used to; the
    // loop below fills the rest of the band a moment later.
    await loadAll(missingNear(playhead(), 4, 1, Number.POSITIVE_INFINITY));

    // Then the coarse spread over the whole film, so a flick anywhere lands
    // near a decoded frame instead of on nothing.
    if (destroyed) return;
    const flick: number[] = [];
    for (let i = 0; i < COUNT; i += FLICK_STRIDE) flick.push(i);
    // The last frame explicitly: COUNT is rarely a multiple of the stride, so
    // the tail (up to 23 frames on the desktop set — the whole closing shot)
    // would otherwise have no coarse coverage at all, and a flick to the very
    // end of the page would land on whatever the previous multiple was.
    if (flick[flick.length - 1] !== COUNT - 1) flick.push(COUNT - 1);
    await loadAll(flick);

    // Then follow the visitor. This runs until the film is unmounted; when
    // there is nothing left to fetch near them it costs one cheap check a
    // quarter of a second, and it never widens beyond the bands above.
    for (;;) {
      if (destroyed) return;
      const here = playhead();
      const batch = missingNear(here, NEAR_BAND, 1, BATCH);
      if (batch.length < BATCH) {
        batch.push(...missingNear(here, MID_BAND, 2, BATCH - batch.length));
      }
      if (batch.length === 0) {
        // Nothing left to fetch around the visitor. Re-check soon enough that a
        // scroll is followed promptly, rarely enough to cost nothing while they
        // read: until it re-aims, `nearestLoaded` is showing the coarse spread,
        // which is never more than half of FLICK_STRIDE away.
        await new Promise((r) => setTimeout(r, IDLE_RECHECK_MS));
        continue;
      }
      await loadAll(batch);
      // Yield so decoding never blocks interaction.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  let lastTick = 0;
  const tick = (now: number) => {
    if (destroyed) return;
    if (ready) {
      const target = progress();
      if (FOLLOW_MS <= 0) {
        curT = target;
      } else {
        // Frame-rate INDEPENDENT: the same time constant on a 60 Hz laptop and a
        // 120 Hz display, and unchanged when animation frames are dropped. The
        // first tick has no elapsed time, and a backgrounded tab can hand us a
        // gap of seconds, so the step is clamped.
        const dt = lastTick === 0 ? 16.7 : Math.min(64, now - lastTick);
        curT += (target - curT) * (1 - Math.exp(-dt / FOLLOW_MS));
        if (Math.abs(target - curT) < 0.0006) curT = target;
      }
      lastTick = now;
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
      // NOTE: up to IN_FLIGHT load() promises are left unsettled here, because
      // clearing a source may fire neither onload nor onerror, so the follow
      // loop stays suspended rather than returning. That is deliberate and not
      // a leak: nothing outside this closure references the loop's promise
      // chain once the film is unmounted, so the whole graph — suspended frame
      // included — is unreachable and collectable as a cycle.
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
