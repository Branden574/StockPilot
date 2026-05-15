import { toast } from 'sonner';

/**
 * Live notification surfacing — fans every realtime `notifications`
 * INSERT into a sonner toast (when the tab is visible) and/or a
 * browser-level Notification (when the tab is hidden and the user has
 * granted desktop-notification permission).
 *
 * Why this lives in lib/ instead of inline on the bell component:
 *   * The dedupe state must survive the channel callback closure, but
 *     a single module-scoped buffer makes the burst-collapse logic
 *     much easier to reason about than a ref in the bell.
 *   * The desktop-notification opt-in tile on /settings/notifications
 *     and the bell's realtime subscription both need to know "is the
 *     user opted in?" — keeping the localStorage key + helper here
 *     means no drift between them.
 */

export interface LiveNotificationPayload {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
}

const DESKTOP_OPT_IN_KEY = 'stockpilot:desktop-notifications-opt-in';

/**
 * Returns true when the user has explicitly opted into desktop
 * notifications on this device AND the browser has actually granted
 * the permission. Both must be true — `Notification.permission`
 * alone could be 'granted' from a prior session the user has since
 * turned off in their head, so we gate on the localStorage flag too.
 */
export function isDesktopNotificationsEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof Notification === 'undefined') return false;
  try {
    const optIn = window.localStorage.getItem(DESKTOP_OPT_IN_KEY) === '1';
    return optIn && Notification.permission === 'granted';
  } catch {
    return false;
  }
}

/**
 * Persist the opt-in flag. We DO NOT call `Notification.requestPermission()`
 * here — that must be triggered from a real user click on the settings
 * tile (browsers ignore programmatic requests from arbitrary contexts).
 */
export function setDesktopOptIn(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (value) window.localStorage.setItem(DESKTOP_OPT_IN_KEY, '1');
    else window.localStorage.removeItem(DESKTOP_OPT_IN_KEY);
  } catch {
    /* localStorage unavailable (private mode etc.) — silently no-op */
  }
}

/**
 * Burst collapse: incoming notifications within this window collapse
 * to a single "+N more" toast so a bulk-import fan-out (low-stock
 * crossings for 50 items at once) doesn't paper the screen.
 */
const BURST_WINDOW_MS = 1500;

interface BurstState {
  timer: ReturnType<typeof setTimeout> | null;
  queue: LiveNotificationPayload[];
}

const burst: BurstState = { timer: null, queue: [] };

function safeRedirect(path: string | null): string | null {
  if (!path) return null;
  // Internal paths only — never let a notification link land on
  // `https://evil.example`. The DB triggers always write
  // dashboard-relative links, so this is just a belt for any future
  // writer that forgets.
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  return path;
}

/**
 * At fire time (NOT queue time) pick the surface that actually makes
 * sense for the user's current tab state:
 *   - visible → in-app sonner toast.
 *   - hidden + desktop opt-in granted → OS Notification.
 *   - hidden + no opt-in → drop the toast entirely; the bell badge
 *     already updated, the user will see the unread count when they
 *     come back to the tab.
 *
 * The previous version fired the sonner toast unconditionally even
 * while hidden, which caused a stack of stale toasts to appear when
 * the user refocused the tab (sonner keeps undismissed toasts in the
 * DOM until their duration elapses).
 */
function isTabVisible(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible';
}

/**
 * Single-leader election for sonner toasts across multiple tabs of the
 * same app. The realtime channel delivers each notification INSERT to
 * EVERY tab the user has open; without this, two visible tabs would
 * each pop their own toast for the same row. We don't lock the OS
 * Notification path — the browser's per-tag dedup already collapses
 * those to a single OS popup.
 *
 * Strategy: try to acquire a per-notification Web Lock with
 * `ifAvailable: true`. Whichever tab wins fires the toast and HOLDS
 * the lock for `LOCK_HOLD_MS`, so even tabs whose realtime event
 * arrives a few seconds later can't double-fire. On unsupported
 * browsers (no `navigator.locks`) we fall back to the prior
 * fire-anyway behavior — the cost is "duplicate toasts on Safari
 * <15.4 across two tabs," which we accept rather than skipping the
 * toast entirely.
 *
 * The lock auto-releases when the tab closes (browser cleans up the
 * lock manager), so a leader tab being closed lets the next event
 * land on a sibling tab as normal.
 */
const LOCK_HOLD_MS = 60_000;

interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable: true; mode?: 'exclusive' | 'shared' },
    callback: (lock: unknown | null) => Promise<void> | void,
  ): Promise<unknown>;
}

function getLockManager(): LockManagerLike | null {
  if (typeof navigator === 'undefined') return null;
  const nav = navigator as Navigator & { locks?: LockManagerLike };
  return nav.locks ?? null;
}

/**
 * Returns a Promise<boolean>. Resolves true if THIS tab won the
 * right to fire the toast for `key`; false if another tab already
 * holds the lock for it. Independent of the actual fire — caller
 * checks the result and only fires when true.
 */
function acquireToastLock(key: string): Promise<boolean> {
  const locks = getLockManager();
  if (!locks) return Promise.resolve(true); // fail-open on unsupported browsers
  const lockName = `stockpilot-toast-${key}`;
  return new Promise<boolean>((resolve) => {
    try {
      void locks.request(
        lockName,
        { ifAvailable: true, mode: 'exclusive' },
        async (lock: unknown | null) => {
          if (lock === null) {
            resolve(false);
            return;
          }
          resolve(true);
          // Hold the lock for a window long enough that any sibling
          // tab whose realtime event arrives late still finds it
          // taken. The callback's promise pending = lock held.
          await new Promise<void>((r) => setTimeout(r, LOCK_HOLD_MS));
        },
      );
    } catch {
      // Lock manager threw (unusual) — fail-open.
      resolve(true);
    }
  });
}

async function fireOne(
  payload: LiveNotificationPayload,
  navigate: (link: string) => void,
): Promise<void> {
  const link = safeRedirect(payload.link);

  if (isTabVisible()) {
    // Cross-tab dedup: only one visible tab actually pops the toast.
    // OS notifications below dedupe via the `tag` attribute, so they
    // don't need the lock.
    const won = await acquireToastLock(payload.id);
    if (!won) return;
    toast(payload.title, {
      description: payload.body ?? undefined,
      action: link
        ? {
            label: 'View',
            onClick: () => navigate(link),
          }
        : undefined,
    });
    return;
  }

  // Tab hidden — try OS notification if the user opted in. Keep
  // title + body short; some browsers truncate aggressively.
  if (!isDesktopNotificationsEnabled()) return;
  try {
    const n = new Notification(payload.title, {
      body: payload.body ?? undefined,
      tag: payload.id, // dedupes per-OS so the same row can't double-fire
    });
    if (link) {
      n.onclick = () => {
        window.focus();
        navigate(link);
        n.close();
      };
    }
  } catch {
    /* Notification disabled mid-session or browser refused */
  }
}

async function fireBurstSummary(
  payloads: LiveNotificationPayload[],
  navigate: (link: string) => void,
): Promise<void> {
  // Try to surface a useful link — most fan-outs share the same link
  // shape (e.g. /dashboard/orders/<id>). If all links match, route
  // there; otherwise route to the notifications inbox.
  const links = new Set(payloads.map((p) => p.link ?? ''));
  const sharedLink =
    links.size === 1 && payloads[0]?.link ? safeRedirect(payloads[0].link) : null;
  const fallback = '/dashboard/notifications';

  if (isTabVisible()) {
    // Lock key derived from the first event's id. Sibling tabs that
    // batch the same realtime events into a burst will compute the
    // same key (events arrive in the same order over the WebSocket),
    // so they race for the same lock — only one wins and shows the
    // summary toast.
    const lockKey = payloads[0] ? `burst-${payloads[0].id}` : 'burst';
    const won = await acquireToastLock(lockKey);
    if (!won) return;
    toast(`${payloads.length} new notifications`, {
      description: 'Open the bell to review them.',
      action: sharedLink
        ? {
            label: 'View',
            onClick: () => navigate(sharedLink),
          }
        : { label: 'View all', onClick: () => navigate(fallback) },
    });
    return;
  }

  if (!isDesktopNotificationsEnabled()) return;
  try {
    const n = new Notification('New notifications', {
      body: `${payloads.length} new updates in StockPilot.`,
      tag: 'stockpilot-burst', // single burst notification only
    });
    n.onclick = () => {
      window.focus();
      navigate(sharedLink ?? fallback);
      n.close();
    };
  } catch {
    /* swallow */
  }
}

/**
 * Public entry: queue a notification for live surfacing. Within the
 * burst window we collect events; once it elapses we emit either one
 * toast (1 event) or a summary toast (2+ events). `navigate` is
 * passed in instead of imported so the caller can use its own
 * `useRouter().push` and we don't pull `next/navigation` into a
 * non-component module.
 */
export function queueLiveNotification(
  payload: LiveNotificationPayload,
  navigate: (link: string) => void,
): void {
  burst.queue.push(payload);
  if (burst.timer) return;
  burst.timer = setTimeout(() => {
    const drained = burst.queue;
    burst.queue = [];
    burst.timer = null;
    if (drained.length === 1 && drained[0]) {
      void fireOne(drained[0], navigate);
    } else if (drained.length > 1) {
      void fireBurstSummary(drained, navigate);
    }
  }, BURST_WINDOW_MS);
}

/**
 * Test-only: drain the buffer immediately. Unused in app code.
 */
export function flushLiveNotificationsForTest(): LiveNotificationPayload[] {
  if (burst.timer) {
    clearTimeout(burst.timer);
    burst.timer = null;
  }
  const drained = burst.queue;
  burst.queue = [];
  return drained;
}
