import {
  SECURITY_EVENT_CATEGORIES,
  SECURITY_MAP_RECENT_POLL_MS,
  SECURITY_MAP_WHOLE_POLL_MS,
  SECURITY_MAP_WORDS,
  securityMapNextPollDelay,
  securityMapShownCategories,
  type SecurityEventCategory,
  type SecurityMapArc,
  type SecurityMapPlan,
  type SecurityMapStopReason,
  type SecurityMapWholeRead,
} from '@stockpilot/core';

import { facingOf, type ArcTiming, type GlobeFacing } from './globe-math';
import { STOCKPILOT_LON_LAT, countryPoint, type LonLat } from './world-geometry';

/**
 * The island's own rules for showing core's plan: how each category looks,
 * which arcs are on the map this moment, when to read again, and which view
 * is shown. Pure and tested (map-model.test.ts). Core decides what is true;
 * this decides only how it is shown.
 */

/* ───────────────────────────── how a category looks ───────────────────────────── */

export type MarkShape = 'circle' | 'diamond' | 'square' | 'triangle' | 'hexagon';

export interface CategoryLook {
  /** For CSS. */
  hex: string;
  /** The same colour for the globe's shaders, 0 to 1. */
  rgb: readonly [number, number, number];
  /** The mark at an arc's start: a second sign of the category besides its colour. */
  shape: MarkShape;
}

const look = (hex: string, shape: MarkShape): CategoryLook => ({
  hex,
  rgb: [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ],
  shape,
});

/**
 * Every category has a colour and a shape of its own, hidden ones too, so
 * showing a category needs no new look. The colours are for the map's dark
 * panel, which is dark in both appearances.
 */
export const CATEGORY_LOOKS: Readonly<Record<SecurityEventCategory, CategoryLook>> = {
  password_guessing: look('#f5b041', 'circle'),
  exploit: look('#ff5c7a', 'diamond'),
  bots: look('#3dd5f3', 'square'),
  phishing: look('#b794f6', 'triangle'),
  malware: look('#9be15d', 'hexagon'),
};

/**
 * The one look of every kind the map does not draw, in the flagged list
 * only: a grey mark, the same for each such kind, so the list never tells
 * which hidden kind an entry was recorded under. Never drawn on the map.
 */
export const HIDDEN_KIND_LOOK: CategoryLook = look('#9aa6b8', 'triangle');

/** An entry's look in the flagged list: its kind's own when the map shows that kind, else the grey one. */
export function flaggedLookOf(category: SecurityEventCategory): CategoryLook {
  return securityMapShownCategories().includes(category)
    ? CATEGORY_LOOKS[category]
    : HIDDEN_KIND_LOOK;
}

/** The shape's number in the globe's shader. */
export const SHAPE_INDEX: Readonly<Record<MarkShape, number>> = {
  circle: 0,
  diamond: 1,
  square: 2,
  triangle: 3,
  hexagon: 4,
};

/** The map panel's own colours (dark in both appearances). */
export const PANEL = {
  land: '#6fb7ff',
  stockpilot: '#ffffff',
  text: '#e6edf7',
  quiet: '#c9d6ea',
} as const;

/* ─────────────────────────── what is on the map now ─────────────────────────── */

export interface Stage {
  timing: ArcTiming;
  arcs: SecurityMapArc[];
  /** The replay step shown, or -1. */
  stepIndex: number;
}

/**
 * The arcs on the map this moment, and how they move. Moving only when
 * nothing stops the play: live arcs loop, a replay shows its current hour.
 * Stopped for any reason (signed out, not updating, reduced motion, paused,
 * hidden): core's one still picture, and nothing moves. Old arcs can never
 * keep moving as if they were live.
 */
export function stageOf(
  plan: SecurityMapPlan,
  stop: SecurityMapStopReason | null,
  stepIndex: number,
): Stage {
  if (stop !== null || plan.mode === 'still') {
    return { timing: 'still', arcs: plan.picture, stepIndex: -1 };
  }
  if (plan.mode === 'live') return { timing: 'live', arcs: plan.live, stepIndex: -1 };
  const n = plan.steps.length;
  const i = n === 0 ? 0 : ((stepIndex % n) + n) % n;
  return { timing: 'replay', arcs: plan.steps[i]?.arcs ?? [], stepIndex: i };
}

export interface DrawnArc {
  arc: SecurityMapArc;
  from: LonLat;
}

/** The arcs that have a place to start from. An arc of a code with no point is not drawn. */
export function drawnArcs(arcs: readonly SecurityMapArc[]): DrawnArc[] {
  const out: DrawnArc[] = [];
  for (const arc of arcs) {
    const from = countryPoint(arc.country);
    if (from) out.push({ arc, from });
  }
  return out;
}

/** One arc as the globe draws it (globe-renderer.ts): where from, its look, flagged or not. */
export interface GlobeArc {
  key: string;
  from: LonLat;
  /** 0 to 1. */
  rgb: readonly [number, number, number];
  /** Core's width for the count, 1 to 4. */
  width: number;
  /** Drawn dashed and thinner, with hollow marks. */
  flagged: boolean;
  /** The category's mark, as the globe's shader numbers it. */
  shape: number;
}

/** The drawn arcs as the globe takes them. A flagged arc is never handed over as blocked. */
export function globeArcsOf(drawn: readonly DrawnArc[]): GlobeArc[] {
  return drawn.map(({ arc, from }) => {
    const look = CATEGORY_LOOKS[arc.category];
    return {
      key: arc.key,
      from,
      rgb: look.rgb,
      width: arc.width,
      flagged: arc.outcome === 'flagged',
      shape: SHAPE_INDEX[look.shape],
    };
  });
}

/** Which way the globe turns to keep the drawn arcs in view: their starts and StockPilot. */
export function focusOf(drawn: readonly DrawnArc[]): GlobeFacing | null {
  if (drawn.length === 0) return null;
  return facingOf([...drawn.map((d) => d.from), STOCKPILOT_LON_LAT]);
}

const num = (n: number): string => n.toLocaleString('en-US');

/**
 * The line for events of the window whose country has no point on the map
 * (a code that is neither one of ISO 3166-1's nor in the generator's short
 * hand-written list): they are in the table and never drawn. Null when there
 * are none.
 */
export function notOnMapWords(whole: SecurityMapWholeRead): string | null {
  let events = 0;
  const codes = new Set<string>();
  for (const [country, , , count] of whole.whole.table) {
    if (countryPoint(country)) continue;
    events += count;
    codes.add(country);
  }
  if (events === 0) return null;
  const list = [...codes].sort().join(', ');
  return `Not on the map: ${num(events)} ${events === 1 ? 'event comes' : 'events come'} from ${
    codes.size === 1 ? 'a place' : 'places'
  } the map has no point for (${list}). ${events === 1 ? 'It is' : 'They are'} in the table.`;
}

/* ──────────────────────────────── when to read ──────────────────────────────── */

export interface PollClock {
  /** When the last read of any kind finished (the page's clock), or null before the first. */
  lastPollAt: number | null;
  /** When the whole window was last read successfully, or null. */
  lastWholeAt: number | null;
  /** Failed reads in a row. */
  failures: number;
  /** Whether a whole read that carried the viewer's day start has come back. */
  dayCounted: boolean;
  /**
   * The viewer's next midnight after the day the newest whole read counted
   * (the page's clock), or null. The whole window is read again then, so the
   * day's count starts over at the turn of the day.
   */
  dayEndsAt: number | null;
  /** The replay has just begun on an old read of the whole window: read it again first. */
  wholeWanted: boolean;
}

export interface PollStep {
  scope: 'whole' | 'recent';
  /** When to send it (the page's clock). */
  at: number;
}

/**
 * The next read. A read of the last ten minutes holds no ten-minute cells
 * and no groups by country (contract version 2), so the whole window is read
 * again on its own: first, at once, with the viewer's day start (the server's
 * first read could not know the viewer's midnight); then every 5 minutes; at
 * the viewer's midnight, so the day's count starts over; and as soon as may
 * be when the replay begins on a read more than a minute old. In between, the
 * last ten minutes every 30 seconds. After a failed read the wait grows (30,
 * 60, then 120 seconds) and nothing is sent sooner, whichever read is due.
 */
export function nextPoll(clock: PollClock, now: number): PollStep {
  const wait = securityMapNextPollDelay(clock.failures);
  const afterLast = clock.lastPollAt === null ? now : clock.lastPollAt + wait;
  if (!clock.dayCounted) return { scope: 'whole', at: afterLast };
  const soonest = clock.failures > 0 ? afterLast : now;
  if (clock.wholeWanted) return { scope: 'whole', at: soonest };
  const recentAt = afterLast;
  const every = clock.lastWholeAt === null ? now : clock.lastWholeAt + SECURITY_MAP_WHOLE_POLL_MS;
  const wholeDue = clock.dayEndsAt === null ? every : Math.min(every, clock.dayEndsAt);
  const wholeAt = Math.max(wholeDue, clock.failures > 0 ? afterLast : -Infinity);
  return wholeAt <= recentAt ? { scope: 'whole', at: wholeAt } : { scope: 'recent', at: recentAt };
}

/** A whole read older than this is read again when the replay begins. */
export const REPLAY_REREAD_AFTER_MS = 60_000;

/**
 * Whether the replay's beginning asks for the whole window again: the play
 * has just turned to the replay (the last ten minutes hold nothing), and the
 * newest whole read is more than a minute old, or there is none. Only the
 * turn asks, never every read while the replay goes on.
 */
export function replayWantsWhole(
  wasReplaying: boolean,
  replaying: boolean,
  lastWholeAt: number | null,
  now: number,
): boolean {
  if (!replaying || wasReplaying) return false;
  return lastWholeAt === null || now - lastWholeAt > REPLAY_REREAD_AFTER_MS;
}

/** The viewer's next midnight after the day that began at `dayStart`, or null for no time. */
export function nextLocalMidnight(dayStart: string | null): number | null {
  const at = dayStart === null ? NaN : Date.parse(dayStart);
  if (!Number.isFinite(at)) return null;
  const next = new Date(at);
  next.setHours(24, 0, 0, 0);
  return next.getTime();
}

/** The instant the viewer's own day began, as the poll sends it. */
export function localDayStart(now: Date): string {
  const midnight = new Date(now.getTime());
  midnight.setHours(0, 0, 0, 0);
  return midnight.toISOString();
}

/** How often the last ten minutes are read when all is well (for the words). */
export const RECENT_POLL_MS = SECURITY_MAP_RECENT_POLL_MS;

/* ─────────────────────────────── which view ─────────────────────────────── */

export type MapViewChoice = 'globe' | 'flat';
/** What became of the globe: fine so far, cannot be drawn here, or its context was lost. */
export type GlobeState = 'ok' | 'unavailable' | 'lost';

export interface ViewShown {
  view: MapViewChoice;
  /** Whether the "Globe" choice can be taken. */
  globeOffered: boolean;
  /** Why the flat map is shown in the globe's place, or null. */
  note: string | null;
}

/**
 * The view shown. The flat map whenever the device asks for reduced motion
 * (the globe is never drawn then), when the globe cannot be drawn or stopped
 * drawing, or by the viewer's choice; otherwise the globe.
 */
export function viewShown(
  choice: MapViewChoice,
  reducedMotion: boolean,
  globe: GlobeState,
): ViewShown {
  if (reducedMotion) {
    return { view: 'flat', globeOffered: false, note: SECURITY_MAP_WORDS.globeReducedMotion };
  }
  if (globe === 'unavailable') {
    return { view: 'flat', globeOffered: false, note: SECURITY_MAP_WORDS.globeUnavailable };
  }
  if (globe === 'lost') {
    return { view: 'flat', globeOffered: false, note: SECURITY_MAP_WORDS.globeLost };
  }
  return { view: choice, globeOffered: true, note: null };
}

/** A country's name in English, or its code when the runtime has none. */
export function countryName(code: string): string {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

/** The categories in the record's order, for anything that lists them all. */
export const ALL_CATEGORIES = SECURITY_EVENT_CATEGORIES;
