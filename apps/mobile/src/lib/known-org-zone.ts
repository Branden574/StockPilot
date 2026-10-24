/**
 * THE ORGANIZATION ZONE A SCREEN KEEPS between reads.
 *
 * readOrgTimeZone (order-readiness.ts) never throws: a refused or failed read
 * answers null, as an unset zone does. A screen that reads the zone again on a
 * refresh must not let that null replace a zone it already read for the same
 * organization: a Sydney organization would otherwise print in the default
 * zone until the next good read. Another organization starts from what its
 * own read answered.
 *
 * First written for the Receive POs screen's overdue count (#338); the
 * Movements list, Staging, the item screen and the home screen keep the zone
 * their movement times print in the same way (L7). Pure: no React Native
 * import, so it is tested on its own.
 */

/** The organization zone the screen last read, and whose it is. */
export interface KnownOrgZone {
  orgId: string;
  zone: string | null;
}

/**
 * The zone to keep after a read for `orgId` answered `read`. readOrgTimeZone
 * never throws: a refused or failed read answers null, as an unset zone does.
 * A null from a refresh must not replace a zone already read for the same
 * organization (a Sydney organization would otherwise fall back to the
 * default zone's day until the next good read); a different organization
 * starts from what its own read answered.
 */
export function nextKnownOrgZone(
  prev: KnownOrgZone | null,
  orgId: string,
  read: string | null,
): KnownOrgZone {
  if (read !== null) return { orgId, zone: read };
  if (prev !== null && prev.orgId === orgId) return prev;
  return { orgId, zone: null };
}

/** The zone `known` holds for `orgId`, or null (core's documented default)
 *  when it holds none yet or holds another organization's. */
export function knownZoneFor(known: KnownOrgZone | null, orgId: string | null): string | null {
  return known !== null && orgId !== null && known.orgId === orgId ? known.zone : null;
}
