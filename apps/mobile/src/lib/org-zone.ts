import * as React from 'react';

import { resolveOrgTimezone } from '@stockpilot/core';

import { forgetOnAccountChange } from './account-epoch';
import { readOrgTimeZone, type OrgZoneClient } from './order-readiness';

/**
 * THE ORGANIZATION'S TIME ZONE, FOR EVERY TIME THE PHONE PRINTS ABOUT COUNTS
 * AND EXCEPTIONS (B25, the F1-3 follow-up).
 *
 * The web prints a count's start, an exception's "Checked at", first seen and
 * timeline, and a location's or item's "Checked at" in the ORGANIZATION's zone
 * (organizations.timezone; core's default zone when unset). The phone printed
 * the same moments in the zone the server sent with each answer, but an answer
 * without one (a server older than the phone's bundle: the exceptions and
 * verification routes before F1-3, the count list's summary before #242, and
 * the count list offline, with no summary at all) fell back to the DEVICE's
 * zone, so a phone set to another zone named a different clock time than the
 * web, and a phone that travelled named a different one again.
 *
 * Now: the zone an answer carries is used and remembered for its organization;
 * an answer without one gets the remembered zone, else the one read from
 * organizations.timezone (an RLS member read, readOrgTimeZone); and a time is
 * printed in core's default zone (resolveOrgTimezone) when even that is
 * unknown, never in the device's.
 */

/** The zone last known for each organization, for the life of the app session. */
const known = new Map<string, string>();

/** Remember the zone an answer carried for its organization. */
export function rememberOrgTimeZone(
  orgId: string | null | undefined,
  zone: string | null | undefined,
): void {
  if (orgId && typeof zone === 'string' && zone.trim() !== '') known.set(orgId, zone);
}

/** The zone known for the organization, or null. Synchronous: for a render. */
export function knownOrgTimeZone(orgId: string | null | undefined): string | null {
  return (orgId && known.get(orgId)) || null;
}

/**
 * The Supabase client, loaded on first use: the modules that call this
 * (exceptions-api.ts, verification-api.ts) load under the node test runner,
 * where the React Native client cannot. A client that cannot load reads as no
 * zone, and so does every later call.
 */
let client: Promise<OrgZoneClient | null> | null = null;
function zoneClient(): Promise<OrgZoneClient | null> {
  client ??= import('./supabase').then(
    (m) => m.supabase,
    () => null,
  );
  return client;
}

/**
 * The organization's zone: the one known, else organizations.timezone (one
 * read, remembered when found). Null when unset or unreadable (offline, a
 * refused read): the caller prints core's default zone then. Never throws.
 */
export async function orgTimeZone(orgId: string): Promise<string | null> {
  const hit = knownOrgTimeZone(orgId);
  if (hit) return hit;
  try {
    const c = await zoneClient();
    const zone = c ? await readOrgTimeZone(c, orgId) : null;
    rememberOrgTimeZone(orgId, zone);
    return zone;
  } catch {
    return null;
  }
}

/**
 * An answer with its organization's zone: the one it carries (remembered),
 * else the organization's (orgTimeZone). Unchanged when neither is known.
 */
export async function withOrgTimeZone<
  T extends { organizationId: string; timeZone: string | null },
>(answer: T): Promise<T> {
  if (answer.timeZone) {
    rememberOrgTimeZone(answer.organizationId, answer.timeZone);
    return answer;
  }
  const zone = await orgTimeZone(answer.organizationId);
  return zone ? { ...answer, timeZone: zone } : answer;
}

/**
 * The zone a screen prints its times in: the one its server answer carried,
 * else the one known for the organization, else read once (orgTimeZone), and
 * core's default zone until then or when it cannot be read. Never the
 * device's, and never invalid (resolveOrgTimezone).
 *
 * `fromServer` is shown, never remembered here: on a workspace switch a screen
 * renders once with the new organization and the previous one's answer. The
 * code that checked an answer's organization remembers its zone
 * (withOrgTimeZone, rememberOrgTimeZone).
 */
export function useOrgTimeZone(
  orgId: string | null | undefined,
  fromServer?: string | null,
): string {
  const [read, setRead] = React.useState<{ orgId: string; zone: string | null } | null>(null);
  const needed = !fromServer && !!orgId && !knownOrgTimeZone(orgId);
  React.useEffect(() => {
    if (!needed || !orgId) return;
    let cancelled = false;
    void orgTimeZone(orgId).then((zone) => {
      if (!cancelled) setRead({ orgId, zone });
    });
    return () => {
      cancelled = true;
    };
  }, [needed, orgId]);
  return resolveOrgTimezone(
    fromServer || knownOrgTimeZone(orgId) || (read && read.orgId === orgId ? read.zone : null),
  );
}

/** Forget every known zone: tests, and every account change. */
export function forgetOrgTimeZones(): void {
  known.clear();
}
forgetOnAccountChange(forgetOrgTimeZones);
