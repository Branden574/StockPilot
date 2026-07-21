// Per-asset production specs, derived from the MOTION registry in
// docs/design/email-system/es-tokens.js (13 board rows -> 14 GIFs; the clock
// row ships two variants: clock + clock-arc).
//
// loop mapping (plan pinned decision 4):
//   play once            -> Netscape loop 1
//   "Loop xN, then hold" -> Netscape loop N + long-hold final frame
//   "Infinite (subtle)"  -> Netscape loop 0 (forever)
//
// FRAME 1 RULE (MOTION_GLOBAL.firstFrame): every GIF's first frame is the
// composed resting state — the design's own reduced-motion state (es-core.jsx
// applies `animation:none` under prefers-reduced-motion), plus finished
// stroke-dash draws (.draw elements forced to stroke-dashoffset:0).
//   - play-once / loop-N assets prepend that rest frame explicitly;
//   - the two infinite loops (route/reverse) start at animation phase 0, which
//     is already fully composed (route line, pips, box at origin — nothing
//     blank or mid-draw), so no extra frame breaks the seamless loop.
//
// capture: nFrames = round(cycleMs / 70ms target step); the exact step is
// cycleMs / nFrames (seamless loop phase), played back at delayCs (integer
// centiseconds, >= 6cs so no client rounds delays up).
import {
  heroLock, heroDevice, heroTiles, heroRoute, heroScanner, heroSettle,
  heroCheck, heroPin, heroTag, heroClock, heroCalendar, heroBars,
} from './heroes.mjs';

export const CANVAS = { width: 1200, height: 440 }; // 1200x440 @2x -> 600x220

const KB = 1024;

// restDelayCs: hold on the prepended rest frame before motion starts.
// endDelayCs: hold on the final frame ("then hold" / settle beat).
export const ASSETS = [
  {
    id: 'lock', file: 'lock@2x.gif', hero: heroLock,
    cycleMs: 2400, captureFromMs: 0, netscapeLoop: 1, prependRest: true,
    restDelayCs: 50, endDelayCs: 250, maxBytes: 250 * KB,
    note: 'Play once (no infinite loop on security); settles by 2.4s',
  },
  {
    id: 'pulse', file: 'pulse@2x.gif', hero: heroDevice,
    // Rings have 0s/0.9s delays; the system is periodic for t >= one period,
    // so capture the second period for a seamless x3 loop.
    cycleMs: 2800, captureFromMs: 2800, netscapeLoop: 3, prependRest: true,
    restDelayCs: 50, endDelayCs: 350, maxBytes: 250 * KB,
    note: 'Loop x3, then hold',
  },
  {
    id: 'tiles', file: 'tiles@2x.gif', hero: heroTiles,
    cycleMs: 1800, captureFromMs: 0, netscapeLoop: 1, prependRest: true,
    restDelayCs: 50, endDelayCs: 250, maxBytes: 400 * KB,
    note: 'Play once; frame 1 = finished grid + drawn check',
  },
  {
    id: 'route', file: 'route@2x.gif', hero: heroRoute,
    // Infinite: pure cycle, no rest/hold frames. Phase 0 is fully composed.
    // All periods (travel 3.6s, ring 3.6s, dash march 1.8s) divide 3.6s.
    cycleMs: 3600, captureFromMs: 3600, netscapeLoop: 0, prependRest: false,
    restDelayCs: 0, endDelayCs: 0, maxBytes: 300 * KB,
    note: 'Infinite (subtle)',
  },
  {
    id: 'reverse', file: 'reverse@2x.gif', hero: () => heroRoute({ reverse: true }),
    cycleMs: 3600, captureFromMs: 3600, netscapeLoop: 0, prependRest: false,
    restDelayCs: 0, endDelayCs: 0, maxBytes: 300 * KB,
    note: 'Infinite (subtle) — mirror of route',
  },
  {
    id: 'scanner', file: 'scanner@2x.gif', hero: heroScanner,
    cycleMs: 2200, captureFromMs: 0, netscapeLoop: 4, prependRest: true,
    restDelayCs: 50, endDelayCs: 350, maxBytes: 300 * KB,
    note: 'Loop x4, then hold; brackets blink once per sweep',
  },
  {
    id: 'settle', file: 'settle@2x.gif', hero: heroSettle,
    cycleMs: 1600, captureFromMs: 0, netscapeLoop: 1, prependRest: true,
    restDelayCs: 50, endDelayCs: 250, maxBytes: 300 * KB,
    note: 'Play once; frame 1 = settled cartons + pip',
  },
  {
    id: 'check', file: 'check@2x.gif', hero: heroCheck,
    cycleMs: 1400, captureFromMs: 0, netscapeLoop: 1, prependRest: true,
    restDelayCs: 50, endDelayCs: 250, maxBytes: 250 * KB,
    note: 'Play once; frame 1 = drawn circle + check + ticks',
  },
  {
    id: 'pin', file: 'pin@2x.gif', hero: heroPin,
    cycleMs: 1800, captureFromMs: 0, netscapeLoop: 1, prependRest: true,
    restDelayCs: 50, endDelayCs: 250, maxBytes: 250 * KB,
    note: 'Play once; pin dropped, one ring pulse',
  },
  {
    id: 'tag', file: 'tag@2x.gif', hero: heroTag,
    cycleMs: 3200, captureFromMs: 0, netscapeLoop: 2, prependRest: true,
    restDelayCs: 50, endDelayCs: 350, maxBytes: 250 * KB,
    note: 'Loop x2, then hold (tag eases back to rest)',
  },
  {
    id: 'clock', file: 'clock@2x.gif', hero: () => heroClock({ tone: 'warn' }),
    // es-hand fills forwards (sweep, then hold within the cycle); the long
    // delay rides the LAST captured frame (hand at rest after the sweep), so
    // no rest frame is appended — holdOnLastFrame instead of endDelay rest.
    cycleMs: 2600, captureFromMs: 0, netscapeLoop: 2, prependRest: true,
    restDelayCs: 50, endDelayCs: 350, holdOnLastCapture: true, maxBytes: 250 * KB,
    note: 'Loop x2, then hold — schedule 1-hour (warn hand, no arc)',
  },
  {
    id: 'clock-arc', file: 'clock-arc@2x.gif', hero: () => heroClock({ tone: 'err', arc: true }),
    cycleMs: 2600, captureFromMs: 0, netscapeLoop: 2, prependRest: true,
    restDelayCs: 50, endDelayCs: 350, holdOnLastCapture: true, maxBytes: 250 * KB,
    note: 'Loop x2, then hold — rental overdue (arc past the due mark, per es-rentals.jsx:67 tone="err")',
  },
  {
    id: 'calendar', file: 'calendar@2x.gif', hero: heroCalendar,
    cycleMs: 1600, captureFromMs: 0, netscapeLoop: 1, prependRest: true,
    restDelayCs: 50, endDelayCs: 250, maxBytes: 250 * KB,
    note: 'Play once; frame 1 = popped date tile',
  },
  {
    id: 'bars', file: 'bars@2x.gif', hero: heroBars,
    cycleMs: 1800, captureFromMs: 0, netscapeLoop: 1, prependRest: true,
    restDelayCs: 50, endDelayCs: 250, maxBytes: 300 * KB,
    note: 'Play once; frame 1 = risen bars incl. amber exception bar',
  },
];

const TARGET_STEP_MS = 70;

export function frameplan(asset) {
  const nFrames = Math.round(asset.cycleMs / TARGET_STEP_MS);
  const stepMs = asset.cycleMs / nFrames;
  const delayCs = Math.max(6, Math.round(stepMs / 10));
  return { nFrames, stepMs, delayCs };
}
