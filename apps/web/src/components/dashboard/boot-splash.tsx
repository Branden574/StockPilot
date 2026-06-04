'use client';

import * as React from 'react';

import { BOOT_HANDOFF_KEY } from '@/lib/boot-handoff';

/**
 * BootSplash — the branded "entering StockPilot" screen, the desktop
 * counterpart to the native cold-launch splash.
 *
 * It plays in exactly two moments and NOWHERE else:
 *   1. The FIRST load of the landing page (stockpilotusa.com `/`).
 *   2. After an app-entry CTA ("Open app" / "Sign in") sets a one-shot handoff
 *      flag — so it covers the transition into the app (and persists across the
 *      sign-in → dashboard redirect, since it lives in the ROOT layout).
 *
 * It deliberately does NOT play on a refresh of any page, on a direct/bookmarked
 * dashboard load, or on client-side route changes. (A regular refresh and a hard
 * refresh are indistinguishable in the browser — both are navigation.type
 * 'reload' — so we simply never treat a reload as a trigger.)
 *
 * Wiring guarantees:
 *  - Renders null on the server / first client render, then a pre-paint layout
 *    effect decides whether to play — so a refresh never flashes the splash and
 *    there is no hydration mismatch.
 *  - When it does play it overlays the app and cross-dissolves via opacity; the
 *    app underneath is never gated on the animation (tap anywhere or SKIP to
 *    hand off instantly). An authoritative timer guarantees it can't hang.
 *  - Theme-aware via CSS tokens; respects prefers-reduced-motion.
 */

/** Total branded hold before the cross-dissolve begins. */
export const LOADING_MS = 2000;
/** Cross-dissolve duration from boot screen → app. */
export const CROSSFADE_MS = 500;
/** Under reduced motion we skip the timeline and hold the settled frame briefly. */
const REDUCED_HOLD_MS = 1100;
/**
 * A genuine first load mounts within a few seconds of the document starting; a
 * stale soft-nav into the landing mounts much later, so we bound the landing
 * trigger by document age.
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

/**
 * Decide whether the splash should play on this mount:
 *   - handoff flag present  → an app-entry CTA was clicked (consume + play)
 *   - else first load of `/` → the landing page just loaded fresh (play)
 *   - else                  → don't play (refresh, direct load, soft nav, …)
 */
function shouldPlay(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.sessionStorage.getItem(BOOT_HANDOFF_KEY)) {
      window.sessionStorage.removeItem(BOOT_HANDOFF_KEY);
      return true;
    }
  } catch {
    // sessionStorage may throw in hardened privacy modes — fall through.
  }
  const nav = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  const isLanding = window.location.pathname === '/';
  // 'navigate' = genuine first load. NOT 'reload' (any refresh) or
  // 'back_forward' (bfcache).
  return isLanding && nav?.type === 'navigate' && performance.now() < COLD_LOAD_MAX_AGE_MS;
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
  /** Workspace name shown in the chip. Defaults to "StockPilot". */
  workspaceName?: string;
  /** Fired once when the boot finishes (after the cross-dissolve), incl. skips. */
  onComplete?: () => void;
  /** Fired when the user skips (tap anywhere or the SKIP pill). */
  onSkip?: () => void;
}

type Phase = 'pending' | 'boot' | 'leaving' | 'done';

export function BootSplash({ workspaceName, onComplete, onSkip }: BootSplashProps) {
  // 'pending' renders null (SSR + first client render) so a refresh never
  // flashes the splash and hydration matches; the layout effect promotes it to
  // 'boot' only when it should actually play.
  const [phase, setPhase] = React.useState<Phase>('pending');
  const [t, setT] = React.useState(0);
  const [reduceMotion, setReduceMotion] = React.useState(false);

  const rafRef = React.useRef<number | null>(null);
  const startRef = React.useRef<number | null>(null);
  const leftRef = React.useRef(false);
  const finishedRef = React.useRef(false);
  const decisionRef = React.useRef<boolean | null>(null);
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
    // Decide ONCE and cache it, so React StrictMode's dev double-invoke reuses
    // the verdict instead of re-reading/consuming the one-shot handoff flag —
    // but rebuild the timeline on every invoke so the animation still runs.
    if (decisionRef.current === null) decisionRef.current = shouldPlay();
    if (!decisionRef.current) {
      setPhase('done');
      return;
    }
    setPhase('boot');

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

  if (phase === 'pending' || phase === 'done') return null;

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
