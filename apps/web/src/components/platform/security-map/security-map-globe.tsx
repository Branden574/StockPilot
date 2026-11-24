'use client';

import * as React from 'react';

import { SECURITY_MAP_WORDS } from '@stockpilot/core';

import type { ArcTiming } from './globe-math';
import type { GlobeHandle, GlobeLabel, StageInsets } from './globe-renderer';
import { PANEL, globeArcsOf, webglAvailable, type DrawnArc, type SourceLabel } from './map-model';
import { STOCKPILOT_LON_LAT, landDots, landOwners } from './world-geometry';

/**
 * The globe on the page: a canvas, the labels over it, and the renderer
 * (globe-renderer.ts, the only file that loads three.js) brought in with a
 * dynamic import when this mounts, so no page loads three.js unless the
 * globe is shown. Before it is loaded, the browser is asked for a WebGL 2
 * context on a canvas of its own: with none, `onUnavailable` is called and
 * three.js is never fetched (so nothing is written to the console).
 *
 * The globe draws only while it is on screen: a hidden tab or a canvas
 * scrolled out of view stops every frame. When the browser takes the
 * drawing context away, `onLost` is called once and the island shows the
 * flat map in its place.
 *
 * The labels (StockPilot's and the top sources') are plain HTML text, placed
 * by the renderer beside their places on every frame and hidden when their
 * place is behind the globe. All of it is aria-hidden: the table under the
 * map is the accessible version.
 */
export function SecurityMapGlobe({
  arcs,
  timing,
  startedAt,
  stepMs,
  target,
  mayTurn,
  still,
  hidden,
  heat,
  labels,
  showLabels,
  insets,
  onUnavailable,
  onLost,
}: {
  arcs: readonly DrawnArc[];
  timing: ArcTiming;
  startedAt: number;
  stepMs: number;
  target: number;
  mayTurn: boolean;
  /** Reduced motion: the globe is drawn still. */
  still: boolean;
  hidden: boolean;
  heat: ReadonlyMap<string, number>;
  labels: readonly SourceLabel[];
  /** False on a phone: no words on the globe there. */
  showLabels: boolean;
  insets: StageInsets;
  onUnavailable: () => void;
  onLost: () => void;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const handleRef = React.useRef<GlobeHandle | null>(null);
  const stockpilotRef = React.useRef<HTMLDivElement | null>(null);
  const sourceRefs = React.useRef<Array<HTMLDivElement | null>>([]);
  const [ready, setReady] = React.useState(false);
  const [onScreen, setOnScreen] = React.useState(true);
  const callbacks = React.useRef({ onUnavailable, onLost });
  React.useEffect(() => {
    callbacks.current = { onUnavailable, onLost };
  });
  const insetsRef = React.useRef(insets);

  // Make the globe once; free everything it holds when this unmounts.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    if (!webglAvailable()) {
      callbacks.current.onUnavailable();
      return undefined;
    }
    let gone = false;
    let observer: ResizeObserver | null = null;
    void import('./globe-renderer')
      .then(({ createGlobe }) => {
        if (gone) return;
        let handle: GlobeHandle;
        try {
          handle = createGlobe(canvas, {
            land: landDots(),
            owners: landOwners(),
            stockpilot: STOCKPILOT_LON_LAT,
            onContextLost: () => callbacks.current.onLost(),
          });
        } catch {
          callbacks.current.onUnavailable();
          return;
        }
        handleRef.current = handle;
        const size = () => {
          const box = canvas.getBoundingClientRect();
          handle.resize(
            Math.max(1, Math.round(box.width)),
            Math.max(1, Math.round(box.height)),
            insetsRef.current,
          );
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
    insetsRef.current = insets;
    const canvas = canvasRef.current;
    if (!ready || !canvas) return;
    const box = canvas.getBoundingClientRect();
    handleRef.current?.resize(
      Math.max(1, Math.round(box.width)),
      Math.max(1, Math.round(box.height)),
      insets,
    );
  }, [ready, insets]);

  React.useEffect(() => {
    handleRef.current?.setRunning(ready && onScreen && !hidden);
  }, [ready, onScreen, hidden]);

  React.useEffect(() => {
    if (!ready) return;
    handleRef.current?.show({
      arcs: globeArcs,
      timing,
      startedAt,
      stepMs,
      target,
      mayTurn,
      still,
      heat,
    });
  }, [ready, globeArcs, timing, startedAt, stepMs, target, mayTurn, still, heat]);

  // The labels: StockPilot's first, then the sources by their events.
  React.useEffect(() => {
    if (!ready) return;
    const list: GlobeLabel[] = [];
    if (showLabels && stockpilotRef.current) {
      list.push({ el: stockpilotRef.current, lonLat: STOCKPILOT_LON_LAT, kind: 'stockpilot' });
    }
    if (showLabels) {
      labels.forEach((label, i) => {
        const el = sourceRefs.current[i];
        if (el) list.push({ el, lonLat: label.from, kind: 'source' });
      });
    }
    handleRef.current?.setLabels(list);
  }, [ready, labels, showLabels]);

  return (
    <div className="absolute inset-0">
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        data-testid="security-map-globe"
        className="block h-full w-full cursor-grab touch-pan-y active:cursor-grabbing"
      />
      {showLabels ? (
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
          <div
            ref={stockpilotRef}
            data-testid="security-map-label-stockpilot"
            className="sm-label sm-label-home"
            style={{ color: PANEL.stockpilot }}
          >
            {SECURITY_MAP_WORDS.stockpilot}
          </div>
          {labels.map((label, i) => (
            <div
              key={label.code}
              ref={(el) => {
                sourceRefs.current[i] = el;
              }}
              data-testid="security-map-label-source"
              className="sm-label"
            >
              <span className="sm-label-name">{label.name}</span>
              <span className="sm-label-count">{label.count}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
