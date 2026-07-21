// Per-asset production specs, derived from the MOTION registry in
// docs/design/email-system/es-tokens.js (13 board rows -> 15 GIFs; the clock
// row ships two variants: clock + clock-arc, plus the in-house tick).
//
// loop mapping (OWNER DECISION 2026-07-20, superseding plan decision 4's
// play-once/loop-N encoding): every asset "breathes" — Netscape loop 0
// (infinite) with a long hold on the composed resting state between plays,
// so motion never goes dead but nothing strobes while reading. The two
// route assets stay seamless continuous cycles (they never stopped).
//
// endHold — where the breathing pause lives in each cycle:
//   'lastFrame'  the final captured frame IS the settled state; it carries
//                the long delay (play-once boards + the clock's swept hold)
//   'restFrame'  periodic cycles (pulse/scanner/tag) append the rest frame
//                with the long delay so every breath starts composed
//   'none'       seamless infinite cycle, uniform delays (route/reverse)
//
// FRAME 1 RULE (MOTION_GLOBAL.firstFrame): every GIF's first frame is the
// composed resting state — the design's own reduced-motion state (es-core.jsx
// applies `animation:none` under prefers-reduced-motion), plus finished
// stroke-dash draws (.draw elements forced to stroke-dashoffset:0).
//   - breathing assets prepend that rest frame explicitly;
//   - the two infinite loops (route/reverse) start at animation phase 0, which
//     is already fully composed (route line, pips, box at origin — nothing
//     blank or mid-draw), so no extra frame breaks the seamless loop.
//
// capture: nFrames = round(cycleMs / 70ms target step); the exact step is
// cycleMs / nFrames (seamless loop phase), played back at delayCs (integer
// centiseconds, >= 6cs so no client rounds delays up).
import {
  heroLock, heroDevice, heroTiles, heroRoute, heroScanner, heroSettle,
  heroCheck, heroPin, heroTag, heroClock, heroCalendar, heroBars, heroTick,
} from './heroes.mjs';

export const CANVAS = { width: 1200, height: 440 }; // 1200x440 @2x -> 600x220

const KB = 1024;

// restDelayCs: short hold on the prepended rest frame before motion starts.
// endDelayCs: the breathing pause (~3.5s) on the settled state each cycle.
export const ASSETS = [
  {
    id: 'lock', file: 'lock@2x.gif', hero: heroLock,
    cycleMs: 2400, captureFromMs: 0, netscapeLoop: 0, prependRest: true,
    endHold: 'lastFrame', restDelayCs: 50, endDelayCs: 350, maxBytes: 250 * KB,
    note: 'Breathes: click-shut plays, rests ~4s, replays',
  },
  {
    id: 'pulse', file: 'pulse@2x.gif', hero: heroDevice,
    // Rings have 0s/0.9s delays; the system is periodic for t >= one period,
    // so capture the second period for a seamless cycle.
    cycleMs: 2800, captureFromMs: 2800, netscapeLoop: 0, prependRest: true,
    endHold: 'restFrame', restDelayCs: 50, endDelayCs: 350, maxBytes: 250 * KB,
    note: 'Breathes: one radar period per ~4s breath',
  },
  {
    id: 'tiles', file: 'tiles@2x.gif', hero: heroTiles,
    cycleMs: 1800, captureFromMs: 0, netscapeLoop: 0, prependRest: true,
    endHold: 'lastFrame', restDelayCs: 50, endDelayCs: 350, maxBytes: 400 * KB,
    note: 'Breathes; frame 1 = finished grid + drawn check',
  },
  {
    id: 'route', file: 'route@2x.gif', hero: heroRoute,
    // Continuous: pure cycle, no rest/hold frames. Phase 0 is fully composed.
    // All periods (travel 3.6s, ring 3.6s, dash march 1.8s) divide 3.6s.
    cycleMs: 3600, captureFromMs: 3600, netscapeLoop: 0, prependRest: false,
    endHold: 'none', restDelayCs: 0, endDelayCs: 0, maxBytes: 300 * KB,
    note: 'Infinite (subtle) — seamless, never stopped',
  },
  {
    id: 'reverse', file: 'reverse@2x.gif', hero: () => heroRoute({ reverse: true }),
    cycleMs: 3600, captureFromMs: 3600, netscapeLoop: 0, prependRest: false,
    endHold: 'none', restDelayCs: 0, endDelayCs: 0, maxBytes: 300 * KB,
    note: 'Infinite (subtle) — mirror of route',
  },
  {
    id: 'scanner', file: 'scanner@2x.gif', hero: heroScanner,
    cycleMs: 2200, captureFromMs: 0, netscapeLoop: 0, prependRest: true,
    endHold: 'restFrame', restDelayCs: 50, endDelayCs: 350, maxBytes: 300 * KB,
    note: 'Breathes: one sweep per ~4s breath; brackets blink once per sweep',
  },
  {
    id: 'settle', file: 'settle@2x.gif', hero: heroSettle,
    cycleMs: 1600, captureFromMs: 0, netscapeLoop: 0, prependRest: true,
    endHold: 'lastFrame', restDelayCs: 50, endDelayCs: 350, maxBytes: 300 * KB,
    note: 'Breathes; frame 1 = settled cartons + pip',
  },
  {
    id: 'check', file: 'check@2x.gif', hero: heroCheck,
    cycleMs: 1400, captureFromMs: 0, netscapeLoop: 0, prependRest: true,
    endHold: 'lastFrame', restDelayCs: 50, endDelayCs: 350, maxBytes: 250 * KB,
    note: 'Breathes; frame 1 = drawn circle + check + ticks',
  },
  {
    id: 'pin', file: 'pin@2x.gif', hero: heroPin,
    cycleMs: 1800, captureFromMs: 0, netscapeLoop: 0, prependRest: true,
    endHold: 'lastFrame', restDelayCs: 50, endDelayCs: 350, maxBytes: 250 * KB,
    note: 'Breathes: drop + one ring pulse per breath',
  },
  {
    id: 'tag', file: 'tag@2x.gif', hero: heroTag,
    cycleMs: 3200, captureFromMs: 0, netscapeLoop: 0, prependRest: true,
    endHold: 'restFrame', restDelayCs: 50, endDelayCs: 350, maxBytes: 250 * KB,
    note: 'Breathes: one gentle swing per ~4s breath',
  },
  {
    id: 'clock', file: 'clock@2x.gif', hero: () => heroClock({ tone: 'warn' }),
    // es-hand fills forwards (sweep, then hold within the cycle); the long
    // delay rides the LAST captured frame (hand at rest after the sweep).
    cycleMs: 2600, captureFromMs: 0, netscapeLoop: 0, prependRest: true,
    endHold: 'lastFrame', restDelayCs: 50, endDelayCs: 350, maxBytes: 250 * KB,
    note: 'Breathes — schedule 1-hour (warn hand, no arc)',
  },
  {
    id: 'clock-arc', file: 'clock-arc@2x.gif', hero: () => heroClock({ tone: 'err', arc: true }),
    cycleMs: 2600, captureFromMs: 0, netscapeLoop: 0, prependRest: true,
    endHold: 'lastFrame', restDelayCs: 50, endDelayCs: 350, maxBytes: 250 * KB,
    note: 'Breathes — rental overdue (arc past the due mark, per es-rentals.jsx:67 tone="err")',
  },
  {
    id: 'calendar', file: 'calendar@2x.gif', hero: heroCalendar,
    cycleMs: 1600, captureFromMs: 0, netscapeLoop: 0, prependRest: true,
    endHold: 'lastFrame', restDelayCs: 50, endDelayCs: 350, maxBytes: 250 * KB,
    note: 'Breathes; frame 1 = popped date tile',
  },
  {
    id: 'bars', file: 'bars@2x.gif', hero: heroBars,
    cycleMs: 1800, captureFromMs: 0, netscapeLoop: 0, prependRest: true,
    endHold: 'lastFrame', restDelayCs: 50, endDelayCs: 350, maxBytes: 300 * KB,
    note: 'Breathes; frame 1 = risen bars incl. amber exception bar',
  },
  {
    // Not a hero-box asset: the "received" email's "L2 · Timeline tick" —
    // an 11x11-display transparent dot that replaces the active timeline
    // glyph (orderTimeline currentDotImgSrc). Transparent so it sits on the
    // paper background in BOTH light and dark mode.
    id: 'tick', file: 'tick@2x.gif', hero: heroTick,
    canvas: { width: 22, height: 22 }, transparent: true,
    cycleMs: 1400, captureFromMs: 0, netscapeLoop: 0, prependRest: true,
    endHold: 'lastFrame', restDelayCs: 50, endDelayCs: 350, maxBytes: 20 * KB,
    note: 'Breathes: dot beat + ring pulse per ~4s breath; frame 1 = solid dot',
  },
];

const TARGET_STEP_MS = 70;

export function frameplan(asset) {
  const nFrames = Math.round(asset.cycleMs / TARGET_STEP_MS);
  const stepMs = asset.cycleMs / nFrames;
  const delayCs = Math.max(6, Math.round(stepMs / 10));
  return { nFrames, stepMs, delayCs };
}
