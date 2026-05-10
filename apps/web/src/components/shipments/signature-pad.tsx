'use client';

import * as React from 'react';

/**
 * Imperative handle exposed to the form wrapper. `isEmpty()` lets the
 * parent validate before submit; `toDataURL()` extracts the PNG payload;
 * `clear()` wipes both the visible canvas and the in-memory stroke buffer.
 */
export interface SignaturePadHandle {
  isEmpty: () => boolean;
  toDataURL: () => string;
  clear: () => void;
}

interface Point {
  x: number;
  y: number;
}

interface SignaturePadProps {
  /** Optional className passed to the outer wrapper for layout overrides. */
  className?: string;
  /** Fires the first time the user draws something (so parents can dismiss hints). */
  onChange?: (isEmpty: boolean) => void;
}

const STROKE_COLOR = '#0c0c0e';
const STROKE_WIDTH = 2;

/**
 * Vanilla-canvas signature pad — no dependency. Built for warehouse-loading-
 * dock conditions: phone in one hand, finger drag, possibly rotating the
 * device mid-flow.
 *
 * Implementation notes (non-negotiable requirements baked in):
 *
 *   1. Pointer Events — single code path for finger / stylus / mouse, with
 *      `setPointerCapture` so a stroke that wanders off the canvas edge
 *      still finishes cleanly.
 *   2. `touchAction: 'none'` keeps the page from scrolling while signing.
 *   3. Device-pixel-ratio scaling — canvas internal width = CSS width × DPR,
 *      then `ctx.scale(dpr, dpr)` so 1px in our drawing math is 1px on
 *      screen and lines stay crisp on retina.
 *   4. ResizeObserver — when the container changes size (rotation, browser-
 *      chrome show/hide), re-init the canvas dimensions and replay strokes
 *      stored in a ref so the in-progress signature survives.
 *   5. Quadratic-curve smoothing — control endpoint is the midpoint between
 *      previous and current points (classic signature-pad trick).
 *   6. Empty detection + clear button.
 *   7. Aspect-ratio 3:1 box (applied by the parent via Tailwind).
 *   8. PNG export — black on transparent.
 */
export const SignaturePad = React.forwardRef<SignaturePadHandle, SignaturePadProps>(
  function SignaturePad({ className, onChange }, ref) {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const canvasRef = React.useRef<HTMLCanvasElement>(null);
    /** Stored strokes, used to replay after resize. */
    const strokesRef = React.useRef<Point[][]>([]);
    /** Current in-progress stroke. */
    const currentStrokeRef = React.useRef<Point[] | null>(null);
    /** Track empty state without forcing a re-render on every move. */
    const isEmptyRef = React.useRef<boolean>(true);
    const [hintVisible, setHintVisible] = React.useState(true);

    // ── Drawing helpers ──────────────────────────────────────────────────

    const getCtx = React.useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      return ctx;
    }, []);

    const configureCtx = React.useCallback((ctx: CanvasRenderingContext2D) => {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = STROKE_COLOR;
      ctx.lineWidth = STROKE_WIDTH;
    }, []);

    /** Re-sync the bitmap dimensions to the current CSS size, then redraw. */
    const resize = React.useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const dpr = window.devicePixelRatio || 1;
      // Multiply CSS pixels by DPR for the internal bitmap, then scale the
      // drawing context so user-space coordinates remain in CSS pixels.
      // Without this, retina/phone draws are blurry.
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      configureCtx(ctx);
      redrawAll();
    }, [configureCtx]);

    const redrawAll = React.useCallback(() => {
      const canvas = canvasRef.current;
      const ctx = getCtx();
      if (!canvas || !ctx) return;
      // Clear in *bitmap* pixel space — canvas.width here is the scaled
      // value so we wipe the whole thing.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
      configureCtx(ctx);
      for (const stroke of strokesRef.current) {
        drawStroke(ctx, stroke);
      }
    }, [configureCtx, getCtx]);

    /**
     * Replay a complete stroke with quadratic-curve smoothing. For each
     * triplet (p0, p1, p2) we draw quadraticCurveTo(p1, midpoint(p1, p2)),
     * so the curve passes through the midpoints with p1 as the control —
     * the standard signature-pad smoothing trick. Single-point strokes
     * render as a tiny dot so a tap still leaves a mark.
     */
    function drawStroke(ctx: CanvasRenderingContext2D, points: Point[]) {
      if (points.length === 0) return;
      if (points.length === 1) {
        const p = points[0]!;
        ctx.beginPath();
        ctx.arc(p.x, p.y, STROKE_WIDTH / 2, 0, Math.PI * 2);
        ctx.fillStyle = STROKE_COLOR;
        ctx.fill();
        return;
      }
      ctx.beginPath();
      ctx.moveTo(points[0]!.x, points[0]!.y);
      for (let i = 1; i < points.length - 1; i += 1) {
        const cur = points[i]!;
        const next = points[i + 1]!;
        const mx = (cur.x + next.x) / 2;
        const my = (cur.y + next.y) / 2;
        ctx.quadraticCurveTo(cur.x, cur.y, mx, my);
      }
      // Finish out to the last point with a straight line so the tail
      // doesn't dangle short of where the finger lifted.
      const last = points[points.length - 1]!;
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }

    // ── Pointer event handlers ───────────────────────────────────────────

    const pointFromEvent = React.useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>): Point => {
        const canvas = canvasRef.current!;
        const rect = canvas.getBoundingClientRect();
        return {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        };
      },
      [],
    );

    const onPointerDown = React.useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        // Only the primary button for mice; pen/touch always allowed.
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        // Capture so wandering off the edge doesn't end the stroke.
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          /* setPointerCapture can throw on some old browsers; non-fatal */
        }
        const p = pointFromEvent(e);
        const stroke: Point[] = [p];
        currentStrokeRef.current = stroke;
        strokesRef.current.push(stroke);
        if (isEmptyRef.current) {
          isEmptyRef.current = false;
          setHintVisible(false);
          onChange?.(false);
        }
        // Render the initial dot immediately.
        const ctx = getCtx();
        if (ctx) drawStroke(ctx, stroke);
        e.preventDefault();
      },
      [getCtx, onChange, pointFromEvent],
    );

    const onPointerMove = React.useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        const current = currentStrokeRef.current;
        if (!current) return;
        const p = pointFromEvent(e);
        // Cheap "did the finger actually move" filter — skips dozens of
        // pointermove events at the same pixel that some touch drivers fire.
        const last = current[current.length - 1]!;
        if (Math.abs(p.x - last.x) < 0.5 && Math.abs(p.y - last.y) < 0.5) return;
        current.push(p);
        // Incremental quadratic segment: from the midpoint(prev, last) to
        // midpoint(last, p), control = last.
        const ctx = getCtx();
        if (!ctx) return;
        if (current.length >= 3) {
          const p0 = current[current.length - 3]!;
          const p1 = current[current.length - 2]!;
          const p2 = current[current.length - 1]!;
          const mStart = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
          const mEnd = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
          ctx.beginPath();
          ctx.moveTo(mStart.x, mStart.y);
          ctx.quadraticCurveTo(p1.x, p1.y, mEnd.x, mEnd.y);
          ctx.stroke();
        } else if (current.length === 2) {
          ctx.beginPath();
          ctx.moveTo(current[0]!.x, current[0]!.y);
          ctx.lineTo(current[1]!.x, current[1]!.y);
          ctx.stroke();
        }
        e.preventDefault();
      },
      [getCtx, pointFromEvent],
    );

    const endStroke = React.useCallback((e?: React.PointerEvent<HTMLCanvasElement>) => {
      const current = currentStrokeRef.current;
      if (!current) return;
      // Draw the final tail of the stroke (the last point isn't otherwise
      // rendered by the incremental quadratic path above).
      const ctx = getCtx();
      if (ctx && current.length >= 2) {
        const p1 = current[current.length - 2]!;
        const p2 = current[current.length - 1]!;
        const mStart = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        ctx.beginPath();
        ctx.moveTo(mStart.x, mStart.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
      currentStrokeRef.current = null;
      if (e) {
        try {
          (e.target as Element).releasePointerCapture?.(e.pointerId);
        } catch {
          /* non-fatal */
        }
      }
    }, [getCtx]);

    const onPointerUp = React.useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        endStroke(e);
      },
      [endStroke],
    );

    const onPointerCancel = React.useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        endStroke(e);
      },
      [endStroke],
    );

    // ── Setup + resize observer ──────────────────────────────────────────

    React.useEffect(() => {
      resize();
      const container = containerRef.current;
      if (!container) return;
      // ResizeObserver fires on orientation change, browser-chrome show/hide,
      // and any container reflow. We re-init the bitmap and replay strokes.
      const ro = new ResizeObserver(() => {
        resize();
      });
      ro.observe(container);
      // Also resize on devicePixelRatio changes — happens when a window
      // moves between monitors with different scaling.
      const dprQuery = window.matchMedia(
        `(resolution: ${window.devicePixelRatio || 1}dppx)`,
      );
      const onDprChange = () => resize();
      try {
        dprQuery.addEventListener('change', onDprChange);
      } catch {
        // Safari < 14 falls back to addListener.
        dprQuery.addListener?.(onDprChange);
      }
      return () => {
        ro.disconnect();
        try {
          dprQuery.removeEventListener('change', onDprChange);
        } catch {
          dprQuery.removeListener?.(onDprChange);
        }
      };
    }, [resize]);

    // ── Imperative API ───────────────────────────────────────────────────

    const clear = React.useCallback(() => {
      strokesRef.current = [];
      currentStrokeRef.current = null;
      isEmptyRef.current = true;
      setHintVisible(true);
      redrawAll();
      onChange?.(true);
    }, [onChange, redrawAll]);

    React.useImperativeHandle(
      ref,
      () => ({
        isEmpty: () => isEmptyRef.current,
        toDataURL: () => canvasRef.current?.toDataURL('image/png') ?? '',
        clear,
      }),
      [clear],
    );

    return (
      <div
        ref={containerRef}
        className={[
          'relative w-full select-none',
          'aspect-[3/1]',
          'rounded-xl',
          'border border-dashed border-[var(--ed-line-strong)]',
          'bg-[color:var(--ed-paper,#fafaf7)]',
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {/*
          The hint sits absolutely behind the canvas. Hidden as soon as
          the user starts drawing, restored on clear.
        */}
        {hintVisible ? (
          <div className="pointer-events-none absolute inset-0 flex items-end justify-center pb-3">
            <span className="text-muted-foreground text-xs font-medium uppercase tracking-[0.12em]">
              Sign here
            </span>
          </div>
        ) : null}
        <canvas
          ref={canvasRef}
          className="block h-full w-full touch-none rounded-xl"
          style={{ touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          aria-label="Signature pad"
          role="img"
        />
        <button
          type="button"
          onClick={clear}
          className="text-muted-foreground hover:text-foreground absolute right-3 top-2 text-xs font-medium underline-offset-2 hover:underline"
        >
          Clear
        </button>
      </div>
    );
  },
);
