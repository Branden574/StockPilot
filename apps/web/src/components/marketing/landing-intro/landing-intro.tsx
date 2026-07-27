'use client';

import * as React from 'react';

import { IntroMark } from './mark';

import { capture } from '@/lib/analytics';
import {
  brandRevealAt,
  dimsFor,
  frameAt,
  LI,
  schedule,
  type Dims,
  type FlightVector,
  type Frame,
  type IntroMode,
  type Schedule,
} from '@/lib/landing-intro/timeline';
import { watchReadiness } from '@/lib/landing-intro/readiness';
import { hasSeenIntro, markIntroSeen } from '@/lib/landing-intro/session';

/** Selector for the page's own nav brand — the flight target. */
const NAV_BRAND_SELECTOR = '#sp-nav .brand';
/** Class the page's brand wears while the overlay owns the logo. */
const BRAND_HIDDEN_CLASS = 'li-brand-hidden';

type Phase = 'pending' | 'running' | 'done';

/**
 * LandingIntro — the branded scanline intro over the marketing landing page.
 *
 * Mounted from the (marketing) layout, which stays a Server Component. Renders
 * null on the server and on the first client render, so a repeat visit never
 * flashes a frame of intro before the session check runs and hydration always
 * matches.
 *
 * The page underneath is fully server-rendered and interactive the instant this
 * unmounts; the overlay never traps focus and contains nothing focusable.
 */
export function LandingIntro() {
  const [phase, setPhase] = React.useState<Phase>('pending');
  const [mode, setMode] = React.useState<IntroMode>('first');
  const [dims, setDims] = React.useState<Dims>(() => dimsFor(1200, 780));
  /**
   * Everything render needs, published by the rAF driver once per frame. Keeping
   * this in state (rather than reading refs while rendering) means the render is
   * a pure function of the snapshot — the driver owns the mutable timeline, the
   * view only draws it.
   */
  const [snap, setSnap] = React.useState<{ t: number; frame: Frame; flight: FlightVector | null } | null>(null);
  const t = snap?.t ?? 0;

  const schedRef = React.useRef<Schedule>(schedule('first', Number.POSITIVE_INFINITY));
  const flightRef = React.useRef<FlightVector | null>(null);
  const lockRef = React.useRef<HTMLDivElement | null>(null);
  const lockWRef = React.useRef(340);
  const rafRef = React.useRef<number | null>(null);
  const startedAtRef = React.useRef(0);
  const readyAtRef = React.useRef(Number.POSITIVE_INFINITY);
  const skipToRef = React.useRef<number | null>(null);
  const finishedRef = React.useRef(false);
  const brandElRef = React.useRef<HTMLElement | null>(null);
  const reportedRef = React.useRef(false);

  // Restore the page's brand no matter how we leave (unmount, error, skip).
  const releaseBrand = React.useCallback(() => {
    const el = brandElRef.current;
    if (el) el.classList.remove(BRAND_HIDDEN_CLASS);
  }, []);

  const finish = React.useCallback(
    (reason: 'completed' | 'failed', extra?: Record<string, unknown>) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      releaseBrand();
      markIntroSeen();
      setPhase('done');
      if (!reportedRef.current) {
        reportedRef.current = true;
        capture(reason === 'failed' ? 'landing_intro_failed' : 'landing_intro_completed', extra);
      }
    },
    [releaseBrand],
  );

  // ─── decide the lane, once, on mount ───
  React.useEffect(() => {
    let cancelled = false;

    // bfcache restore must never replay; if a live overlay somehow survives, drop it.
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) finish('completed', { bfcache: true });
    };
    window.addEventListener('pageshow', onPageShow);

    try {
      const reduced =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const seen = hasSeenIntro();
      const lane: IntroMode = reduced ? 'reduced' : seen ? 'repeat' : 'first';

      const vw = window.innerWidth || 1200;
      const vh = window.innerHeight || 780;
      if (cancelled) return;

      // The lane depends on sessionStorage + matchMedia, which must NOT be read
      // during render (the server has neither, so it would desync hydration).
      // Deciding here, after mount, is what keeps SSR and the first client render
      // identical — the component renders null until this promotes it.
      const laneDims = dimsFor(vw, vh);
      const laneSched = schedule(lane, Number.POSITIVE_INFINITY);

      /* eslint-disable react-hooks/set-state-in-effect -- client-only lane decision */
      setMode(lane);
      setDims(laneDims);
      schedRef.current = laneSched;
      // Seed frame 0 in the SAME commit that promotes to 'running'. Without this
      // the overlay renders null until the first rAF tick, and since that commit
      // is also what tears down the pre-hydration curtain, the landing page would
      // show through for a frame or two — the exact flash the design forbids.
      setSnap({
        t: 0,
        frame: frameAt(0, lane, laneSched, laneDims, lockWRef.current, null),
        flight: null,
      });
      setPhase('running');
      /* eslint-enable react-hooks/set-state-in-effect */

      capture('landing_intro_shown', {
        firstVisit: lane === 'first',
        reducedMotion: reduced,
        deviceClass: vw <= 480 ? 'mobile' : 'desktop',
      });
    } catch {
      finish('failed');
    }

    return () => {
      cancelled = true;
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [finish]);

  // ─── readiness → recompute the schedule ───
  React.useEffect(() => {
    if (phase !== 'running') return;
    const handle = watchReadiness();
    let live = true;
    void handle.promise.then(() => {
      if (!live) return;
      const readyAt = performance.now() - startedAtRef.current;
      readyAtRef.current = readyAt;
      schedRef.current = schedule(mode, readyAt);
      capture('landing_content_ready', { readyMs: Math.round(readyAt) });
    });
    return () => {
      live = false;
      handle.cancel();
    };
  }, [phase, mode]);

  // ─── measure the flight target + pre-hide the page's brand ───
  React.useEffect(() => {
    if (phase !== 'running') return;
    const brand = document.querySelector<HTMLElement>(NAV_BRAND_SELECTOR);
    brandElRef.current = brand;
    if (brand && mode !== 'reduced') brand.classList.add(BRAND_HIDDEN_CLASS);
    return releaseBrand;
  }, [phase, mode, releaseBrand]);

  // ─── hand over from the pre-hydration curtain ───
  // Both paint the same ink, so swapping one for the other is invisible — but
  // ONLY if the replacement is already on screen. Gate the teardown on snap
  // being present (the live overlay is rendering) or on the run being over
  // (nothing left to cover with). Never on 'running' alone: that commit can
  // still be rendering null, and removing the curtain there uncovers the page.
  React.useLayoutEffect(() => {
    const overlayPainting = phase === 'running' && snap !== null;
    if (!overlayPainting && phase !== 'done') return;
    document.getElementById('li-pre')?.remove();
  }, [phase, snap]);

  // ─── the driver ───
  React.useEffect(() => {
    if (phase !== 'running') return;

    startedAtRef.current = performance.now();
    let last = startedAtRef.current;
    let elapsed = 0;

    const measureFlight = () => {
      const brand = brandElRef.current;
      const lock = lockRef.current;
      if (!brand || !lock) return;
      // Sticky nav: measure fresh at exit time so scroll position is accounted for.
      const r = brand.getBoundingClientRect();
      if (r.width === 0) return;
      lockWRef.current = lock.offsetWidth || lockWRef.current;
      const L = dims.w / 2 - lockWRef.current / 2;
      const cy = dims.h * 0.44;
      flightRef.current = {
        tx: r.left - L,
        ty: r.top + r.height / 2 - cy,
        s: LI.NAV_MARK_PX / dims.markSize,
      };
    };

    const tick = (now: number) => {
      // Clamp dt so a backgrounded tab doesn't jump the timeline on resume.
      const dt = Math.min(now - last, 64);
      last = now;
      if (!document.hidden) elapsed += dt;

      if (skipToRef.current != null) {
        elapsed = Math.max(elapsed, skipToRef.current);
        skipToRef.current = null;
      }

      const sched = schedRef.current;
      if (elapsed >= sched.exitStart - 32 && flightRef.current == null) measureFlight();

      setSnap({
        t: elapsed,
        frame: frameAt(elapsed, mode, sched, dims, lockWRef.current, flightRef.current),
        flight: flightRef.current,
      });

      if (elapsed >= sched.hiddenAt) {
        finish('completed', {
          durationMs: Math.round(elapsed),
          readyMs: Number.isFinite(readyAtRef.current) ? Math.round(readyAtRef.current) : null,
          forced: sched.forced,
          reducedMotion: mode === 'reduced',
        });
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [phase, mode, dims, finish]);

  // Reveal the page's brand as the flown mark lands.
  React.useEffect(() => {
    if (phase !== 'running') return;
    const brand = brandElRef.current;
    if (!brand) return;
    if (t >= brandRevealAt(mode, schedRef.current)) brand.classList.remove(BRAND_HIDDEN_CLASS);
  }, [t, phase, mode]);

  const onSkip = React.useCallback(() => {
    skipToRef.current = schedRef.current.exitStart;
    capture('landing_intro_skipped', { atMs: Math.round(t) });
  }, [t]);

  if (phase !== 'running' || snap === null) return null;

  const f = snap.frame;
  if (f.hidden) return null;

  const cx = dims.w / 2;
  const cy = dims.h * 0.44;
  const flight = snap.flight;
  const lockTransform =
    flight && mode !== 'reduced' && f.flightP > 0
      ? `translate(${flight.tx * f.flightP}px, ${flight.ty * f.flightP}px) scale(${1 + (flight.s - 1) * f.flightP})`
      : undefined;

  return (
    <div
      className="li-root"
      aria-hidden="true"
      onClick={onSkip}
      style={{ opacity: f.rootOpacity, background: LI.ink }}
    >
      <div className="li-grid" style={{ opacity: f.gridOpacity }} />

      {f.beam ? (
        <div className="li-beam" style={{ left: f.beam.x, opacity: f.beam.opacity }}>
          <div className="li-beam-tail" />
          <div className="li-beam-edge" />
        </div>
      ) : null}

      <div className="li-lockpos" style={{ left: cx, top: cy }}>
        <div
          ref={lockRef}
          className="li-lock"
          style={{
            gap: dims.gap,
            opacity: f.lockOpacity,
            clipPath: f.lockClip,
            WebkitClipPath: f.lockClip,
            transform: lockTransform,
          }}
        >
          <div className="li-markwrap" style={{ opacity: f.breathe }}>
            <IntroMark size={dims.markSize} idSalt="intro" />
            {f.pulse > 0 && f.pulse < 1 ? (
              <Pulse markSize={dims.markSize} p={f.pulse} />
            ) : null}
          </div>
          <span className="li-word" style={{ fontSize: dims.wordSize }}>
            <b>Stock</b>
            <span>Pilot</span>
          </span>
        </div>
      </div>

      {/* Exactly one announcement for the whole sequence, never per stage. */}
      <span className="li-sr" role="status">
        Loading StockPilot
      </span>
    </div>
  );
}

/** Confirmation pulse, anchored to the pip at (72%, 24%) of the mark box. */
function Pulse({ markSize, p }: { markSize: number; p: number }) {
  const ring = 1 - Math.pow(1 - p, 3);
  const dotO = Math.min(1, p / 0.25) * (1 - Math.max(0, (p - 0.45) / 0.55));
  return (
    <div className="li-pulse" style={{ left: markSize * 0.72, top: markSize * 0.24 }}>
      <div
        className="li-pulse-ring"
        style={{ transform: `scale(${0.4 + ring * 1.9})`, opacity: 0.75 * (1 - ring) }}
      />
      <div className="li-pulse-dot" style={{ opacity: dotO }} />
    </div>
  );
}

export default LandingIntro;
