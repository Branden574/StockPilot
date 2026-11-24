'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  SECURITY_MAP_HEALTH_AT_START,
  SECURITY_MAP_MAX_FEED,
  SECURITY_MAP_MAX_FLAGGED_FEED,
  SECURITY_MAP_READ_LIMIT_MS,
  planSecurityMapPlayback,
  readSecurityMapPollResult,
  securityMapHealthAfter,
  securityMapMergeFeed,
  securityMapNewerThanTotals,
  securityMapWindowStartNow,
  type SecurityMapFeedRow,
  type SecurityMapFlaggedRow,
  type SecurityMapHealth,
  type SecurityMapPlan,
  type SecurityMapRefusal,
  type SecurityMapView,
  type SecurityMapWholeRead,
} from '@stockpilot/core';

import { localDayStart, nextLocalMidnight, nextPoll, replayWantsWhole } from './map-model';

/**
 * THE MAP'S POLL: one small hook local to the island (no shared polling
 * hook). It asks the console's Server Action for the map's data. The
 * server's first read seeds the page; right after the island mounts, the
 * whole window is read once more with the viewer's day start, so the day's
 * counter is right within a moment (QUESTIONS Q22: two reads of the whole
 * window on open); then the last ten minutes every 30 seconds, and the whole
 * window again 5 minutes after its last good read, at the viewer's midnight,
 * and when the replay begins on a read more than a minute old (map-model.ts
 * nextPoll). After a failed read of the
 * whole window the next waits 2, 4, 8, then 10 minutes, and the reads of the
 * last ten minutes go on in between (review S2). A read of the last ten
 * minutes only adds the newest live arcs, and merges its feed entries into
 * the two lists kept since the newest whole read (an entry the poll does not
 * carry stays); it replaces none of the whole read's numbers or lists.
 *
 * One request at a time; a read with no answer within
 * SECURITY_MAP_READ_LIMIT_MS (20 s) is counted out, the page says it is not
 * updating, and its answer, if one ever comes, is ignored (review S1).
 * Nothing is sent while the tab is hidden, and when it comes back an overdue
 * read is sent at once; after a failed read the wait grows. Every answer is
 * read again in the browser (core's readSecurityMapPollResult): a shape this
 * build does not know is a failed read, never a picture.
 *
 * NEW EVENTS PAST THE TOTALS (the coordinator's change of 2026-11-24): when
 * the kept lists hold an entry, or the newest poll a live cell, newer than
 * the last good whole read's totals (core's securityMapNewerThanTotals,
 * which only a poll can make true), the
 * whole window is read early, but never sooner than 45 seconds after the
 * last whole read was SENT, and under every rule above (one read at a time,
 * nothing while hidden, the read limit, the back-off after a failed whole
 * read). A quiet page reads nothing more; a busy one at most one whole read
 * per 45 seconds. Until it lands the page says the totals are being counted
 * again (security-map-client.tsx).
 *
 * The plan is worked out with the kept flagged list as well: its flagged
 * sign-in alerts are drawn (owner's decision of 2026-11-24).
 */

export interface SecurityMapPollState {
  /** The newest read of the whole window, or null when none has come back. */
  whole: SecurityMapWholeRead | null;
  /** The newest read of the last ten minutes, or null. */
  recent: SecurityMapView | null;
  /**
   * The two feeds as kept: the newest whole read's, with every poll since
   * merged in by the key the server made from each entry's identity. A new
   * read of the whole window starts them again.
   */
  feed: readonly SecurityMapFeedRow[];
  flaggedFeed: readonly SecurityMapFlaggedRow[];
  /** Flagged entries fell off the kept list's end behind newer ones. */
  flaggedCut: boolean;
  health: SecurityMapHealth;
  /** A whole read that carried the viewer's day start has come back. */
  dayStartAsked: boolean;
  /** The database would not read the window asked for (the last read only). */
  refusedWindow: SecurityMapRefusal | null;
  /** The page's clock: when the last read came back, and the last good whole read. */
  lastPollAt: number | null;
  lastWholeAt: number | null;
  /** When a read of the whole window last came back, good or not (the server's first read too). */
  lastWholeTryAt: number | null;
  /** Failed reads of the whole window in a row: the next one waits longer (review S2). */
  wholeFailures: number;
}

export type SecurityMapPollInput = { scope: 'whole' | 'recent'; dayStart: string | null };
export type SecurityMapPoll = (input: SecurityMapPollInput) => Promise<unknown>;

/**
 * The state from the server's first read of the whole window. It could not
 * carry the viewer's day start, so the island reads the whole window again
 * at once with it (QUESTIONS Q22), and the day is counted by that read.
 * A failed one is a failed read of the whole window: the last ten minutes
 * are read at once and run alone, and the whole window is tried again after
 * its back-off.
 */
export function initialPollState(initial: unknown, nowMs: number): SecurityMapPollState {
  const read = readSecurityMapPollResult(initial);
  const base: SecurityMapPollState = {
    whole: null,
    recent: null,
    feed: [],
    flaggedFeed: [],
    flaggedCut: false,
    health: SECURITY_MAP_HEALTH_AT_START,
    dayStartAsked: false,
    refusedWindow: null,
    lastPollAt: null,
    lastWholeAt: null,
    lastWholeTryAt: nowMs,
    wholeFailures: 1,
  };
  if (!read.ok) {
    return {
      ...base,
      health: securityMapHealthAfter(
        base.health,
        read.reason === 'refused' ? 'refused' : 'failed',
        nowMs,
      ),
    };
  }
  if (read.view === null) {
    return {
      ...base,
      refusedWindow: read.refusedWindow,
      health: securityMapHealthAfter(base.health, 'failed', nowMs),
    };
  }
  if (read.view.scope !== 'whole' || read.view.whole === null) {
    return { ...base, health: securityMapHealthAfter(base.health, 'failed', nowMs) };
  }
  return {
    ...base,
    whole: read.view as SecurityMapWholeRead,
    feed: read.view.feed,
    flaggedFeed: read.view.flaggedFeed,
    health: securityMapHealthAfter(base.health, 'ok', nowMs),
    lastPollAt: nowMs,
    lastWholeAt: nowMs,
    wholeFailures: 0,
  };
}

/**
 * The state after one read came back. A read of the last ten minutes never
 * replaces the whole window's numbers, table or replay, nor the feeds kept
 * from it: it adds the newest live arcs, and its feed entries are merged into
 * the kept lists. A read of the whole window starts the lists again from its
 * own. An answer of the wrong scope is a failed read.
 */
export function pollStateAfter(
  state: SecurityMapPollState,
  scope: 'whole' | 'recent',
  raw: unknown,
  nowMs: number,
  sentDayStart: boolean,
): SecurityMapPollState {
  const read = readSecurityMapPollResult(raw);
  // A read of the whole window that fails counts toward its own back-off.
  const next =
    scope === 'whole'
      ? {
          ...state,
          lastPollAt: nowMs,
          lastWholeTryAt: nowMs,
          wholeFailures: state.wholeFailures + 1,
        }
      : { ...state, lastPollAt: nowMs };
  if (!read.ok) {
    return {
      ...next,
      health: securityMapHealthAfter(
        state.health,
        read.reason === 'refused' ? 'refused' : 'failed',
        nowMs,
      ),
    };
  }
  if (read.view === null) {
    return {
      ...next,
      refusedWindow: read.refusedWindow,
      health: securityMapHealthAfter(state.health, 'failed', nowMs),
    };
  }
  const view = read.view;
  if (view.scope !== scope || (scope === 'whole') !== (view.whole !== null)) {
    return { ...next, health: securityMapHealthAfter(state.health, 'failed', nowMs) };
  }
  const health = securityMapHealthAfter(state.health, 'ok', nowMs);
  if (scope === 'recent') {
    const fromMs = securityMapWindowStartNow(state.whole, view);
    const feed = securityMapMergeFeed(state.feed, view.feed, fromMs, SECURITY_MAP_MAX_FEED);
    const flagged = securityMapMergeFeed(
      state.flaggedFeed,
      view.flaggedFeed,
      fromMs,
      SECURITY_MAP_MAX_FLAGGED_FEED,
    );
    return {
      ...next,
      recent: view,
      feed: feed.rows,
      flaggedFeed: flagged.rows,
      flaggedCut: state.flaggedCut || flagged.cut,
      refusedWindow: null,
      health,
    };
  }
  return {
    ...next,
    whole: view as SecurityMapWholeRead,
    feed: view.feed,
    flaggedFeed: view.flaggedFeed,
    flaggedCut: false,
    refusedWindow: null,
    health,
    lastWholeAt: nowMs,
    wholeFailures: 0,
    dayStartAsked: state.dayStartAsked || sentDayStart,
  };
}

/**
 * The state after a read that did not answer within SECURITY_MAP_READ_LIMIT_MS
 * (review S1): a failure that stops the play at once ("Not updating since
 * ..."), and, for a read of the whole window, a failed attempt at it. What
 * the page shows stays as it was; nothing is made up in its place.
 */
export function pollStateAfterTimeout(
  state: SecurityMapPollState,
  scope: 'whole' | 'recent',
  nowMs: number,
): SecurityMapPollState {
  const health = securityMapHealthAfter(state.health, 'timed_out', nowMs);
  return scope === 'whole'
    ? {
        ...state,
        health,
        lastPollAt: nowMs,
        lastWholeTryAt: nowMs,
        wholeFailures: state.wholeFailures + 1,
      }
    : { ...state, health, lastPollAt: nowMs };
}

export interface SecurityMapPollResult {
  state: SecurityMapPollState;
  /** Core's playback plan for the two newest reads, worked out here once. */
  plan: SecurityMapPlan;
}

/**
 * The poll, run while the island is mounted. `hidden` stops it (a hidden
 * tab); the read in flight, if any, still lands, unless it was counted out
 * at the read limit first.
 */
export function useSecurityMapPoll(
  initial: unknown,
  poll: SecurityMapPoll,
  hidden: boolean,
  /** The zone the page's times are in: its midnight starts the day the read counts. */
  zone?: string,
): SecurityMapPollResult {
  const [state, setState] = useState(() => initialPollState(initial, Date.now()));
  const plan = useMemo(
    () => planSecurityMapPlayback(state.whole, state.recent, state.flaggedFeed),
    [state.whole, state.recent, state.flaggedFeed],
  );
  const replaying = plan.mode === 'replay';
  const inFlight = useRef(false);
  const mounted = useRef(true);
  // Which read is out: a read counted out at the limit moves it on, so its
  // late answer is known for what it is and ignored.
  const readId = useRef(0);
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The turn to the replay, seen once: whether the play was replaying when
  // last looked at, and whether that turn asks for the whole window again.
  const wasReplaying = useRef(false);
  const wholeWanted = useRef(false);
  // When the last read of the whole window was sent: an early one waits 45 s from it.
  const wholeStartedAt = useRef<number | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (limit.current !== null) clearTimeout(limit.current);
      limit.current = null;
    };
  }, []);

  useEffect(() => {
    if (replaying !== wasReplaying.current) {
      wholeWanted.current = replayWantsWhole(
        wasReplaying.current,
        replaying,
        state.lastWholeAt,
        Date.now(),
      );
      wasReplaying.current = replaying;
    }
    if (hidden || inFlight.current) return undefined;
    const step = nextPoll(
      {
        lastPollAt: state.lastPollAt,
        lastWholeAt: state.lastWholeAt,
        failures: state.health.failures,
        lastWholeTryAt: state.lastWholeTryAt,
        wholeFailures: state.wholeFailures,
        dayEndsAt: state.dayStartAsked
          ? nextLocalMidnight(state.whole?.whole.dayStart ?? null, zone)
          : null,
        wholeWanted: wholeWanted.current,
        dayUnread: !state.dayStartAsked,
        totalsBehind: securityMapNewerThanTotals(
          state.whole,
          [...state.feed, ...state.flaggedFeed],
          state.recent,
        ),
        lastWholeStartAt: wholeStartedAt.current,
      },
      Date.now(),
    );
    const timer = setTimeout(
      () => {
        if (inFlight.current) return;
        inFlight.current = true;
        const scope = step.scope;
        if (scope === 'whole') {
          wholeWanted.current = false;
          wholeStartedAt.current = Date.now();
        }
        const dayStart = scope === 'whole' ? localDayStart(new Date(), zone) : null;
        readId.current += 1;
        const id = readId.current;
        limit.current = setTimeout(() => {
          limit.current = null;
          if (readId.current !== id) return;
          // Counted out: the next read may go (after the back-off), and this
          // one's answer, if it ever comes, belongs to no read.
          readId.current += 1;
          inFlight.current = false;
          if (!mounted.current) return;
          setState((prev) => pollStateAfterTimeout(prev, scope, Date.now()));
        }, SECURITY_MAP_READ_LIMIT_MS);
        void Promise.resolve()
          .then(() => poll({ scope, dayStart }))
          .then(
            (raw) => raw,
            () => null,
          )
          .then((raw) => {
            if (readId.current !== id) return;
            if (limit.current !== null) clearTimeout(limit.current);
            limit.current = null;
            inFlight.current = false;
            if (!mounted.current) return;
            setState((prev) => pollStateAfter(prev, scope, raw, Date.now(), dayStart !== null));
          });
      },
      Math.max(0, step.at - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [hidden, state, poll, replaying, zone]);

  return { state, plan };
}
