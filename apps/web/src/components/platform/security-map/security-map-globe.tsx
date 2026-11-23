'use client';

import * as React from 'react';

import { SECURITY_MAP_WORDS } from '@stockpilot/core';

import type { ArcTiming, GlobeFacing } from './globe-math';
import type { GlobeHandle } from './globe-renderer';
import { globeArcsOf, type DrawnArc } from './map-model';
import { STOCKPILOT_LON_LAT, landDots } from './world-geometry';

/**
 * The globe on the page: a canvas, and the renderer (globe-renderer.ts, the
 * only file that loads three.js) brought in with a dynamic import when this
 * mounts, so no page loads three.js unless the globe is shown.
 *
 * The globe draws only while it is on screen: a hidden tab or a canvas
 * scrolled out of view stops every frame. When the browser cannot give the
 * globe a drawing context, or takes it away, `onUnavailable` / `onLost` is
 * called once and the island shows the flat map in its place.
 */
export function SecurityMapGlobe({
  arcs,
  timing,
  startedAt,
  focus,
  mayTurn,
  hidden,
  onUnavailable,
  onLost,
}: {
  arcs: readonly DrawnArc[];
  timing: ArcTiming;
  startedAt: number;
  focus: GlobeFacing | null;
  mayTurn: boolean;
  hidden: boolean;
  onUnavailable: () => void;
  onLost: () => void;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const handleRef = React.useRef<GlobeHandle | null>(null);
  const [ready, setReady] = React.useState(false);
  const [onScreen, setOnScreen] = React.useState(true);
  const callbacks = React.useRef({ onUnavailable, onLost });
  React.useEffect(() => {
    callbacks.current = { onUnavailable, onLost };
  });

  // Make the globe once; free everything it holds when this unmounts.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let gone = false;
    let observer: ResizeObserver | null = null;
    void import('./globe-renderer')
      .then(({ createGlobe }) => {
        if (gone) return;
        let handle: GlobeHandle;
        try {
          handle = createGlobe(canvas, {
            land: landDots(),
            stockpilot: STOCKPILOT_LON_LAT,
            stockpilotLabel: SECURITY_MAP_WORDS.stockpilot,
            onContextLost: () => callbacks.current.onLost(),
          });
        } catch {
          callbacks.current.onUnavailable();
          return;
        }
        handleRef.current = handle;
        const size = () => {
          const box = canvas.getBoundingClientRect();
          handle.resize(Math.max(1, Math.round(box.width)), Math.max(1, Math.round(box.height)));
        };
        size();
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(size);
          observer.observe(canvas);
        }
        setReady(true);
      })
      .catch(() => {
        if (!gone) callbacks.current.onUnavailable();
      });
    return () => {
      gone = true;
      observer?.disconnect();
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, []);

  // On screen or not: a canvas scrolled away does no work.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setOnScreen(entry.isIntersecting);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const globeArcs = React.useMemo(() => globeArcsOf(arcs), [arcs]);

  React.useEffect(() => {
    handleRef.current?.setRunning(ready && onScreen && !hidden);
  }, [ready, onScreen, hidden]);

  React.useEffect(() => {
    if (!ready) return;
    handleRef.current?.show({ arcs: globeArcs, timing, startedAt, focus, mayTurn });
  }, [ready, globeArcs, timing, startedAt, focus, mayTurn]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-testid="security-map-globe"
      className="block h-full w-full cursor-grab touch-pan-y active:cursor-grabbing"
    />
  );
}
