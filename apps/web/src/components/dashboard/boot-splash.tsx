'use client';

import * as React from 'react';

/**
 * BootSplash — the desktop-web counterpart to the native cold-launch splash.
 *
 * On a GENUINE cold load / hard reload of the dashboard it holds a ~2.0s branded
 * boot screen (the "S" mark draws on, the wordmark rises, a mono status steps
 * CONNECTING → RESTORING SESSION → SYNCING INVENTORY → WORKSPACE READY with a
 * 00→100% counter and a hairline mint progress bar) and then cross-dissolves
 * (~500ms) to reveal the dashboard underneath.
 *
 * Wiring guarantees (see DashboardShell):
 *  - The splash is an OVERLAY on top of the already-rendered app. The dashboard
 *    shell mounts/hydrates BEHIND it during the 2s, so the moment the overlay
 *    clears the workspace is ready. We never gate the app's visibility on the
 *    animation loop — an instant skip just fades this overlay's opacity to 0.
 *  - Cold-load-only: a per-document `window` flag + Navigation Timing check means
 *    it fires once per real page load, never on client-side route changes.
 *  - It is SSR-rendered (deterministic first frame) so it covers the very first
 *    paint on a cold load with no hydration mismatch; on a warm in-app mount a
 *    pre-paint layout effect removes it before the browser paints (no flash).
 *  - Theme-aware via CSS tokens (bg-background / --ink / --accent) — follows the
 *    same light/dark theme as the rest of the app.
 *  - Respects prefers-reduced-motion (static mark + filled bar, short hold, fade).
 */

/** Total branded hold before the cross-dissolve begins. */
export const LOADING_MS = 2000;
/** Cross-dissolve duration from boot screen → dashboard. */
export const CROSSFADE_MS = 500;
/** Under reduced motion we skip the timeline and hold the settled frame briefly. */
const REDUCED_HOLD_MS = 1100;
/**
 * A cold load mounts the shell within a few seconds of the document starting.
 * A warm in-app navigation (e.g. marketing → dashboard after browsing) mounts
 * it much later, so we only treat a fresh-enough document as a cold load.
 */
const COLD_LOAD_MAX_AGE_MS = 8000;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const easeOutBack = (x: number) => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
};

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

declare global {
  interface Window {
    __spBootConsumed?: boolean;
  }
}

/**
 * True only for a genuine cold load / hard reload that hasn't booted yet this
 * runtime. Marks the document consumed so a (defensive) remount never re-shows.
 */
function detectColdLoad(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.__spBootConsumed) return false;
  const nav = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  const type = nav?.type;
  // 'navigate' = fresh tab / first load, 'reload' = hard reload. 'back_forward'
  // (bfcache) and soft client navs are NOT cold loads.
  const freshDocument =
    (type === 'navigate' || type === 'reload') && performance.now() < COLD_LOAD_MAX_AGE_MS;
  return freshDocument;
}

/**
 * The brand mark, drawn on as a function of `p` (0..1). The rounded-square frame
 * strokes in first, then the carved-S path, then the mint pip pops at the upper
 * terminal — same canonical 100×100 geometry as <BrandGlyph>, rendered as a
 * draw-on outline instead of a filled mask.
 */
function BootMark({ size, p }: { size: number; p: number }) {
  const rectP = easeOut(clamp01(p / 0.5));
  const curveP = easeOut(clamp01((p - 0.28) / 0.72));
  const pipP = clamp01((p - 0.9) / 0.1);
  const pipScale = 0.4 + 0.6 * easeOutBack(pipP || 0.0001);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      style={{ display: 'block', overflow: 'visible', color: 'var(--ink)' }}
      aria-hidden="true"
    >
      <rect
        x="12"
        y="12"
        width="76"
        height="76"
        rx="18"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
        pathLength={1}
        strokeDasharray="1 1"
        strokeDashoffset={1 - rectP}
      />
      <path
        d="M 32 78 Q 72 78 72 66 Q 72 54 54 54 Q 32 54 32 42 Q 32 24 72 24"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap="round"
        fill="none"
        pathLength={1}
        strokeDasharray="1 1"
        strokeDashoffset={1 - curveP}
      />
      <circle
        cx="72"
        cy="24"
        r="6"
        fill="hsl(var(--accent))"
        style={{
          opacity: pipP,
          transform: `scale(${pipScale})`,
          transformOrigin: '72px 24px',
        }}
      />
    </svg>
  );
}

export interface BootSplashProps {
  /** Workspace name shown in the chip — the real org, not a placeholder. */
  workspaceName?: string;
  /** Fired once when the boot finishes (after the cross-dissolve), incl. skips. */
  onComplete?: () => void;
  /** Fired when the user skips (tap anywhere or the SKIP pill). */
  onSkip?: () => void;
}

type Phase = 'boot' | 'leaving' | 'done';

export function BootSplash({ workspaceName, onComplete, onSkip }: BootSplashProps) {
  const [phase, setPhase] = React.useState<Phase>('boot');
  const [t, setT] = React.useState(0);
  const [reduceMotion, setReduceMotion] = React.useState(false);

  const rafRef = React.useRef<number | null>(null);
  const startRef = React.useRef<number | null>(null);
  const leftRef = React.useRef(false);
  const finishedRef = React.useRef(false);
  const leaveTimerRef = React.useRef<number | null>(null);
  // Hold the latest callbacks in refs so the timeline effect doesn't re-run when
  // a parent re-renders with new closures. Synced in an effect (not during
  // render) — the refs are only read later from event/timer handlers.
  const onCompleteRef = React.useRef(onComplete);
  const onSkipRef = React.useRef(onSkip);
  React.useEffect(() => {
    onCompleteRef.current = onComplete;
    onSkipRef.current = onSkip;
  });

  // Authoritative end-state: unmount the overlay + fire onComplete exactly once.
  const finish = React.useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    if (leaveTimerRef.current != null) window.clearTimeout(leaveTimerRef.current);
    setPhase('done');
    onCompleteRef.current?.();
  }, []);

  const beginLeave = React.useCallback(
    (reason: 'complete' | 'skip') => {
      if (leftRef.current) return;
      leftRef.current = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (reason === 'skip') onSkipRef.current?.();
      setPhase('leaving');
      // Safety net: drive to 'done' even if the opacity transitionEnd never
      // fires (e.g. prefers-reduced-motion zeroes the transition, or a
      // background tab). onTransitionEnd also calls finish() — whichever first.
      leaveTimerRef.current = window.setTimeout(finish, CROSSFADE_MS + 100);
    },
    [finish],
  );

  // Clear any pending leave timer on unmount.
  React.useEffect(
    () => () => {
      if (leaveTimerRef.current != null) window.clearTimeout(leaveTimerRef.current);
    },
    [],
  );

  useIsomorphicLayoutEffect(() => {
    // Warm / soft-nav mount → remove before the browser paints (no flash).
    if (!detectColdLoad()) {
      setPhase('done');
      return;
    }
    window.__spBootConsumed = true;

    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setReduceMotion(reduced);

    if (reduced) {
      const id = window.setTimeout(() => beginLeave('complete'), REDUCED_HOLD_MS);
      return () => window.clearTimeout(id);
    }

    startRef.current = performance.now();
    const loop = () => {
      const elapsed = performance.now() - (startRef.current ?? 0);
      setT(Math.min(elapsed, LOADING_MS));
      if (elapsed < LOADING_MS && !leftRef.current) {
        rafRef.current = requestAnimationFrame(loop);
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    // Authoritative leave trigger — robust even if rAF is throttled (bg tab).
    const id = window.setTimeout(() => beginLeave('complete'), LOADING_MS);
    return () => {
      window.clearTimeout(id);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [beginLeave]);

  if (phase === 'done') return null;

  // Under reduced motion, render the settled end-frame.
  const tt = reduceMotion ? LOADING_MS : t;

  const draw = clamp01((tt - 60) / 820);
  const markIn = reduceMotion ? 1 : easeOut(clamp01((tt - 40) / 320));
  const word = clamp01((tt - 760) / 480);
  const chip = clamp01((tt - 980) / 360);
  const meta = clamp01((tt - 1000) / 360);
  const prog = clamp01(tt / LOADING_MS);
  const settle = easeOut(clamp01((tt - 1700) / 300));

  const status =
    tt < 560
      ? 'CONNECTING'
      : tt < 1150
        ? 'RESTORING SESSION'
        : tt < 1750
          ? 'SYNCING INVENTORY'
          : 'WORKSPACE READY';

  const markScale = (0.9 + 0.1 * markIn) * (1 - 0.012 * settle);
  const counter = String(Math.round(prog * 100)).padStart(2, '0');
  const leaving = phase === 'leaving';

  return (
    <div
      // Not role="status": that would make the whole overlay a live region and
      // announce the 60fps counter. The status word has its own polite live
      // region below; the counter/progress are aria-hidden (decorative).
      aria-label="Starting StockPilot"
      onClick={() => beginLeave('skip')}
      className="bg-background fixed inset-0 z-[100] flex flex-col items-center justify-center overflow-hidden"
      style={{
        opacity: leaving ? 0 : 1,
        pointerEvents: leaving ? 'none' : 'auto',
        transition: `opacity ${CROSSFADE_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`,
      }}
      onTransitionEnd={(e) => {
        if (e.propertyName === 'opacity' && leaving) finish();
      }}
    >
      {/* Faint mint radial wash behind the lockup, top-left — matches AuthShell. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute"
        style={{
          top: -120,
          left: -90,
          width: 460,
          height: 460,
          opacity: 0.4 + 0.6 * easeOut(draw),
          background:
            'radial-gradient(circle at center, hsl(var(--accent) / 0.16), transparent 65%)',
        }}
      />

      {/* Centered lockup: mark + wordmark + workspace chip. */}
      <div className="relative z-[1] flex flex-col items-center gap-6">
        <div style={{ transform: `scale(${markScale})`, opacity: markIn }}>
          <BootMark size={96} p={draw} />
        </div>

        <div
          className="font-display"
          style={{
            opacity: word,
            transform: `translateY(${(1 - easeOut(word)) * 12}px)`,
            fontWeight: 600,
            fontSize: 28,
            letterSpacing: '-0.03em',
            lineHeight: 1,
            color: 'var(--ink)',
          }}
        >
          Stock<span style={{ fontWeight: 400, color: 'var(--ink-4)' }}>Pilot</span>
        </div>

        <div
          className="inline-flex items-center gap-2 rounded-full px-3 py-1"
          style={{
            opacity: chip,
            transform: `translateY(${(1 - easeOut(chip)) * 8}px)`,
            border: '1px solid var(--line)',
            background: 'var(--bg-elev)',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'hsl(var(--accent))',
            }}
          />
          <span className="text-[12px]" style={{ color: 'var(--ink-3)' }}>
            {workspaceName?.trim() || 'StockPilot'}
          </span>
        </div>
      </div>

      {/* Status readout + hairline progress, pinned to a narrow column near the bottom. */}
      <div
        className="absolute bottom-[12%] left-1/2 w-[min(320px,80vw)] -translate-x-1/2"
        style={{ opacity: meta }}
      >
        <div className="flex items-center justify-between">
          <span
            className="font-mono uppercase"
            aria-live="polite"
            aria-atomic="true"
            style={{
              fontSize: 10.5,
              fontWeight: 500,
              letterSpacing: '0.18em',
              color: 'var(--ink-3)',
            }}
          >
            <span aria-hidden="true">— </span>
            {status}
          </span>
          <span
            className="font-mono tabular-nums"
            aria-hidden="true"
            style={{
              fontSize: 10.5,
              fontWeight: 500,
              letterSpacing: '0.08em',
              color: 'var(--ink-3)',
            }}
          >
            {counter}%
          </span>
        </div>
        <div
          className="mt-3 overflow-hidden rounded-full"
          style={{ height: 2, background: 'var(--line-strong)' }}
          role="progressbar"
          aria-hidden="true"
          aria-valuenow={Math.round(prog * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${prog * 100}%`,
              background: 'hsl(var(--accent))',
              boxShadow: '0 0 8px hsl(var(--accent) / 0.55)',
            }}
          />
        </div>
      </div>

      {/* SKIP pill, top-right. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          beginLeave('skip');
        }}
        className="font-mono absolute right-5 top-5 rounded-full px-3 py-1.5 uppercase transition-colors"
        style={{
          opacity: meta,
          fontSize: 10.5,
          letterSpacing: '0.18em',
          color: 'var(--ink-3)',
          border: '1px solid var(--line-strong)',
          background: 'var(--bg-elev)',
        }}
        aria-label="Skip intro"
      >
        Skip
      </button>
    </div>
  );
}
