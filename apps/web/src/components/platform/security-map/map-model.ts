import {
  SECURITY_EVENT_CATEGORIES,
  SECURITY_MAP_EARLY_WHOLE_GAP_MS,
  SECURITY_MAP_RECENT_POLL_MS,
  SECURITY_MAP_WHOLE_POLL_MS,
  SECURITY_MAP_WORDS,
  dayStartInZone,
  isSecurityMapLateSource,
  nextDayStartInZone,
  securityMapCountWords,
  securityMapFeedWords,
  securityMapIsFloor,
  securityMapNextPollDelay,
  securityMapNextWholeDelay,
  securityMapShownCategories,
  type SecurityEventCategory,
  type SecurityMapArc,
  type SecurityMapFeedRow,
  type SecurityMapPlan,
  type SecurityMapStopReason,
  type SecurityMapWholeRead,
} from '@stockpilot/core';

import { facingOf, heatOf, type ArcTiming, type GlobeFacing } from './globe-math';
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
 * The one look of every kind the map's numbers leave out: a grey mark, the
 * same for each such kind, so neither the list nor the map tells which
 * hidden kind an entry was recorded under. Used by the flagged list and, since
 * the owner's decision of 2026-11-24, by the flagged sign-in alerts drawn on
 * the map from that list (an arc with no category: grey, hollow, dashed).
 */
export const HIDDEN_KIND_LOOK: CategoryLook = look('#9aa6b8', 'triangle');

/** An arc's look: its kind's own, or the grey one for a flagged sign-in alert (no category). */
export function arcLookOf(category: SecurityEventCategory | null): CategoryLook {
  return category === null ? HIDDEN_KIND_LOOK : CATEGORY_LOOKS[category];
}

/**
 * An entry's look in the flagged list: its kind's own when the map shows
 * that kind, else the grey one. A kind the map does not show arrives with no
 * category (null).
 */
export function flaggedLookOf(category: SecurityEventCategory | null): CategoryLook {
  return category !== null && securityMapShownCategories().includes(category)
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

/* ─────────────────────────── the stage's height ─────────────────────────── */

/** The stage's height on a screen wider than a phone: 68% of the window, from 420 to 760 px (brief A). */
export const STAGE_MIN_PX = 420;
export const STAGE_MAX_PX = 760;
const STAGE_SHARE = 0.68;
/** Room left under the caption's last line at the fold. */
const FOLD_SPARE_PX = 8;

/**
 * The stage's height, so that everything from the counters to the end of the
 * caption is above the fold (lab walk 2, F1): 68% of the window (420 to 760
 * px), made shorter when the caption under it would otherwise fall below the
 * window's bottom, but never under 420 px. `stageTop` is where the stage
 * starts on the page, `below` how far the caption's end is under the
 * stage's (the gap and the caption, whatever its sentences).
 */
export function stageHeightFor(fit: { viewport: number; stageTop: number; below: number }): number {
  const wanted = Math.min(STAGE_MAX_PX, Math.max(STAGE_MIN_PX, STAGE_SHARE * fit.viewport));
  const room = fit.viewport - fit.stageTop - fit.below - FOLD_SPARE_PX;
  return Math.round(Math.max(STAGE_MIN_PX, Math.min(wanted, room)));
}

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
  /** The arc's events (its mark's size and its country's glow come from them). */
  events: number;
}

/** The drawn arcs as the globe takes them. A flagged arc is never handed over as blocked. */
export function globeArcsOf(drawn: readonly DrawnArc[]): GlobeArc[] {
  return drawn.map(({ arc, from }) => {
    const look = arcLookOf(arc.category);
    return {
      key: arc.key,
      from,
      rgb: look.rgb,
      width: arc.width,
      flagged: arc.outcome === 'flagged',
      shape: SHAPE_INDEX[look.shape],
      events: arc.events,
    };
  });
}

/**
 * Every arc of the play with a place: the live arcs, or every hour of the
 * replay (so the globe faces the replay as a whole and does not swing at
 * each hour), or the one still picture when the play is stopped.
 */
export function planDrawnArcs(plan: SecurityMapPlan, stopped: boolean): DrawnArc[] {
  if (stopped || plan.mode === 'still') return drawnArcs(plan.picture);
  if (plan.mode === 'live') return drawnArcs(plan.live);
  return drawnArcs(plan.steps.flatMap((step) => step.arcs));
}

/** Each source country's events in a set of arcs, by ISO code. */
function eventsByCountry(
  drawn: readonly DrawnArc[],
): Map<string, { from: LonLat; events: number }> {
  const out = new Map<string, { from: LonLat; events: number }>();
  for (const { arc, from } of drawn) {
    const held = out.get(arc.country);
    if (held) held.events += arc.events;
    else out.set(arc.country, { from, events: arc.events });
  }
  return out;
}

/**
 * Where the globe faces for these arcs (globe-math facingOf): as near the
 * weighted middle of their sources as it can while StockPilot stays in
 * view; StockPilot itself when there is nothing to draw.
 */
export function focusOf(drawn: readonly DrawnArc[]): GlobeFacing {
  const places = [...eventsByCountry(drawn).values()].map(({ from, events }) => ({
    lonLat: from,
    weight: Math.sqrt(events),
  }));
  return facingOf(places, STOCKPILOT_LON_LAT);
}

/** How strongly each source country's land glows, by its share of the arcs on the map (log scale). */
export function heatByCountry(drawn: readonly DrawnArc[]): Map<string, number> {
  const byCountry = eventsByCountry(drawn);
  const most = Math.max(0, ...[...byCountry.values()].map((c) => c.events));
  const out = new Map<string, number>();
  for (const [code, { events }] of byCountry) out.set(code, heatOf(events, most));
  return out;
}

/** A span of time as instants: from inclusive, to exclusive. */
export interface TimeSpan {
  fromMs: number;
  toMs: number;
}

/**
 * The span of time the stage draws this moment: the replay's hour; the live
 * play's last ten minutes (from the newest read's `liveFrom`); for the still
 * picture of a replay, the whole window. Null when nothing is drawn.
 */
export function stageSpan(
  plan: SecurityMapPlan,
  stage: Stage,
  liveFrom: string | null,
): TimeSpan | null {
  if (stage.timing === 'replay') {
    const step = plan.steps[stage.stepIndex];
    return step ? { fromMs: step.fromMs, toMs: step.toMs } : null;
  }
  if (plan.mode === 'live') {
    const fromMs = liveFrom === null ? Number.NaN : Date.parse(liveFrom);
    return Number.isFinite(fromMs) ? { fromMs, toMs: Number.POSITIVE_INFINITY } : null;
  }
  if (plan.mode === 'replay') {
    return { fromMs: Number.NEGATIVE_INFINITY, toMs: Number.POSITIVE_INFINITY };
  }
  return null;
}

/**
 * The stage's ticker entry: the newest feed entry the map draws this moment.
 * Its country, kind and outcome are an arc on the stage, its minute is inside
 * the span drawn, and in the live play it is not from a late source (the
 * live play leaves those out). Null when no entry is: the ticker then shows
 * nothing rather than an entry the map does not draw.
 */
export function tickerRowOf(
  rows: readonly SecurityMapFeedRow[],
  drawn: readonly DrawnArc[],
  span: TimeSpan | null,
  live: boolean,
): SecurityMapFeedRow | null {
  if (span === null || drawn.length === 0) return null;
  const keys = new Set(drawn.map(({ arc }) => `${arc.country}|${arc.category}|${arc.outcome}`));
  let best: SecurityMapFeedRow | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const w = securityMapFeedWords(row);
    if (w.outcome === 'allowed' || w.country === null) continue;
    if (live && isSecurityMapLateSource(w.source)) continue;
    const ms = Date.parse(row[1]);
    if (!(ms >= span.fromMs && ms < span.toMs) || ms <= bestMs) continue;
    if (!keys.has(`${w.country}|${w.category}|${w.outcome}`)) continue;
    best = row;
    bestMs = ms;
  }
  return best;
}

/** A source's label on the globe: its country's name and its events in the arcs on the map. */
export interface SourceLabel {
  code: string;
  from: LonLat;
  name: string;
  /** The count in words ("at least 4" where the window's number for the kind is a floor). */
  count: string;
}

/** How many sources get a label on the globe. */
export const SOURCE_LABELS = 5;

/**
 * The top sources of the arcs on the map, by their events, each with its
 * country's name and count. A count says "at least" when any of its arcs is
 * of a kind and outcome whose number the newest whole read marks as a floor.
 */
export function sourceLabels(
  drawn: readonly DrawnArc[],
  whole: SecurityMapWholeRead | null,
  max = SOURCE_LABELS,
): SourceLabel[] {
  const rows = new Map<string, { from: LonLat; events: number; floor: boolean }>();
  for (const { arc, from } of drawn) {
    // A flagged sign-in alert (no category) says "at least" when one of its entries did.
    const floor =
      arc.category === null
        ? arc.atLeast === true
        : securityMapIsFloor(whole, `totals.${arc.category}.${arc.outcome}`);
    const held = rows.get(arc.country);
    if (held) {
      held.events += arc.events;
      held.floor ||= floor;
    } else rows.set(arc.country, { from, events: arc.events, floor });
  }
  return [...rows.entries()]
    .sort((a, b) => b[1].events - a[1].events || (a[0] < b[0] ? -1 : 1))
    .slice(0, max)
    .map(([code, row]) => ({
      code,
      from: row.from,
      name: countryName(code),
      count: securityMapCountWords(row.events, row.floor),
    }));
}

/**
 * Whether this browser can give the globe a WebGL 2 context, tested on a
 * canvas of its own before three.js is loaded, so a browser without one
 * shows the flat map with no error in its console and never fetches three.js.
 * The test context is given back at once.
 */
export function webglAvailable(
  make: () => HTMLCanvasElement = () => document.createElement('canvas'),
): boolean {
  try {
    const gl = make().getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
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
  /** When a read of the whole window was last sent and came back, good or not, or null. */
  lastWholeTryAt: number | null;
  /** Failed reads in a row, of any kind. */
  failures: number;
  /** Failed reads of the whole window in a row. */
  wholeFailures: number;
  /**
   * The viewer's next midnight after the day the newest whole read counted
   * (the page's clock), or null. The whole window is read again then, so the
   * day's count starts over at the turn of the day.
   */
  dayEndsAt: number | null;
  /** The replay has just begun on an old read of the whole window: read it again first. */
  wholeWanted: boolean;
  /**
   * No read of the whole window has carried the viewer's day start yet (the
   * server's first read cannot know the viewer's midnight): read it at once,
   * so the day's counter is right within a moment of the page opening.
   */
  dayUnread: boolean;
  /**
   * The kept lists hold entries newer than the last good whole read's totals
   * (core's securityMapNewerThanTotals): read the whole window early, but
   * never sooner than SECURITY_MAP_EARLY_WHOLE_GAP_MS after the last whole
   * read started (the coordinator's change of 2026-11-24).
   */
  totalsBehind: boolean;
  /**
   * When the page last sent a read of the whole window (the page's clock), or
   * null before its first. Every whole read after that first waits until
   * SECURITY_MAP_EARLY_WHOLE_GAP_MS after it, whatever asks (review M1).
   */
  lastWholeStartAt: number | null;
}

export interface PollStep {
  scope: 'whole' | 'recent';
  /** When to send it (the page's clock). */
  at: number;
}

/**
 * The next read. A read of the last ten minutes holds no ten-minute cells
 * and no groups by country (contract version 2), so the whole window is read
 * on its own: at once when the page opens, with the viewer's day start (the
 * server's first read could not carry it, so this is the second read of the
 * whole window on open, and the day's counter is right within a moment:
 * QUESTIONS Q22), then 5 minutes after the last good read of it, at the
 * viewer's midnight once a day has been counted, and as soon as may be when
 * the replay begins on a read more than a minute old. After a failed read of the
 * whole window the next waits 2, 4, 8, then 10 minutes from that attempt
 * (review S2), and neither the midnight nor the replay hurries it. When the
 * kept lists hold entries newer than the totals (`totalsBehind`), the whole
 * window is read early, and never against the back-off: so a quiet page
 * reads nothing more. In between, the last ten minutes every 30 seconds,
 * against the last good whole read or alone when there is none. After any
 * failed read the wait grows (30, 60, then 120 seconds) and nothing is sent
 * sooner.
 *
 * THE FLOOR (review M1, 2026-11-24): once the page has sent a whole read,
 * the next one, whatever asks for it (the 5-minute rhythm, the early read,
 * the viewer's midnight, the replay's turn, a tab shown again, the day not
 * yet read), is never sent sooner than 45 seconds after that one was sent.
 * So however wrong a due time is (a midnight that never moves on, say), the
 * page sends at most one whole read per 45 seconds, and a read of the last
 * ten minutes goes in between whenever its 30 seconds come first. The two
 * reads of the whole window on open are not
 * under it: the server's, which the page never sends, and the page's own
 * first, right after it mounts (QUESTIONS Q22), sent while
 * `lastWholeStartAt` is still null; from that send on, every whole read is.
 */
export function nextPoll(clock: PollClock, now: number): PollStep {
  const afterLast =
    clock.lastPollAt === null ? now : clock.lastPollAt + securityMapNextPollDelay(clock.failures);
  let wholeDue: number;
  if (clock.wholeFailures > 0) {
    wholeDue =
      clock.lastWholeTryAt === null
        ? now
        : clock.lastWholeTryAt + securityMapNextWholeDelay(clock.wholeFailures);
  } else if (clock.wholeWanted || clock.dayUnread) {
    wholeDue = now;
  } else {
    const every = clock.lastWholeAt === null ? now : clock.lastWholeAt + SECURITY_MAP_WHOLE_POLL_MS;
    wholeDue = clock.dayEndsAt === null ? every : Math.min(every, clock.dayEndsAt);
    // New events past the totals: the whole window early, as soon as the floor allows.
    if (clock.totalsBehind) wholeDue = Math.min(wholeDue, now);
  }
  // Every whole read after the page's first: at most one start per gap.
  if (clock.lastWholeStartAt !== null) {
    wholeDue = Math.max(wholeDue, clock.lastWholeStartAt + SECURITY_MAP_EARLY_WHOLE_GAP_MS);
  }
  const wholeAt = Math.max(wholeDue, clock.failures > 0 ? afterLast : -Infinity);
  return wholeAt <= afterLast
    ? { scope: 'whole', at: wholeAt }
    : { scope: 'recent', at: afterLast };
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

const HOUR_MS = 60 * 60 * 1000;

/**
 * The viewer's next midnight after the day that holds `dayStart` (the start
 * of the day the newest whole read counted), or null for no time: in `zone`
 * (the zone the page's times are in) when given, else the browser's own. It
 * is always strictly later than `dayStart`: should a zone's rules ever answer
 * one that is not (review M1: the day start never moving on), the answer is
 * looked for again an hour on, and on, until it is; none within two days is
 * no time.
 */
export function nextLocalMidnight(dayStart: string | null, zone?: string): number | null {
  const at = dayStart === null ? NaN : Date.parse(dayStart);
  if (!Number.isFinite(at)) return null;
  const nextAfter = (from: number): number => {
    if (zone !== undefined) return nextDayStartInZone(from, zone);
    const next = new Date(from);
    next.setHours(24, 0, 0, 0);
    return next.getTime();
  };
  let next = nextAfter(at);
  for (let probe = at, steps = 0; Number.isFinite(next) && next <= at && steps < 48; steps += 1) {
    probe += HOUR_MS;
    next = nextAfter(probe);
  }
  return Number.isFinite(next) && next > at ? next : null;
}

/**
 * The instant the viewer's own day began, as the poll sends it: the midnight
 * of `zone` when given (the zone the page's times are in, so the day's
 * counter and the times beside it agree), else the browser's.
 */
export function localDayStart(now: Date, zone?: string): string {
  if (zone !== undefined) {
    const start = dayStartInZone(now, zone);
    if (Number.isFinite(start)) return new Date(start).toISOString();
  }
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
 * The view shown: the globe, unless it cannot be drawn here or stopped
 * drawing, or the viewer chose the flat map. Under reduced motion the globe
 * is drawn still (no flight, no pulse, no turning on its own); the island
 * hands it the still picture and the pill says so.
 */
export function viewShown(choice: MapViewChoice, globe: GlobeState): ViewShown {
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
