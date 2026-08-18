'use client';

import * as React from 'react';

import { CHAPTER_RANGE, HI, keyframeFor, LO, mountFilm, pickTier, readConditions } from './film';

/**
 * The fixed cinematic ground: poster, film canvas, chapter-shaped scrim, grain.
 *
 * This is the PHYSICAL half of the page. The foreground console is the DIGITAL
 * half, and scroll drives both — the visitor moves through a warehouse while
 * StockPilot explains what is happening to the stock inside it.
 *
 * PROTECTED HOOKS, all of which fail silently:
 *   - `#sp-stage` must stay `#0b0c0a`, byte-identical to `LI.ink`, or the
 *     loading intro's reveal shows a seam.
 *   - `<img id="sp-poster">` is what `watchReadiness()` waits on. It must remain
 *     a real <img> on a raster extension. It also stays permanently underneath
 *     the canvas as the first paint and the Save-Data fallback.
 *   - `#sp-film` is the canvas the engine draws into.
 *
 * The scrim is NOT a flat black wash. Shooting good footage and then burying it
 * under rgba(0,0,0,.75) defeats the point, so the gradient is shaped per chapter
 * to darken only the side the copy currently occupies. `data-side` on the stage
 * drives that, and the story publishes it as chapters advance.
 */

/** Which side of the frame the foreground copy occupies, per chapter. */
const SIDE: Record<string, 'left' | 'right' | 'wide'> = {
  hero: 'left',
  'purchase-order': 'left',
  receive: 'left',
  staging: 'left',
  'put-away': 'left',
  'on-hand': 'left',
  transfer: 'left',
  count: 'wide',
};

/** Story chapters publish here; the stage listens. No prop drilling, no re-render. */
export const CHAPTER_EVENT = 'sp:chapter';

export function publishChapter(key: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CHAPTER_EVENT, { detail: key }));
}

export function Cinema({ rangeId }: { rangeId: string }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const posterRef = React.useRef<HTMLImageElement | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const range = document.getElementById(rangeId);
    const poster = posterRef.current;
    if (!canvas || !range || !poster) return;

    const conditions = readConditions();
    const tier = pickTier(conditions);

    // Save-Data / slow connection / reduced motion: the poster IS the film.
    // The narrative is entirely in the DOM, so nothing is lost but atmosphere.
    if (tier === 'poster' && !conditions.reducedMotion) {
      canvas.style.display = 'none';
      return;
    }

    const set = tier === 'hi' ? HI : LO;
    poster.src = set.poster;

    // Reduced motion still gets imagery — a single settled still, no scrubbing.
    const still = conditions.reducedMotion ? keyframeFor('receive', set.count) : undefined;

    const film = mountFilm({
      canvas,
      range,
      set,
      still,
      onReady: () => {
        canvas.classList.add('on');
      },
    });

    return () => film.destroy();
  }, [rangeId]);

  // Shape the scrim to whichever side the copy currently occupies.
  React.useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onChapter = (e: Event) => {
      const key = (e as CustomEvent<string>).detail;
      stage.dataset.side = SIDE[key] ?? 'left';
      stage.dataset.chapter = key;
    };
    window.addEventListener(CHAPTER_EVENT, onChapter);
    return () => window.removeEventListener(CHAPTER_EVENT, onChapter);
  }, []);

  return (
    <div id="sp-stage" ref={stageRef} data-side="left" data-chapter="hero" aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element -- deliberate.
          watchReadiness() does querySelector<HTMLImageElement>('#sp-poster') and
          waits on its decode. next/image renders its own <img> and can move or
          drop a passed id; if that query misses, readiness resolves instantly
          and the branded intro lifts onto an unpainted hero, with no error. */}
      <img id="sp-poster" ref={posterRef} src={HI.poster} alt="" aria-hidden />
      <canvas id="sp-film" ref={canvasRef} aria-hidden />
      <div id="sp-tint" aria-hidden />
      <div id="sp-scrim" aria-hidden />
      <div id="sp-grain" aria-hidden />
      <div id="sp-vignette" aria-hidden />
    </div>
  );
}

/** Exposed for the chapter-mapping test. */
export { CHAPTER_RANGE };
