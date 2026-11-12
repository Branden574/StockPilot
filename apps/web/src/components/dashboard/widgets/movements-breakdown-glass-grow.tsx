'use client';

import * as React from 'react';

import { isGlassShowing } from '@/components/theme/appearance-cookie';
import { isLiquidGlassEnabled } from '@/components/theme/appearance-flag';

/**
 * Liquid Glass only: holds the Movements card's bars at their start while the
 * card is outside the window, and lets them grow the first time about a third
 * of the card is inside it (styles/liquid-glass/shell.css, its last block).
 *
 * It renders nothing, so the card's markup is the same with and without it,
 * in both designs. All it ever does is put `data-glass-grow="wait"` on the
 * card and take it off again:
 *   - no attribute (the server HTML, no JavaScript, an error before this
 *     runs, a browser with no IntersectionObserver): the sheet grows the bars
 *     once when the card first appears and they end at full size, as before
 *     this file existed. Nothing can leave them at nothing;
 *   - `wait`: the sheet holds the bars at the start of the motion;
 *   - taking it off starts the motion once.
 * So the attribute is set only when the card is wholly outside the window at
 * the moment this mounts. A card that is on screen then, even partly, is left
 * alone and grows at once: the server HTML may already have been painted
 * with its bars up, and holding them now would make them vanish and come
 * back. Before a paint (a move to the Overview inside the app) and after one
 * (a hard load) therefore behave the same, and no bar is ever seen at full
 * size before it starts.
 *
 * Inert in Classic (nothing is read or written unless Liquid Glass is on
 * screen) and under "reduce motion" (the sheet has no rule there either).
 * Once per visit: the effect runs when the card mounts, never on a refresh of
 * its data or a Day/Night switch, and the observer is dropped the moment the
 * motion starts.
 */

/** The card: the chart card inside the widget renderer's cell for this widget. */
export const MOVEMENTS_CARD_SELECTOR =
  "[data-widget='movements-breakdown'] [data-slot='chart-card']";
export const GROW_ATTRIBUTE = 'data-glass-grow';
export const GROW_WAIT = 'wait';
/** "About a third" of the card inside the window. */
export const GROW_IN_VIEW_RATIO = 0.33;

/** How many pixels of a box are inside the window, top to bottom. */
function visibleHeight(rect: DOMRect): number {
  return Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
}

export function MovementsBreakdownGlassGrow() {
  React.useLayoutEffect(() => {
    if (!isLiquidGlassEnabled() || !isGlassShowing()) return;
    if (typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const card = document.querySelector(MOVEMENTS_CARD_SELECTOR);
    if (!card) return;
    const rect = card.getBoundingClientRect();
    // On screen already, even partly: the sheet's own start is the motion.
    if (rect.height > 0 && visibleHeight(rect) > 0) return;

    card.setAttribute(GROW_ATTRIBUTE, GROW_WAIT);
    const start = () => {
      observer.disconnect();
      card.removeAttribute(GROW_ATTRIBUTE);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          // A card more than three windows tall can never show a third of itself.
          const tooTall = entry.boundingClientRect.height > window.innerHeight * 3;
          if (entry.intersectionRatio >= GROW_IN_VIEW_RATIO || tooTall) {
            start();
            return;
          }
        }
      },
      { threshold: [0, GROW_IN_VIEW_RATIO] },
    );
    observer.observe(card);
    return start;
  }, []);
  return null;
}
