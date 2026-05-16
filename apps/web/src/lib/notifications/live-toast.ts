import { toast } from 'sonner';

/**
 * Live notification surfacing — fans every realtime `notifications`
 * INSERT into a sonner toast (when the tab is visible) and/or a
 * browser-level Notification (when the tab is hidden and the user has
 * granted desktop-notification permission).
 *
 * Why this lives in lib/ instead of inline on the bell component:
 *   * The burst state must survive the channel callback closure, but
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
const SOUND_OPT_OUT_KEY = 'stockpilot:notification-sound-muted';

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

/** Notification-sound preference. Defaults to ON; persist the OFF state. */
export function isNotificationSoundMuted(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SOUND_OPT_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

export function setNotificationSoundMuted(muted: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (muted) window.localStorage.setItem(SOUND_OPT_OUT_KEY, '1');
    else window.localStorage.removeItem(SOUND_OPT_OUT_KEY);
  } catch {
    /* noop */
  }
}

/**
 * Single-tab AudioContext cached lazily — browsers limit how many you
 * can have, and creating one before a user gesture leaves it suspended.
 * The first toast fire after the user clicks anything in the dashboard
 * will resume it implicitly.
 */
let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as typeof window & {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) {
    try {
      audioCtx = new Ctor();
    } catch {
      audioCtx = null;
    }
  }
  return audioCtx;
}

/**
 * Brief two-note "ding" synthesized on the fly so we don't ship an
 * audio asset. Two sine pulses (E5 → A5) with a quick exponential
 * decay. Silently no-ops in environments without Web Audio (SSR,
 * tests) and when the user has muted notification sounds.
 */
function playNotificationSound(): void {
  if (isNotificationSoundMuted()) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    // Chrome auto-suspends the context until a user gesture. resume()
    // is safe to call repeatedly and a no-op when already running.
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    const tones: Array<{ freq: number; start: number; dur: number }> = [
      { freq: 659.25, start: 0, dur: 0.18 }, // E5
      { freq: 880.0, start: 0.12, dur: 0.28 }, // A5
    ];
    for (const t of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = t.freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const startAt = now + t.start;
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.18, startAt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + t.dur);
      osc.start(startAt);
      osc.stop(startAt + t.dur + 0.02);
    }
  } catch {
    /* audio refused mid-session — silently no-op */
  }
}

function safeRedirect(path: string | null): string | null {
  if (!path) return null;
  // Internal paths only — never let a notification link land on
  // `https://evil.example`. The DB triggers always write
  // dashboard-relative links, so this is just a belt for any future
  // writer that forgets.
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  return path;
}

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
          await new Promise<void>((r) => setTimeout(r, LOCK_HOLD_MS));
        },
      );
    } catch {
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
    // No Web Lock on the single-event path. The lock was meant to
    // suppress duplicate toasts when the user has two visible tabs
    // of the dashboard open at once — a rare edge case that was
    // suppressing toasts even in the common single-tab case
    // whenever the lock acquisition raced funny. We accept "two
    // tabs both beep" as the lesser bug versus "the bell badge
    // ticks but no toast appears."
    toast.info(payload.title, {
      description: payload.body ?? undefined,
      duration: 6000,
      action: link
        ? {
            label: 'View',
            onClick: () => navigate(link),
          }
        : undefined,
    });
    playNotificationSound();
    return;
  }

  // Tab hidden — try OS notification if the user opted in. The OS
  // surface plays its own default sound, so no Web Audio call here.
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
  const links = new Set(payloads.map((p) => p.link ?? ''));
  const sharedLink =
    links.size === 1 && payloads[0]?.link ? safeRedirect(payloads[0].link) : null;
  const fallback = '/dashboard/notifications';

  if (isTabVisible()) {
    const lockKey = payloads[0] ? `burst-${payloads[0].id}` : 'burst';
    const won = await acquireToastLock(lockKey);
    if (!won) return;
    toast.info(`${payloads.length} new notifications`, {
      description: 'Open the bell to review them.',
      duration: 6000,
      action: sharedLink
        ? { label: 'View', onClick: () => navigate(sharedLink) }
        : { label: 'View all', onClick: () => navigate(fallback) },
    });
    playNotificationSound();
    return;
  }

  if (!isDesktopNotificationsEnabled()) return;
  try {
    const n = new Notification('New notifications', {
      body: `${payloads.length} new updates in StockPilot.`,
      tag: 'stockpilot-burst',
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
 * Burst behavior:
 *   * First event arrives → fire it INSTANTLY. The user sees the
 *     popup and hears the chime within the same tick as the row
 *     landing — no 1.5s lag.
 *   * A backoff window opens. Any additional event landing within
 *     the window collects into a queue.
 *   * At end of window: if 2+ events queued, fire a summary toast
 *     ("3 new notifications"). Single follow-ups just stay in the
 *     bell — the first popup was enough surface for them.
 *
 * This shape gives "instant for the common case, group-summarize the
 * spam case" — replacing the prior wait-1500ms-then-fire behavior
 * which made every notification feel laggy.
 */
const BURST_WINDOW_MS = 1500;

interface BurstState {
  timer: ReturnType<typeof setTimeout> | null;
  queue: LiveNotificationPayload[];
  firstFiredAt: number;
}

const burst: BurstState = { timer: null, queue: [], firstFiredAt: 0 };

export function queueLiveNotification(
  payload: LiveNotificationPayload,
  navigate: (link: string) => void,
): void {
  if (burst.timer === null) {
    // First event — fire immediately, open the suppression window.
    burst.firstFiredAt = Date.now();
    void fireOne(payload, navigate);
    burst.timer = setTimeout(() => {
      const drained = burst.queue;
      burst.queue = [];
      burst.timer = null;
      if (drained.length === 1 && drained[0]) {
        // Exactly one follow-up landed during the window — surface
        // it too. Pairs of unrelated notifications shouldn't get
        // silently demoted to "the bell knows."
        void fireOne(drained[0], navigate);
      } else if (drained.length > 1) {
        void fireBurstSummary(drained, navigate);
      }
    }, BURST_WINDOW_MS);
    return;
  }
  // Inside the window — queue for the summary that fires when the
  // timer elapses.
  burst.queue.push(payload);
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
  burst.firstFiredAt = 0;
  return drained;
}
