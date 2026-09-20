/**
 * User Timing marks for ONE in-app navigation, and the arithmetic between them.
 *
 *   intent    the app first had a reason to warm a route (hover / focus /
 *             pointer-down on a sidebar link)
 *   click     the person committed to it
 *   feedback  the first frame that told them "I heard you" (link spinner or
 *             the top progress bar)
 *   useful    the destination's REAL content mounted: a data row, a detail
 *             heading, a rich empty state. Never a loading.tsx or a skeleton.
 *
 * The marks land on the browser's own performance timeline (owner brief,
 * performance program 2026-09: "Prefer the Performance API"), so DevTools and
 * a Playwright trace show them with no extra tooling. The summary of each
 * finished navigation is handed to whoever registered with
 * `onNavigationMeasured`; `rum.ts` turns it into an analytics event.
 *
 * PRIVACY. A mark's `detail` is `{ route }` and the route is always a
 * TEMPLATE (`/dashboard/inventory/[id]`), never a URL: no ids, no query, no
 * search terms. Every path that enters this module goes through
 * `toRouteTemplate` before it is stored or emitted.
 *
 * COST. No React, no observers, no timers. A few numbers in module scope and
 * one `visibilitychange` listener. Every export is a no-op on the server and
 * none of them can throw: instrumentation must never be the reason a
 * navigation fails or a page errors.
 */
import { toRouteTemplate } from './route-template';

export const PERF_MARK = {
  intent: 'stockpilot:navigation-intent',
  click: 'stockpilot:navigation-click',
  feedback: 'stockpilot:navigation-feedback',
  useful: 'stockpilot:navigation-useful',
} as const;

export const PERF_MEASURE = {
  clickToFeedback: 'stockpilot:click-to-feedback',
  clickToUseful: 'stockpilot:click-to-useful',
} as const;

export interface SoftNavigationSummary {
  kind: 'soft-nav';
  fromRoute: string;
  toRoute: string;
  /** Null when no feedback frame was observed before the content arrived. */
  clickToFeedbackMs: number | null;
  clickToUsefulMs: number;
  /** How long before the click the route was first warmed; null when it never was. */
  intentLeadMs: number | null;
}

export interface HardLoadSummary {
  kind: 'hard-load';
  route: string;
  /** `performance.now()` at useful, i.e. measured from the document's navigation start. */
  usefulMs: number;
}

export type NavigationSummary = SoftNavigationSummary | HardLoadSummary;
export type NavigationListener = (summary: NavigationSummary) => void;

/**
 * A "navigation" longer than this was not a navigation: the laptop slept, the
 * tab sat behind another window, a debugger was paused. It would own the p95
 * of every chart it touched, so it is dropped rather than reported.
 */
const MAX_PLAUSIBLE_MS = 60_000;

/**
 * Intent is remembered per route for this long. The sidebar fires intent on
 * pointer-enter, again on pointer-down and again on focus, all for ONE
 * approach to ONE link; only the first of them started the prefetch, so only
 * the first may set the clock. Keeping the LAST one instead would report the
 * pointer-down-to-click gap (tens of milliseconds) on every navigation and
 * make intent warming look useless no matter how early the hover was. Past the
 * window, a repeat is a new approach and replaces the old time; at click time
 * an intent older than this is ignored, so a hover from five minutes ago is
 * never credited to a breadcrumb click on the same route.
 */
const INTENT_WINDOW_MS = 30_000;
/** Distinct routes remembered. A keyboard user tabbing down the sidebar touches every link. */
const MAX_INTENTS = 20;
/** Summaries held for a listener that has not registered yet (effect ordering on first paint). */
const MAX_UNDELIVERED = 5;
/** `event.timeStamp` is trusted as the click time only when it is this close to now. */
const MAX_EVENT_AGE_MS = 10_000;

interface InFlightNavigation {
  toRoute: string;
  fromRoute: string;
  clickAt: number;
  feedbackAt: number | null;
  intentAt: number | null;
  /** The tab was hidden at some point after the click: timers and frames were throttled. */
  hidden: boolean;
}

let inFlight: InFlightNavigation | null = null;
const intents = new Map<string, number>();
const listeners = new Set<NavigationListener>();
let undelivered: NavigationSummary[] = [];
/**
 * A hard load can be reported once, and only while nothing else has happened
 * in this document: the first click or the first useful call closes it. Without
 * that, a back-button return to the landing route minutes later (no click, so
 * no in-flight navigation) would be reported as a multi-minute "page load".
 */
let hardLoadOpen = true;
/** The tab has been hidden at some point since this module loaded. */
let everHidden = false;
let visibilityWired = false;

function canMeasure(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof performance !== 'undefined' &&
    typeof performance.now === 'function'
  );
}

function onVisibilityChange(): void {
  if (document.visibilityState !== 'hidden') return;
  everHidden = true;
  if (inFlight) inFlight.hidden = true;
}

/**
 * Wired at module load on the client, so a hard load that was hidden before
 * its content arrived is known about. The entry points call it again; that
 * costs one boolean check and covers a module that was first evaluated
 * somewhere `document` was not ready to take a listener.
 */
function wireVisibility(): void {
  if (visibilityWired) return;
  try {
    if (document.visibilityState === 'hidden') everHidden = true;
    document.addEventListener('visibilitychange', onVisibilityChange);
    visibilityWired = true;
  } catch {
    /* an exotic embedder without a document event target: measure without the guard */
  }
}

function mark(name: string, route: string, at: number): void {
  try {
    performance.mark(name, { startTime: at, detail: { route } });
  } catch {
    /* User Timing Level 3 is missing or the timeline refused the entry: the numbers still work */
  }
}

function measure(name: string, route: string, start: number, end: number): void {
  try {
    performance.measure(name, { start, end, detail: { route } });
  } catch {
    /* see mark() */
  }
}

/**
 * The timeline only ever holds ONE navigation's story. User Timing entries are
 * never evicted by the browser, and a day-long warehouse session hovers the
 * sidebar thousands of times; clearing at each click keeps the buffer bounded.
 */
function clearTimeline(): void {
  try {
    for (const name of Object.values(PERF_MARK)) performance.clearMarks(name);
    for (const name of Object.values(PERF_MEASURE)) performance.clearMeasures(name);
  } catch {
    /* see mark() */
  }
}

function deliver(summary: NavigationSummary): void {
  if (listeners.size === 0) {
    undelivered.push(summary);
    if (undelivered.length > MAX_UNDELIVERED) undelivered = undelivered.slice(-MAX_UNDELIVERED);
    return;
  }
  for (const listener of listeners) {
    try {
      listener(summary);
    } catch {
      /* a broken listener must not break the page, or the next listener */
    }
  }
}

/**
 * The route the DOCUMENT was loaded on, as a template. Read from Navigation
 * Timing rather than `location`, because by the time anything asks, a soft
 * navigation may already have moved the address bar.
 */
export function landingRoute(): string | null {
  if (!canMeasure()) return null;
  try {
    const [entry] = performance.getEntriesByType('navigation');
    if (entry && typeof entry.name === 'string' && entry.name.length > 0) {
      return toRouteTemplate(entry.name);
    }
  } catch {
    /* fall through to null: "unknown" is an honest answer */
  }
  return null;
}

/**
 * Registers a listener for finished navigations and returns its unsubscribe.
 * Summaries measured before the first listener existed are delivered to it
 * immediately: on a hard load the content's effect can run before the effect
 * that registers the listener, and that first measurement is the one that
 * matters most.
 */
export function onNavigationMeasured(listener: NavigationListener): () => void {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  if (undelivered.length > 0) {
    const pending = undelivered;
    undelivered = [];
    for (const summary of pending) {
      try {
        listener(summary);
      } catch {
        /* see deliver() */
      }
    }
  }
  return () => {
    listeners.delete(listener);
  };
}

/** The app has a reason to warm `href`: hover, focus or pointer-down on a link to it. */
export function markNavigationIntent(href: string): void {
  if (!canMeasure()) return;
  try {
    wireVisibility();
    const route = toRouteTemplate(href);
    const now = performance.now();
    const known = intents.get(route);
    // Same approach to the same link: the first signal keeps the clock. See INTENT_WINDOW_MS.
    if (known !== undefined && now - known <= INTENT_WINDOW_MS) return;
    intents.delete(route);
    intents.set(route, now);
    if (intents.size > MAX_INTENTS) {
      const oldest = intents.keys().next().value;
      if (oldest !== undefined) intents.delete(oldest);
    }
    mark(PERF_MARK.intent, route, now);
  } catch {
    /* never break a hover */
  }
}

/**
 * The person clicked an in-app link to `href`. Starts the one in-flight
 * navigation; a click that arrives before the previous one finished replaces
 * it (the person changed their mind, and the first destination will never
 * report useful).
 *
 * `eventTimeStamp` is the click event's own `timeStamp`. It is when the input
 * happened, not when the main thread got round to the handler, so it includes
 * the input delay a busy page adds. It is only believed when it is on the
 * `performance.now()` clock and recent; anything else falls back to now.
 */
export function markNavigationClick(href: string, eventTimeStamp?: number): void {
  if (!canMeasure()) return;
  try {
    wireVisibility();
    hardLoadOpen = false;
    const now = performance.now();
    const clickAt =
      typeof eventTimeStamp === 'number' &&
      Number.isFinite(eventTimeStamp) &&
      eventTimeStamp > 0 &&
      eventTimeStamp <= now &&
      now - eventTimeStamp <= MAX_EVENT_AGE_MS
        ? eventTimeStamp
        : now;
    const toRoute = toRouteTemplate(href);
    const fromRoute = toRouteTemplate(window.location.pathname);
    const intentAt = intents.get(toRoute);
    const intentIsFresh =
      intentAt !== undefined && intentAt <= clickAt && clickAt - intentAt <= INTENT_WINDOW_MS;
    intents.delete(toRoute);

    inFlight = {
      toRoute,
      fromRoute,
      clickAt,
      feedbackAt: null,
      intentAt: intentIsFresh ? intentAt : null,
      hidden: document.visibilityState === 'hidden',
    };

    clearTimeline();
    // Re-emitted after the clear, at its ORIGINAL time, so the timeline reads
    // intent -> click -> feedback -> useful for the navigation on screen.
    if (inFlight.intentAt !== null) mark(PERF_MARK.intent, toRoute, inFlight.intentAt);
    mark(PERF_MARK.click, toRoute, clickAt);
  } catch {
    /* never break a click */
  }
}

/** The first visible acknowledgement of the click. Later calls for the same click are ignored. */
export function markNavigationFeedback(): void {
  if (!canMeasure()) return;
  try {
    if (!inFlight || inFlight.feedbackAt !== null) return;
    const now = performance.now();
    inFlight.feedbackAt = now;
    mark(PERF_MARK.feedback, inFlight.toRoute, now);
  } catch {
    /* never break a frame */
  }
}

/**
 * Real content for `pathname` has mounted.
 *
 * Finishes the in-flight navigation ONLY when `pathname` is the route that was
 * clicked: content that streams into the page being LEFT, or a redirect to
 * somewhere else, must not close a navigation it does not belong to. With
 * nothing in flight this is a hard load (or a back/forward or `router.push`
 * navigation, which have no click and are not measured); the mark is still
 * emitted, and the first one in the document is reported as the hard load when
 * it is for the route the document was loaded on.
 */
export function markNavigationUseful(pathname: string | null | undefined): void {
  if (!canMeasure()) return;
  try {
    wireVisibility();
    const route = toRouteTemplate(pathname);
    const now = performance.now();
    const canBeHardLoad = hardLoadOpen;
    hardLoadOpen = false;

    // An in-flight navigation this old was abandoned (a redirect landed
    // somewhere else, the laptop slept). Forget it, so content that mounts now
    // is not timed against a click from another era.
    if (inFlight && now - inFlight.clickAt > MAX_PLAUSIBLE_MS) inFlight = null;

    if (inFlight) {
      if (route !== inFlight.toRoute) return;
      const nav = inFlight;
      inFlight = null;
      mark(PERF_MARK.useful, route, now);
      const clickToUsefulMs = now - nav.clickAt;
      if (nav.hidden || document.visibilityState === 'hidden') return;
      if (!(clickToUsefulMs >= 0)) return;
      // Feedback that lands AFTER the content is not feedback: the person was
      // already looking at the page (a cached route can commit before the
      // progress bar's frame). Report "none seen" rather than a number larger
      // than click-to-useful.
      const feedbackAt = nav.feedbackAt !== null && nav.feedbackAt <= now ? nav.feedbackAt : null;
      if (feedbackAt !== null) {
        measure(PERF_MEASURE.clickToFeedback, route, nav.clickAt, feedbackAt);
      }
      measure(PERF_MEASURE.clickToUseful, route, nav.clickAt, now);
      deliver({
        kind: 'soft-nav',
        fromRoute: nav.fromRoute,
        toRoute: nav.toRoute,
        clickToFeedbackMs: feedbackAt !== null ? feedbackAt - nav.clickAt : null,
        clickToUsefulMs,
        intentLeadMs: nav.intentAt !== null ? nav.clickAt - nav.intentAt : null,
      });
      return;
    }

    mark(PERF_MARK.useful, route, now);
    if (!canBeHardLoad) return;
    if (everHidden || document.visibilityState === 'hidden') return;
    if (now > MAX_PLAUSIBLE_MS) return;
    // Unknown landing route (no Navigation Timing entry) is not grounds to
    // guess: nothing else has happened in this document yet, so the first
    // useful content IS the landing page's.
    const landed = landingRoute();
    if (landed !== null && landed !== route) return;
    deliver({ kind: 'hard-load', route, usefulMs: now });
  } catch {
    /* never break a render */
  }
}

/**
 * Test seam: a fresh document, as far as this module can tell. Forgets
 * listeners too. The `visibilitychange` wiring is deliberately left alone: it
 * is one listener on one document, and re-adding it would only risk two.
 * Not for application code.
 */
export function __resetForTests(): void {
  inFlight = null;
  intents.clear();
  listeners.clear();
  undelivered = [];
  hardLoadOpen = true;
  everHidden = false;
}

if (canMeasure()) wireVisibility();
