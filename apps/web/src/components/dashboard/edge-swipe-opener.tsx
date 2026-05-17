'use client';

import * as React from 'react';

interface EdgeSwipeOpenerProps {
  /** Open the drawer when a left-edge swipe is recognized. */
  onOpen: () => void;
  /** Skip rendering while the drawer is already open. */
  disabled?: boolean;
}

const EDGE_ZONE_PX = 22;
const HORIZONTAL_THRESHOLD = 48;
const VERTICAL_TOLERANCE = 28;

/**
 * Fixed-position invisible strip at the left edge of the viewport that
 * recognizes a "swipe in from the left" gesture and opens the mobile
 * navigation drawer. Lives in the `md:hidden` mobile breakpoint only —
 * desktops render the persistent sidebar instead.
 *
 * Why this exists: iOS Safari and Chrome on Android default the left-edge
 * swipe to "browser back", which is the wrong affordance for our SPA-style
 * dashboard. Capturing the touch start in this thin zone and calling
 * preventDefault on the move steals the gesture before the browser-back
 * handler can fire, so the drawer opens instead.
 *
 * Implementation notes:
 *   • The zone is `touch-action: pan-y` so vertical scroll still works
 *     in the same pixel column (a tap-and-scroll near the edge still
 *     scrolls the page).
 *   • We only fire `onOpen` when the horizontal delta clearly dominates
 *     the vertical drift — that keeps "I'm trying to scroll vertically"
 *     from being misread as "I want the drawer."
 *   • `passive: false` on touchmove is required so `preventDefault()`
 *     actually cancels the browser back-swipe.
 */
export function EdgeSwipeOpener({ onOpen, disabled }: EdgeSwipeOpenerProps) {
  const stateRef = React.useRef<{
    startX: number;
    startY: number;
    triggered: boolean;
  } | null>(null);

  const handleTouchStart = React.useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    stateRef.current = {
      startX: t.clientX,
      startY: t.clientY,
      triggered: false,
    };
  }, []);

  const handleTouchMove = React.useCallback(
    (e: React.TouchEvent) => {
      const state = stateRef.current;
      if (!state || state.triggered) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - state.startX;
      const dy = Math.abs(t.clientY - state.startY);
      if (dx > HORIZONTAL_THRESHOLD && dy < VERTICAL_TOLERANCE) {
        state.triggered = true;
        // Cancel the browser's back-swipe interpretation. Requires the
        // listener to be non-passive; React Touch events are non-passive
        // by default so this works.
        e.preventDefault();
        onOpen();
      }
    },
    [onOpen],
  );

  const handleTouchEnd = React.useCallback(() => {
    stateRef.current = null;
  }, []);

  if (disabled) return null;

  return (
    <div
      aria-hidden="true"
      // Mobile-only — desktop has a persistent sidebar at md+.
      className="md:hidden"
      style={{
        position: 'fixed',
        top: 0,
        bottom: 0,
        left: 0,
        width: EDGE_ZONE_PX,
        zIndex: 40,
        touchAction: 'pan-y',
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    />
  );
}
