/**
 * Landing intro timeline — pure functions of elapsed ms, ported verbatim from
 * the design package's motion lab (landing-intro-concepts.jsx) so the shipped
 * animation and the scrubbable prototype cannot drift. Everything here is
 * deterministic and side-effect free, which is what makes the schedule testable
 * without a DOM.
 *
 * Concept B "Scanline" only. Concepts A (Putaway) and C (Route) were prototyped
 * and rejected; they are deliberately not ported.
 */

export const LI = {
  /** Byte-identical to the landing hero's #sp-stage background.
   *  NOTE: the design doc says #0c0c0e, but the real hero is #0b0c0a
   *  (scrolly-landing.tsx). The doc's own requirement is "must be byte-identical
   *  to the hero background (seamless reveal, no flash)", so the hero wins —
   *  using the doc's literal value would produce the exact seam it forbids. */
  ink: '#0b0c0a',
  paper: '#faf9f4',
  confirm: '#5db89f',
  gridLine: 'rgba(250,249,244,0.045)',

  MIN_VISIBLE: 450,
  MAX_CAP: 1500,
  EXIT_FLIGHT: 420,
  EXIT_FADE: 460,
  EXIT_REDUCED: 240,

  /** Nav brand glyph is 26px (#sp-landing .glyph). The lab used 28. */
  NAV_MARK_PX: 26,
} as const;

export type IntroMode = 'first' | 'repeat' | 'reduced';

// ─── easings (verbatim from the lab) ───
export const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
/** Normalised progress of t across [a,b]. */
export const seg = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));
export const easeOut = (x: number): number => 1 - Math.pow(1 - x, 3);
export const easeInOut = (x: number): number =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

/** End of the entrance animation per lane. */
export function animDoneFor(mode: IntroMode): number {
  if (mode === 'first') return 900;
  if (mode === 'repeat') return 320;
  return 300;
}

export interface Schedule {
  animDone: number;
  /** ES — when the exit begins. */
  exitStart: number;
  /** When the overlay is fully gone and may unmount. */
  hiddenAt: number;
  /** True when readiness blew past the hard cap and we bailed out early. */
  forced: boolean;
}

/**
 * ES = clamp( max(animDone, readyAt, 450 floor), …, 1500 cap ).
 *
 * The 450ms floor stops a fast page from flashing the brand for two frames.
 * The 1500ms cap guarantees the page is never held hostage by a slow signal.
 *
 * REDUCED MOTION IS EXEMPT FROM THE FLOOR. The design package conflicts with
 * itself here: liSchedule applies the 450 floor to every lane, but the brief's
 * acceptance criterion is "reduced motion completes <= 550ms" — unreachable
 * with a 450 floor plus a 240ms exit (690ms). Someone who asked the OS for less
 * motion should get to content sooner, so the stated 550ms budget wins.
 */
export function schedule(mode: IntroMode, readyAt: number): Schedule {
  const animDone = animDoneFor(mode);
  const floor = mode === 'reduced' ? 0 : LI.MIN_VISIBLE;
  const natural = Math.max(animDone, readyAt, floor);
  const forced = natural > LI.MAX_CAP;
  const exitStart = Math.min(natural, LI.MAX_CAP);
  const exitDur = mode === 'reduced' ? LI.EXIT_REDUCED : LI.EXIT_FADE;
  return { animDone, exitStart, hiddenAt: exitStart + exitDur, forced };
}

export interface Dims {
  /** Viewport width/height in CSS px. */
  w: number;
  h: number;
  markSize: number;
  wordSize: number;
  gap: number;
}

/** Lockup geometry per breakpoint (design: 76/20/50 desktop, 56/14/34 at <=480). */
export function dimsFor(w: number, h: number): Dims {
  return w <= 480
    ? { w, h, markSize: 56, wordSize: 34, gap: 14 }
    : { w, h, markSize: 76, wordSize: 50, gap: 20 };
}

export interface Frame {
  gridOpacity: number;
  /** null when the beam is not visible this frame. */
  beam: { x: number; opacity: number } | null;
  lockOpacity: number;
  lockClip: string;
  /** Pulse progress 0..1; 0 or 1 means "don't render". */
  pulse: number;
  /** Pip breathe multiplier while holding for content. */
  breathe: number;
  rootOpacity: number;
  /** Flight transform progress 0..1 (0 = home, 1 = landed in the nav). */
  flightP: number;
  hidden: boolean;
}

export interface FlightVector {
  tx: number;
  ty: number;
  s: number;
}

/**
 * The whole overlay as a pure function of time. The component renders this and
 * nothing else, so a test can assert any frame without mounting anything.
 *
 * `lockW` is the measured lockup width; the beam-driven reveal needs it to know
 * where the lockup starts and ends on screen.
 */
export function frameAt(
  t: number,
  mode: IntroMode,
  sched: Schedule,
  dims: Dims,
  lockW: number,
  flight: FlightVector | null,
): Frame {
  const { w } = dims;
  const cx = w / 2;
  const ES = sched.exitStart;
  const reduced = mode === 'reduced';

  let gridOpacity: number;
  let lockOpacity: number;
  let lockClip = 'none';
  let beam: Frame['beam'] = null;
  let pulse = 0;

  if (mode !== 'first') {
    // Repeat + reduced: the finished lockup simply fades in. No beam, no carve.
    const inP = easeOut(seg(t, 0, mode === 'repeat' ? 320 : 300));
    lockOpacity = inP;
    gridOpacity = reduced ? 0.5 : 0.9 * inP;
  } else {
    gridOpacity = easeOut(seg(t, 0, 200)) * 0.9;

    // Beam sweep. Span is viewport-relative and capped, matching the lab
    // (min(w*0.56, 700)); the brief's fixed +/-280 desktop / +/-150 mobile does
    // not track the viewport and reads wrong on wide screens.
    const sweep = easeInOut(seg(t, 120, 620));
    const span = Math.min(w * 0.56, 700);
    const beamX = cx - span / 2 + sweep * span;
    const beamO = seg(t, 120, 190) * (1 - seg(t, 560, 650));
    if (beamO > 0.01) beam = { x: beamX, opacity: beamO };

    // The lockup is revealed in the beam's wake: the clip's right inset tracks
    // the beam's leading edge across the lockup's own bounds.
    const L = cx - lockW / 2;
    const cov = t >= 620 ? 1 : clamp01((beamX - L) / lockW);
    lockClip = `inset(-20% ${(1 - cov) * 100}% -20% -8%)`;
    lockOpacity = t < 120 ? 0 : 1;
    pulse = seg(t, 640, 900);
  }

  // Holding for content: the pip breathes and nothing else moves. No fake
  // progress bar, no spinner — the design is explicit about this.
  const holding = t > sched.animDone + 120 && t < ES;
  const breathe = holding && !reduced ? 0.85 + 0.15 * Math.sin((t - sched.animDone) / 260) : 1;

  // Exit.
  let rootOpacity = 1;
  let flightP = 0;
  if (t >= ES) {
    if (reduced || !flight) {
      rootOpacity = 1 - seg(t, ES, ES + LI.EXIT_REDUCED);
    } else {
      flightP = easeInOut(seg(t, ES, ES + LI.EXIT_FLIGHT));
      // Crossfade: the overlay lockup dissolves as the page's real brand comes up.
      lockOpacity = Math.min(lockOpacity, 1 - seg(t, ES + 320, ES + 440));
      gridOpacity = gridOpacity * (1 - seg(t, ES, ES + 260));
      rootOpacity = 1 - seg(t, ES + 300, ES + LI.EXIT_FADE);
    }
  }

  return {
    gridOpacity,
    beam,
    lockOpacity,
    lockClip,
    pulse,
    breathe,
    rootOpacity,
    flightP,
    hidden: t >= sched.hiddenAt,
  };
}

/** When the page's own nav brand should become visible again (handoff landing). */
export function brandRevealAt(mode: IntroMode, sched: Schedule): number {
  return sched.exitStart + (mode === 'reduced' ? 100 : 330);
}
