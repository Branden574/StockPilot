import * as React from 'react';

/**
 * "Not now": what keeps the phone update pop-up (ota-update-prompt.ts) from
 * showing, and what Restart now waits for before it restarts.
 *
 * The route alone cannot see what a person is in the middle of. A sheet or an
 * alert open over a list, a photo being picked and uploaded, a share sheet, a
 * pick or a receipt typed but not saved: none of them is a route. Each takes a
 * hold here while it lasts, and the pop-up waits until every hold is gone.
 *
 *   - Sheets: every React Native Modal goes through components/ui/modal.tsx,
 *     which holds while it is visible.
 *   - Alerts: alert-holds.ts holds from the moment an alert shows until one of
 *     its buttons is pressed.
 *   - Photo and file flows and the share sheet: whileUpdatePromptHeld, which
 *     holds from the tap until the flow settles (picker, resize, upload, save).
 *   - Drafts: useHoldUpdatePrompt(dirty, reason) on the screen.
 *   - Until the next return to the app: holdUpdatePromptUntilReturn, for a
 *     screen a tapped notification opened (PR #371).
 *   - Writes in flight: trackWrite, from api(), the supabase client's fetch and
 *     the upload transports. A restart cancels every request in flight (React
 *     Native's networking is torn down with the JavaScript), and a cut write
 *     may or may not have landed, so Restart now waits for these
 *     (whenWritesSettled) and the pop-up waits while any is in flight.
 *
 * A count, not a flag: holds overlap (a filter sheet over a screen whose own
 * pick is dirty is two holds), and closing the sheet must not clear the pick's.
 * Ported from ota-busy.ts on the parked branch perf/mobile-speed-combined.
 */

let holds = 0;
let writes = 0;
/** Each hold's reason, counted: what holds the pop-up now (updatePromptHoldReasons). */
const reasons = new Map<string, number>();
const untilReturn = new Set<() => void>();
const listeners = new Set<() => void>();
let settleWaiters: (() => void)[] = [];
let lastHeld = false;

/** Tells the subscribers when the answer to isUpdatePromptHeld() changes. */
function changed(): void {
  const held = isUpdatePromptHeld();
  if (writes === 0 && settleWaiters.length > 0) {
    const waiting = settleWaiters;
    settleWaiters = [];
    for (const resolve of waiting) resolve();
  }
  if (held === lastHeld) return;
  lastHeld = held;
  for (const fn of [...listeners]) fn();
}

/**
 * Takes a hold. Returns its release, which is safe to call more than once.
 * `reason` says what holds ('sheet', 'alert', 'photo', 'pick', ...).
 */
export function holdUpdatePrompt(reason: string): () => void {
  holds += 1;
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  changed();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    const left = (reasons.get(reason) ?? 1) - 1;
    if (left > 0) reasons.set(reason, left);
    else reasons.delete(reason);
    changed();
  };
}

/** The reasons of the holds taken now, one per kind (writes not included). */
export function updatePromptHoldReasons(): string[] {
  return [...reasons.keys()].sort();
}

/** Holds while `active` is true and the caller is mounted. */
export function useHoldUpdatePrompt(active: boolean, reason: string): void {
  React.useEffect(() => {
    if (!active) return;
    return holdUpdatePrompt(reason);
  }, [active, reason]);
}

/**
 * Holds while `work` runs: for a flow the pop-up cannot see (a picker, its
 * upload and save, the share sheet). The hold is taken before `work` is
 * called, in the same tick, so an alert button that starts the flow hands its
 * own hold over with no gap. Released however the work ends, a synchronous
 * throw included.
 */
export function whileUpdatePromptHeld<T>(work: () => Promise<T>): Promise<T> {
  const release = holdUpdatePrompt('flow');
  let running: Promise<T>;
  try {
    running = work();
  } catch (err) {
    release();
    return Promise.reject(err);
  }
  return Promise.resolve(running).finally(release);
}

/**
 * A hold that also ends at the next return to the app (background, then
 * active): ota-update-prompt.ts calls releaseHoldsUntilReturn() on every
 * return. The release it returns ends it sooner.
 */
export function holdUpdatePromptUntilReturn(reason: string): () => void {
  const release = holdUpdatePrompt(reason);
  const end = () => {
    untilReturn.delete(end);
    release();
  };
  untilReturn.add(end);
  return end;
}

/** Ends every holdUpdatePromptUntilReturn hold. */
export function releaseHoldsUntilReturn(): void {
  for (const end of [...untilReturn]) end();
}

/** Counts `promise` as a write in flight until it settles; passes its result through. */
export function trackWrite<T>(promise: Promise<T>): Promise<T> {
  writes += 1;
  changed();
  return promise.finally(() => {
    writes -= 1;
    changed();
  });
}

/** Writes in flight now. */
export function writesInFlight(): number {
  return writes;
}

/** Resolves once no write is in flight. */
export function whenWritesSettled(): Promise<void> {
  if (writes === 0) return Promise.resolve();
  return new Promise((resolve) => settleWaiters.push(resolve));
}

/**
 * fetch, with every request but GET and HEAD counted as a write (the supabase
 * client's: row and storage writes, RPC calls, token refreshes). The global
 * fetch is read at each call, never captured.
 */
export const writeTrackingFetch: typeof fetch = (input, init) => {
  const method = (
    init?.method ??
    (typeof input === 'object' && input !== null && 'method' in input ? input.method : 'GET')
  ).toUpperCase();
  const request = fetch(input, init);
  return method === 'GET' || method === 'HEAD' ? request : trackWrite(request);
};

/** True while any hold is taken or any write is in flight. */
export function isUpdatePromptHeld(): boolean {
  return holds > 0 || writes > 0;
}

/** Called when isUpdatePromptHeld() changes between false and true. */
export function subscribeUpdatePromptHolds(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
