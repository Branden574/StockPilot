'use client';

import { useEffect, useRef, useState } from 'react';

import {
  SECURITY_MAP_HEALTH_AT_START,
  readSecurityMapPollResult,
  securityMapHealthAfter,
  type SecurityMapHealth,
  type SecurityMapRefusal,
  type SecurityMapView,
  type SecurityMapWholeRead,
} from '@stockpilot/core';

import { localDayStart, nextPoll } from './map-model';

/**
 * THE MAP'S POLL: one small hook local to the island (no shared polling
 * hook). It asks the console's Server Action for the map's data: the whole
 * window with the viewer's day start at once, then the last ten minutes every
 * 30 seconds and the whole window every 5 minutes (map-model.ts nextPoll).
 *
 * One request at a time; nothing is sent while the tab is hidden, and when it
 * comes back an overdue read is sent at once; after a failed read the wait
 * grows. Every answer is read again in the browser (core's
 * readSecurityMapPollResult): a shape this build does not know is a failed
 * read, never a picture.
 */

export interface SecurityMapPollState {
  /** The newest read of the whole window, or null when none has come back. */
  whole: SecurityMapWholeRead | null;
  /** The newest read of the last ten minutes, or null. */
  recent: SecurityMapView | null;
  health: SecurityMapHealth;
  /** A whole read that carried the viewer's day start has come back. */
  dayStartAsked: boolean;
  /** The database would not read the window asked for (the last read only). */
  refusedWindow: SecurityMapRefusal | null;
  /** The page's clock: when the last read came back, and the last good whole read. */
  lastPollAt: number | null;
  lastWholeAt: number | null;
}

export type SecurityMapPollInput = { scope: 'whole' | 'recent'; dayStart: string | null };
export type SecurityMapPoll = (input: SecurityMapPollInput) => Promise<unknown>;

/** The state from the server's first read (which could not carry the viewer's day start). */
export function initialPollState(initial: unknown, nowMs: number): SecurityMapPollState {
  const read = readSecurityMapPollResult(initial);
  const base: SecurityMapPollState = {
    whole: null,
    recent: null,
    health: SECURITY_MAP_HEALTH_AT_START,
    dayStartAsked: false,
    refusedWindow: null,
    lastPollAt: null,
    lastWholeAt: null,
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
    health: securityMapHealthAfter(base.health, 'ok', nowMs),
    lastWholeAt: nowMs,
  };
}

/**
 * The state after one read came back. A read of the last ten minutes never
 * replaces the whole window's numbers, table or replay: it only adds the
 * newest live arcs and feed. An answer of the wrong scope is a failed read.
 */
export function pollStateAfter(
  state: SecurityMapPollState,
  scope: 'whole' | 'recent',
  raw: unknown,
  nowMs: number,
  sentDayStart: boolean,
): SecurityMapPollState {
  const read = readSecurityMapPollResult(raw);
  const next = { ...state, lastPollAt: nowMs };
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
  if (scope === 'recent') return { ...next, recent: view, refusedWindow: null, health };
  return {
    ...next,
    whole: view as SecurityMapWholeRead,
    refusedWindow: null,
    health,
    lastWholeAt: nowMs,
    dayStartAsked: state.dayStartAsked || sentDayStart,
  };
}

/**
 * The poll, run while the island is mounted. `hidden` stops it (a hidden
 * tab); the read in flight, if any, still lands.
 */
export function useSecurityMapPoll(
  initial: unknown,
  poll: SecurityMapPoll,
  hidden: boolean,
): SecurityMapPollState {
  const [state, setState] = useState(() => initialPollState(initial, Date.now()));
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (hidden || inFlight.current) return undefined;
    const step = nextPoll(
      {
        lastPollAt: state.lastPollAt,
        lastWholeAt: state.lastWholeAt,
        failures: state.health.failures,
        dayCounted: state.dayStartAsked,
      },
      Date.now(),
    );
    const timer = setTimeout(
      () => {
        if (inFlight.current) return;
        inFlight.current = true;
        const dayStart = step.scope === 'whole' ? localDayStart(new Date()) : null;
        void Promise.resolve()
          .then(() => poll({ scope: step.scope, dayStart }))
          .then(
            (raw) => raw,
            () => null,
          )
          .then((raw) => {
            inFlight.current = false;
            if (!mounted.current) return;
            setState((prev) =>
              pollStateAfter(prev, step.scope, raw, Date.now(), dayStart !== null),
            );
          });
      },
      Math.max(0, step.at - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [hidden, state, poll]);

  return state;
}
