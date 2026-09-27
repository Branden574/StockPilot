'use client';

import * as React from 'react';

// ═══ A STREAMED PROMISE'S ANSWER, READ WITHOUT WAITING FOR IT ═══
//
// The New order page gets its kits as a promise the server started and never
// awaits. Two readers must not wait for it (walk 2026-09-27):
//
//  - Submit reads the kits only for the order's audit note. It used to
//    `await` the promise, so with the bundles read stalled, Confirm & submit
//    sat on its spinner until the read gave up (6.3 s locally), and a rejected
//    promise would have thrown inside the transition.
//  - A category or search view draws the kits that match. It suspended on the
//    promise, and the search box is a deferred value: a deferred render that
//    suspends is thrown away and the OLD view stays up, so while the kits read
//    was out, typing a search changed nothing on screen.
//
// So the outcome is recorded here once, per promise, and read synchronously.
// A promise nobody has watched yet reads as not settled.

type Outcome<T> = { ok: true; value: T } | { ok: false };

const outcomes = new WeakMap<Promise<unknown>, Outcome<unknown>>();
const watched = new WeakSet<Promise<unknown>>();

/** Starts recording `promise`'s outcome (once per promise). Never throws. */
export function watchSettled(promise: Promise<unknown>): void {
  if (watched.has(promise)) return;
  watched.add(promise);
  promise.then(
    (value) => outcomes.set(promise, { ok: true, value }),
    () => outcomes.set(promise, { ok: false }),
  );
}

/** What `promise` came to: undefined while it is out (or not watched yet). */
export function settledOutcome<T>(promise: Promise<T>): Outcome<T> | undefined {
  return outcomes.get(promise) as Outcome<T> | undefined;
}

/**
 * settledOutcome as a hook: the caller re-renders once when the promise
 * settles, and never suspends. Only the caller re-renders, so put it in the
 * small part that draws the answer, not in a component that draws the grid.
 */
export function useSettled<T>(promise: Promise<T>): Outcome<T> | undefined {
  const outcome = settledOutcome(promise);
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    watchSettled(promise);
    if (outcomes.has(promise)) return;
    let live = true;
    // Registered after watchSettled's own callbacks, so the outcome is recorded
    // by the time this re-render reads it.
    const done = () => {
      if (live) bump();
    };
    promise.then(done, done);
    return () => {
      live = false;
    };
  }, [promise]);
  return outcome;
}
