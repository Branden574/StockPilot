/**
 * The newest App Router navigation, as the router itself reports it.
 *
 * WHY THIS EXISTS. The dashboard shows a skeleton for a navigation that is
 * still waiting after SLOW_NAVIGATION_MS (components/dashboard/pending-route-skeleton.tsx),
 * and the top progress bar climbs while one is in flight. Both used to follow
 * document LINK CLICKS only, so a navigation started from code (router.push
 * after a storefront submit, a duplicated item, a book scan) or by Back/Forward
 * showed nothing until the page arrived. Next 16.3.5 reports every navigation
 * it starts through the `onRouterTransitionStart` export of
 * src/instrumentation-client.ts, which forwards here:
 *   - Link clicks and router.push / router.replace (also the replace Next
 *     issues for a server-component redirect()), from dispatchNavigateAction;
 *   - Back/Forward, from the popstate handler (dispatchTraverseAction).
 * It is called synchronously, inside React.startTransition, BEFORE the router
 * reducer runs. router.refresh(), prefetches, server-action redirects and a
 * shallow history.pushState / replaceState never call it
 * (next/dist/client/components/app-router-instance.js, app-router.js).
 *
 * Next keeps only the newest navigation: a new NAVIGATE or RESTORE discards the
 * pending one without telling anyone (app-router-instance.js, `discarded`).
 * This store does the same, so `latest` is always the only navigation that can
 * still commit.
 *
 * It ships in every route's bundle through the instrumentation file, so it
 * imports nothing: no React, no app code. Components read it with
 * useSyncExternalStore only. The hook runs inside Next's startTransition, and a
 * setState from a store listener would join that transition and paint only
 * when the navigation commits, which is exactly when a loading state is no
 * longer needed.
 */

/** How long a path navigation may keep the page being left on screen before its skeleton replaces it. */
export const SLOW_NAVIGATION_MS = 400;

/**
 * The longest the late skeleton (and the progress bar with it) waits for a
 * navigation before showing the page being left again.
 *
 * Every failure Next can see already ends it: an error page or not-found
 * commits (the location moves), and a failed request becomes a full page load.
 * What is left is a navigation Next abandons without a word (a reducer error
 * falls back to the old state). 30 s is three times the slowest real navigation
 * measured (the item-page tabs, ~10 s, 2026-09-22), and it keeps a lost
 * navigation from hiding the page forever.
 */
export const MAX_PENDING_NAVIGATION_MS = 30_000;

/**
 * A replace that starts within this long of the commit of the page it leaves
 * is that page redirecting itself (RouterNavigation.redirect). Next's replace
 * for a server-component redirect() ran 1 ms after the redirecting page
 * committed, and a page replacing itself on mount 3 ms after (navigation lab,
 * 2026-09-23); the margin covers a busy main thread. A person cannot start a
 * navigation from a page this soon after it appeared.
 */
export const REDIRECT_FOLLOW_MS = 100;

/**
 * 'path'  the pathname changes: the only kind that gets a late skeleton.
 * 'query' same pathname, different query.
 * 'same'  same path and query (a same-URL or hash-only push), another origin,
 *         or a Back/Forward nobody in the shell can place. It never starts
 *         anything, but it still replaces a pending navigation, as in Next.
 */
export type RouterNavigationKind = 'path' | 'query' | 'same';
export type RouterNavigationType = 'push' | 'replace' | 'traverse';

export interface RouterNavigation {
  /** Increases with every start, so a new start is a new identity. */
  id: number;
  kind: RouterNavigationKind;
  type: RouterNavigationType;
  /** locationKey of the committed page it leaves ('' when unknown). */
  fromKey: string;
  /** The pathname it is going to: it picks the skeleton. */
  targetPath: string;
  /** Date.now() at the start. Fake timers fake Date, and 400 ms / 30 s need no monotonic clock. */
  startedAt: number;
  /**
   * A path replace that started as the page it leaves committed (within
   * REDIRECT_FOLLOW_MS). That is how Next answers a server-component
   * redirect() during a soft navigation: it commits the redirecting page,
   * which renders nothing (redirect-boundary.js HandleRedirect), and calls
   * router.replace from that page's first effect. It is also a page that
   * replaces itself as it mounts. Either way the page it leaves is empty or
   * already on its way out, so the late skeleton does not wait for it.
   */
  redirect: boolean;
}

let latest: RouterNavigation | null = null;
let committedKey: string | null = null;
/** Date.now() when committedKey last changed to a location. */
let committedAt = 0;
let nextId = 1;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Path plus query, the query re-serialized so two spellings of the same
 * params (`%20` and `+`) compare equal. No hash: a hash change is not a
 * navigation.
 */
export function locationKey(pathname: string, search: string): string {
  const query = new URLSearchParams(search).toString();
  return query ? `${pathname}?${query}` : pathname;
}

function pathOf(key: string): string {
  const q = key.indexOf('?');
  return q === -1 ? key : key.slice(0, q);
}

/** Called by src/instrumentation-client.ts for every navigation Next starts. */
export function recordRouterTransitionStart(url: string, type: RouterNavigationType): void {
  if (typeof window === 'undefined') return;
  let here: URL;
  let to: URL;
  try {
    here = new URL(window.location.href);
    // Relative hrefs (`?page=2`, `#h`) resolve the way Next resolves them.
    to = new URL(url, here);
  } catch {
    return;
  }
  // The page it leaves is the one the ROUTER has committed (written by
  // PendingRouteFrame), not window.location: for Back/Forward the address bar
  // has already moved when this runs, and a shallow history.pushState moves it
  // before the router applies it. window.location is the fallback outside the
  // dashboard shell, where for push and replace it still holds the old URL
  // (Next writes the new one at commit). A Back/Forward there cannot be placed.
  const fromKey = committedKey ?? (type === 'traverse' ? null : locationKey(here.pathname, here.search));
  let kind: RouterNavigationKind;
  if (fromKey === null || to.origin !== here.origin || locationKey(to.pathname, to.search) === fromKey) {
    kind = 'same';
  } else if (to.pathname !== pathOf(fromKey)) {
    kind = 'path';
  } else {
    kind = 'query';
  }
  const now = Date.now();
  latest = {
    id: nextId++,
    kind,
    type,
    fromKey: fromKey ?? '',
    targetPath: to.pathname,
    startedAt: now,
    redirect:
      kind === 'path' &&
      type === 'replace' &&
      committedKey !== null &&
      now - committedAt <= REDIRECT_FOLLOW_MS,
  };
  notify();
}

/**
 * The router's committed location, written by PendingRouteFrame on every
 * commit and set to null when it unmounts.
 *
 * Once the committed location has left the page a navigation started from,
 * that navigation is over: it committed, or Next discarded it for something
 * that never reports a start (a shallow history.pushState dispatches a RESTORE
 * directly). It is retired, so that returning to the same URL later (the
 * Inventory view chips toggle back and forth with pushState) cannot bring a
 * dead navigation back to life and cover the page with its skeleton.
 */
export function noteCommittedLocation(key: string | null): void {
  if (key !== null && key !== committedKey) committedAt = Date.now();
  committedKey = key;
  if (latest !== null && key !== null && key !== latest.fromKey) {
    latest = null;
    notify();
  }
}

export function subscribeRouterNavigation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRouterNavigation(): RouterNavigation | null {
  return latest;
}

/** Server snapshot for useSyncExternalStore: nothing is ever in flight during a server render. */
export function getServerRouterNavigation(): null {
  return null;
}

/**
 * Milliseconds a path navigation from `currentKey` may still be waited for,
 * or 0 when none is in flight. The late skeleton and the progress bar's
 * failsafe share it, so they end together.
 */
export function pendingPathNavigationRemaining(
  nav: RouterNavigation | null,
  currentKey: string | null,
  now: number,
): number {
  if (nav === null || nav.kind !== 'path' || nav.fromKey !== currentKey) return 0;
  const left = MAX_PENDING_NAVIGATION_MS - (now - nav.startedAt);
  return left > 0 ? left : 0;
}

export function resetRouterNavigationForTests(): void {
  latest = null;
  committedKey = null;
  committedAt = 0;
  nextId = 1;
}

// A page restored from the back-forward cache comes back exactly as it was
// left, including a navigation that was in flight when it unloaded (a failed
// request becomes a full page load). Nothing is in flight in a restored page.
if (typeof window !== 'undefined') {
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    latest = null;
    notify();
  });
}
