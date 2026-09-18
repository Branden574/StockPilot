/**
 * Reloading into the build production is serving, without guessing and without
 * loops.
 *
 * WHAT IT DOES NOT DO. The previous reload deleted every Cache Storage key
 * before navigating. This app registers no service worker and opens no cache, so
 * that deleted nothing today, and it would silently wipe any offline cache added
 * later. A blanket clear is not an update strategy; it is gone.
 *
 * WHAT IT KEEPS. location.replace() with a throwaway query param, not
 * location.reload(): a soft reload may serve the document from the HTTP cache,
 * which is why "Reload" sometimes appeared to do nothing after a deploy. The
 * param forces a fresh document request. It is removed from the address bar
 * again on the next boot, so nobody bookmarks or shares it.
 *
 * VERIFYING. Before navigating it records the build this tab is ON and the
 * build it expects to reach. The next boot asks one question: did the reload
 * MOVE this tab? Not "did it land on the exact build we saw last": production can
 * be promoted again between the last poll and the click, and landing on something
 * newer than expected is a success. Judging by the expected build alone reported
 * that case as a failure, and the stale "did not load" then attached itself to
 * the next, unrelated deploy. "Did not move" is reported to the person ONCE and
 * never retried automatically, because a tab that reloads itself in a loop is
 * worse than a tab that is one version behind.
 */

const TARGET_KEY = 'sp:update-target';
const BUST_PARAM = '_v';

export type ReloadOutcome = 'none' | 'reached' | 'not_reached';

interface ReloadRecord {
  /** The build the tab expected to reach. */
  target: string;
  /** The build the tab was on when it asked. Null when it did not know. */
  from: string | null;
}

function readRecord(): ReloadRecord | null {
  try {
    const raw = sessionStorage.getItem(TARGET_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { build?: unknown; from?: unknown };
    if (typeof parsed.build !== 'string') return null;
    return {
      target: parsed.build,
      from: typeof parsed.from === 'string' && parsed.from.length > 0 ? parsed.from : null,
    };
  } catch {
    return null;
  }
}

/**
 * Navigate to a fresh copy of the current page. `targetBuild` is what we expect
 * to load; `fromBuild` is what this tab is running now.
 */
export function reloadToBuild(targetBuild: string | null, fromBuild: string | null = null): void {
  try {
    if (targetBuild)
      sessionStorage.setItem(TARGET_KEY, JSON.stringify({ build: targetBuild, from: fromBuild }));
  } catch {
    /* storage unavailable: we lose verification, not the reload */
  }
  const url = new URL(window.location.href);
  url.searchParams.set(BUST_PARAM, Date.now().toString(36));
  window.location.replace(url.toString());
}

/** PURE: what a recorded reload amounted to, given the build that actually loaded. */
export function judgeReload(record: ReloadRecord, loadedBuild: string): ReloadOutcome {
  if (!loadedBuild) return 'not_reached';
  if (record.from) return loadedBuild !== record.from ? 'reached' : 'not_reached';
  // No record of where we started: fall back to the exact expectation.
  return loadedBuild === record.target ? 'reached' : 'not_reached';
}

/**
 * Remove the cache-busting param THROUGH Next's router.
 *
 * Next patches history.replaceState so its router follows the address bar, and
 * it skips that sync when the state object is one of its own (`__NA`). Handing
 * back `window.history.state` therefore cleaned the address bar and left `_v` in
 * the router: useSearchParams() kept returning it, and the next router.refresh()
 * wrote it straight back into the URL. `null` is the documented form; Next copies
 * its own internals onto it and updates the router.
 */
export function tidyReloadUrl(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(BUST_PARAM)) return;
    url.searchParams.delete(BUST_PARAM);
    window.history.replaceState(null, '', url.toString());
  } catch {
    /* a cosmetic cleanup must never break boot */
  }
}

/**
 * Call once at boot. Tells the caller whether a reload it asked for moved this
 * tab, clears the record either way (so a failure is reported once, not on every
 * navigation), and tidies the address bar.
 *
 * The tidy-up is deferred a tick. This runs from an effect deep in the tree, and
 * React runs child effects before parent ones, so on first load Next's router
 * has not installed its history patch yet: a synchronous replaceState here would
 * be the native one, and the router would never hear about it.
 */
export function reconcileReload(loadedBuild: string): ReloadOutcome {
  let outcome: ReloadOutcome = 'none';
  const record = readRecord();
  if (record) {
    outcome = judgeReload(record, loadedBuild);
    try {
      sessionStorage.removeItem(TARGET_KEY);
    } catch {
      /* best-effort */
    }
  }
  if (typeof window !== 'undefined') window.setTimeout(tidyReloadUrl, 0);
  return outcome;
}
