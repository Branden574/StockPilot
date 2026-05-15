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

function fireOne(
  payload: LiveNotificationPayload,
  navigate: (link: string) => void,
): void {
  const link = safeRedirect(payload.link);
  toast(payload.title, {
    description: payload.body ?? undefined,
    action: link
      ? {
          label: 'View',
          onClick: () => navigate(link),
        }
      : undefined,
  });
  // Browser Notification (when hidden + opted in). Keep title +
  // body short; some browsers truncate aggressively.
  if (
    typeof document !== 'undefined' &&
    document.visibilityState === 'hidden' &&
    isDesktopNotificationsEnabled()
  ) {
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
}

function fireBurstSummary(
  payloads: LiveNotificationPayload[],
  navigate: (link: string) => void,
): void {
  // Try to surface a useful link — most fan-outs share the same link
  // shape (e.g. /dashboard/orders/<id>). If all links match, route
  // there; otherwise drop the action.
  const links = new Set(payloads.map((p) => p.link ?? ''));
  const sharedLink =
    links.size === 1 && payloads[0]?.link ? safeRedirect(payloads[0].link) : null;
  toast(`${payloads.length} new notifications`, {
    description: 'Open the bell to review them.',
    action: sharedLink
      ? {
          label: 'View',
          onClick: () => navigate(sharedLink),
        }
      : { label: 'Open bell', onClick: () => navigate('/dashboard/notifications') },
  });
  if (
    typeof document !== 'undefined' &&
    document.visibilityState === 'hidden' &&
    isDesktopNotificationsEnabled()
  ) {
    try {
      const n = new Notification('New notifications', {
        body: `${payloads.length} new updates in StockPilot.`,
        tag: 'stockpilot-burst', // single burst notification only
      });
      n.onclick = () => {
        window.focus();
        navigate(sharedLink ?? '/dashboard/notifications');
        n.close();
      };
    } catch {
      /* swallow */
    }
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
      fireOne(drained[0], navigate);
    } else if (drained.length > 1) {
      fireBurstSummary(drained, navigate);
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
