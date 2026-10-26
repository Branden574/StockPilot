'use client';

import * as React from 'react';

/**
 * How much of the breadcrumb trail the top bar has room for.
 *
 * THE TRAIL GIVES WAY BEFORE THE WAREHOUSE PICKER (P68-01). From a 520 px bar
 * the picker keeps its whole name (shrink-0, up to its 160 px cap) and every
 * button keeps its size, so the trail takes what is left, in steps rather than
 * by cutting every crumb short: the whole trail, then the current page's name
 * alone, then no trail. Which step fits depends on the crumbs' own words (an
 * org can rename them) and the bar's own width, so it is measured:
 * - `trailRoom` is the bar's inside width less every other control and the
 *   gaps (the search bar counted at its 240 px floor, which it gives up before
 *   the trail does, as before), with the trail counted as one item;
 * - the natural widths come from an invisible copy of the trail that is laid
 *   out whatever the step (data-slot="topbar-trail-measure").
 * None of these depend on the step chosen, so the choice is stable: no flicker
 * while a window is resized.
 *
 * The server and the first client render draw the whole trail (the server has
 * no widths); the layout effect picks the step before the browser paints the
 * hydrated bar, and again whenever the bar, a control in it or the trail's
 * words change size (a ResizeObserver).
 */
export type TrailFit = 'full' | 'current' | 'none';

/** A trail that fits only to within rounding would lose its last letter to the ellipsis. */
const SLACK = 0.5;

/** The largest step that fits in `room`, given the trail's natural widths. */
export function fitTrail(room: number, fullWidth: number, currentWidth: number): TrailFit {
  if (fullWidth <= room - SLACK) return 'full';
  if (currentWidth <= room - SLACK) return 'current';
  return 'none';
}

/** The attribute that marks the trail's own <nav> and its measuring copy. */
export const TRAIL_SLOT = 'topbar-trail';
export const TRAIL_MEASURE_SLOT = 'topbar-trail-measure';

/**
 * The width the trail may take in `header` (a flex row) without pushing or
 * squeezing anything else: its inside width, less each other item that is
 * displayed and in the flow, less the gaps between all of them counting the
 * trail as one item whether or not it is on screen. An item that grows (the
 * full search bar, flex-1) counts at its min-width, the room it keeps when
 * the trail needs more.
 */
export function trailRoom(header: HTMLElement): number {
  const view = header.ownerDocument.defaultView ?? window;
  const style = view.getComputedStyle(header);
  const px = (v: string) => Number.parseFloat(v) || 0;
  let room = header.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
  let items = 1;
  for (const child of Array.from(header.children)) {
    if (!(child instanceof view.HTMLElement)) continue;
    const slot = child.dataset.slot;
    if (slot === TRAIL_SLOT || slot === TRAIL_MEASURE_SLOT) continue;
    const s = view.getComputedStyle(child);
    if (s.display === 'none' || s.position === 'absolute' || s.position === 'fixed') continue;
    items += 1;
    room -= px(s.flexGrow) > 0 ? px(s.minWidth) : child.getBoundingClientRect().width;
  }
  return room - px(style.columnGap) * (items - 1);
}

/**
 * The step of the trail that fits the bar, kept up to date as it resizes.
 * `measureRef` is the invisible copy: its width is the whole trail's, and its
 * last child's the current page's name. `words` changes when the crumbs do.
 */
export function useTrailFit(
  headerRef: React.RefObject<HTMLElement | null>,
  measureRef: React.RefObject<HTMLElement | null>,
  words: string,
): TrailFit {
  const [fit, setFit] = React.useState<TrailFit>('full');

  React.useLayoutEffect(() => {
    const header = headerRef.current;
    const measure = measureRef.current;
    if (!header || !measure) return;
    const update = () => {
      // Not laid out (display: none, or a test DOM): keep the step drawn.
      if (header.clientWidth === 0) return;
      const last = measure.lastElementChild;
      const full = measure.getBoundingClientRect().width;
      const current = last ? last.getBoundingClientRect().width : full;
      setFit(fitTrail(trailRoom(header), full, current));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(header);
    observer.observe(measure);
    for (const child of Array.from(header.children)) {
      if (child instanceof HTMLElement && child.dataset.slot !== TRAIL_SLOT) {
        observer.observe(child);
      }
    }
    return () => observer.disconnect();
  }, [headerRef, measureRef, words]);

  return fit;
}
