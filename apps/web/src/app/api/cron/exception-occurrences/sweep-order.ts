/**
 * The Exception Center sync cron's sweep order (route.ts next door). Its own
 * module because a route file may only export its HTTP fields.
 */

import { oldestFirst } from '@/server/services/lib/cron-sweep';

export interface SweepOrg {
  id: string;
  /** organizations.created_at; absent when the read did not carry it. */
  createdAt?: string | null;
}

/**
 * Least recently REACHED first. An organization's time is the later of its
 * last applied sync (exception_sync_state.last_synced_at) and the cron's
 * last attempt at it (cron_sweep_attempts.last_attempt_at, job
 * exception_sync, 0469). An organization with neither (never synced, never
 * tried: a new one) uses its creation time, and with no creation time either,
 * the start of this run.
 * Ties keep id order.
 *
 * Why the attempt counts. last_synced_at moves only when a sync is applied,
 * so an organization the sync skips or fails kept an old time and, under the
 * old tiers, waited behind every due organization; once a run could not reach
 * all of those, it waited for ever. Counting the attempt sends every
 * organization the cron reaches to the back of the line, applied or not, so
 * with capacity C per run and N organizations, each is reached at least once
 * every ceil(N / C) runs. A failing organization therefore gets one attempt
 * per rotation, the same as a healthy one, and cannot use up a run.
 *
 * Why the creation time. A new organization with no time at all would
 * otherwise sort first (taking a run from the rest whenever many arrive at
 * once) or last (and, once the line is longer than one run, never reached).
 * Its creation time is fixed while every other organization's time moves
 * forward when it is reached, so it comes to the front within one rotation.
 */
export function exceptionSweepOrder(
  orgs: readonly SweepOrg[],
  lastSynced: ReadonlyMap<string, number>,
  lastAttempt: ReadonlyMap<string, number>,
  now: number,
): string[] {
  const reachedAt = new Map<string, number>();
  for (const org of orgs) {
    const synced = lastSynced.get(org.id);
    const attempted = lastAttempt.get(org.id);
    const known = [synced, attempted].filter(
      (v): v is number => v !== undefined && Number.isFinite(v),
    );
    if (known.length > 0) {
      reachedAt.set(org.id, Math.max(...known));
      continue;
    }
    const created = Date.parse(org.createdAt ?? '');
    reachedAt.set(org.id, Number.isFinite(created) ? created : now);
  }
  return oldestFirst(
    orgs.map((o) => o.id),
    reachedAt,
  );
}
