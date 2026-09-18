import { api, orgHeader } from './api';

/**
 * Mobile half of the "last seen" signal (web: components/activity-beacon.tsx;
 * server: POST /api/v1/me/seen; database: migration 0352).
 *
 * It tells the server "a person has StockPilot open in this workspace" so the
 * platform console can show when someone was last here even if they only read
 * and then signed out. PERSON-DRIVEN on purpose: the app coming to the
 * foreground, and navigation. No timer, so a phone left unlocked on a desk goes
 * quiet.
 *
 * This file is transport plus a throttle. The server ignores any input and
 * stamps the token's own user in the workspace named by the X-Organization-Id
 * header api() already sends, after validating membership. The database
 * throttles again, so a reinstall or a second device cannot flood it.
 */

/** Matches the floor inside touch_member_last_seen() and the web beacon. */
export const BEACON_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** PURE: is a report due? `last` is undefined when none was ever sent. */
export function isSeenReportDue(now: number, last: number | undefined): boolean {
  return last === undefined || now - last >= BEACON_MIN_INTERVAL_MS;
}

/** Last successful (or in-flight) report per `${userId}:${orgId}`, this process only. */
const lastReported = new Map<string, number>();

/** Test seam. The map is process state and would otherwise leak between tests. */
export function resetSeenBeaconForTests(): void {
  lastReported.clear();
}

/**
 * Report presence if one is due. Never throws and never surfaces anything: it
 * is telemetry, and the shell must not care whether it worked.
 */
export async function reportSeen(userId: string, now: number = Date.now()): Promise<void> {
  try {
    const org = (await orgHeader())['X-Organization-Id'] ?? 'default';
    const key = `${userId}:${org}`;
    if (!isSeenReportDue(now, lastReported.get(key))) return;

    // Claim the slot before the request so a foreground event and a navigation
    // in the same tick send one report, not two.
    lastReported.set(key, now);
    try {
      await api('/api/v1/me/seen', { method: 'POST' });
    } catch {
      // Release the slot so the next moment retries. Offline is the common
      // cause on a warehouse floor, and a missed stamp there is exactly the one
      // worth retrying.
      if (lastReported.get(key) === now) lastReported.delete(key);
    }
  } catch {
    // orgHeader() reads AsyncStorage; a storage fault must not reach the shell.
  }
}
