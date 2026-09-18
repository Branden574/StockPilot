'use client';

import { usePathname } from 'next/navigation';
import * as React from 'react';

/** Matches the floor inside touch_member_last_seen() (migration 0352). */
export const BEACON_MIN_INTERVAL_MS = 5 * 60 * 1000;

const STORAGE_PREFIX = 'sp:last-seen-beacon:';

/**
 * In-memory fallback, used ONLY when localStorage throws (private mode, blocked
 * site data). When storage works it is the single source of truth, so a slot
 * another tab released is seen as released here too. Module-level so a remount
 * does not reset it.
 */
const memoryStamps = new Map<string, number>();

function readStamp(key: string): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return memoryStamps.get(key) ?? 0;
  }
}

function writeStamp(key: string, value: number | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {
    if (value === null) memoryStamps.delete(key);
    else memoryStamps.set(key, value);
  }
}

/**
 * Tells the server "a person has StockPilot open in this organization" so the
 * platform console can show when someone was last here, even if they only read
 * and then signed out (migration 0352 explains why nothing else survives that).
 *
 * PERSON-DRIVEN, deliberately: it reports when the app opens, when the tab or
 * window comes back, and on navigation. There is NO interval. A dashboard left
 * open on an unattended screen therefore goes quiet, which is the one thing the
 * hourly session renewal cannot distinguish from a person.
 *
 * Throttled to one request per five minutes per `scope`, shared across tabs
 * through localStorage. `scope` is `${userId}:${organizationId}` from the
 * server, so a second account or organization on a shared device is never
 * throttled by the first. The server ignores any input and stamps the session's
 * own user in the session's own organization; the scope never leaves the
 * browser.
 *
 * Renders nothing and can never surface an error: it is telemetry.
 */
export function ActivityBeacon({ scope }: { scope: string }) {
  const pathname = usePathname();
  const key = STORAGE_PREFIX + scope;

  const report = React.useCallback(() => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState !== 'visible') return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    const now = Date.now();
    if (now - readStamp(key) < BEACON_MIN_INTERVAL_MS) return;

    // Claim the slot BEFORE the request so a burst of events (focus +
    // visibilitychange + navigation in the same tick, or several tabs) sends one.
    writeStamp(key, now);
    void fetch('/api/v1/me/seen', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => {
      // Never reached the server: release the slot so the next moment retries.
      // An HTTP error is NOT retried: the server already reported it, and a
      // beacon that hammers a failing endpoint is worse than a missing stamp.
      if (readStamp(key) === now) writeStamp(key, null);
    });
  }, [key]);

  React.useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') report();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', report);
    window.addEventListener('online', report);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', report);
      window.removeEventListener('online', report);
    };
  }, [report]);

  // App open, and every client-side navigation: the person just did something.
  React.useEffect(() => {
    report();
  }, [pathname, report]);

  return null;
}
