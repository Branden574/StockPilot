'use client';

// BROWSER-ONLY, enforced: the cache below is module state. In the browser that
// is one person's session; imported by server code it would be one cache for
// every request on the instance, i.e. one person's tour state served to
// another. 'use client' makes a server import receive client references that
// throw when called, instead of silently sharing state.
import {
  getTourStateAction,
  recordTourOutcomeAction,
  type TourStateSnapshot,
} from './actions';

/**
 * The signed-in person's tour state, read ONCE per browser session.
 *
 * Every <PageTour> used to call getTourStateAction on mount, i.e. on every
 * page view: a Server Action that resolves the full request context (3x
 * get_request_context + auth/v1/user) and then reads user_onboarding, all to
 * decide whether to show a "take a tour?" card. Calls from our servers to
 * Supabase stall 1-8 s at its entry point on 3-5% of weekday-daytime calls
 * (logs, 2026-09-22), and the Next router runs Server Actions one after
 * another, so this read could hold up the page's other actions too.
 *
 * Module scope is safe here because of what is kept and how it is keyed:
 *   - it is this person's OWN UI preference (which tours they finished or
 *     waved away), nothing another person could use;
 *   - the entry is keyed by user id and there is only ever one. Asking for a
 *     different user replaces it, sign-out drops it (forgetTourState), and a
 *     read is only kept when the server says it was made for that same user;
 *   - a failed read is never kept, so the next page view asks again.
 * It lives in the browser only: this file has no server-side state, and the
 * Server Actions it calls derive the user from the session, never from here.
 */

interface Entry {
  userId: string;
  state: Promise<TourStateSnapshot | null>;
}

let entry: Entry | null = null;

/** One server read. Resolves null on ANY failure; never rejects. */
async function fetchTourState(expectedUserId: string | null): Promise<TourStateSnapshot | null> {
  try {
    const read = await getTourStateAction();
    if (!read.ok) return null;
    // The session can change under a long-lived tab (someone signs in as a
    // different person in another tab). Never file one person's answer under
    // another person's key.
    if (expectedUserId !== null && read.userId !== expectedUserId) return null;
    return { completed: read.completed, dismissed: read.dismissed };
  } catch {
    // A rejected call (network, or "Failed to find Server Action" from a tab
    // one deployment behind) is a failed read like any other.
    return null;
  }
}

/**
 * The tour state for `userId`, or null when it could not be read (show no
 * offer this time; the next page view asks again). `userId` null means the
 * caller has no signed-in user to key by, so nothing is cached.
 */
export function readTourState(userId: string | null): Promise<TourStateSnapshot | null> {
  if (userId === null) return fetchTourState(null);
  if (entry?.userId === userId) return entry.state;
  const created: Entry = { userId, state: Promise.resolve(null) };
  created.state = fetchTourState(userId).then((state) => {
    if (state === null && entry === created) entry = null;
    return state;
  });
  entry = created;
  return created.state;
}

function withOutcome(
  state: TourStateSnapshot,
  tourId: string,
  version: number,
  outcome: 'completed' | 'dismissed',
): TourStateSnapshot {
  const field = outcome === 'completed' ? 'completed' : 'dismissed';
  return { ...state, [field]: { ...state[field], [tourId]: { v: version } } };
}

/**
 * Records a tour outcome on the server and, only once the server confirms
 * the write, applies it to the kept state, so later page views agree with
 * the server without asking it again. Best-effort and never rejects: an
 * unrecorded outcome only means the tour is offered again.
 */
export async function recordTourOutcome(input: {
  tourId: string;
  version: number;
  outcome: 'completed' | 'dismissed';
}): Promise<void> {
  try {
    const result = await recordTourOutcomeAction(input);
    if (!result.ok) return;
    const current = entry;
    if (!current || current.userId !== result.userId) return;
    // Chained, not replaced: a read still in flight may or may not include
    // this write, so the outcome is applied on top of whatever it returns.
    current.state = current.state.then(
      (state) => state && withOutcome(state, input.tourId, input.version, input.outcome),
    );
  } catch {
    /* best-effort, see above */
  }
}

/**
 * Drops the kept state. With `exceptUserId`, keeps it only when it belongs
 * to that user. Called on sign-out, and whenever the dashboard renders for a
 * different person, so nobody's tour state outlives their session in a tab.
 */
export function forgetTourState(exceptUserId?: string): void {
  if (exceptUserId !== undefined && entry?.userId === exceptUserId) return;
  entry = null;
}
