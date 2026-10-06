import { pastExpectedDayTest } from '@stockpilot/core';

/**
 * How many of the Receive POs screen's purchase orders are OVERDUE, for its
 * "N OPEN · M OVERDUE" line.
 *
 * Overdue is the web's rule, from core (isPastExpectedDay; owner rule
 * 2026-10-06): the ORGANIZATION's current date is after the expected day. The
 * expected date is a day stored as its midnight UTC, so comparing it with the
 * phone's clock counted a purchase order expected Oct 10 as overdue from 5 PM
 * on Oct 9 in Los Angeles, under its "ETA Oct 10".
 *
 * `timeZone` is organizations.timezone as the screen read it
 * (readOrgTimeZone); null when unset or unreadable, which core reads as its
 * documented default zone.
 *
 * Pure: no React Native import, so it is tested on its own.
 */
export function receiveOverdueCount(
  pos: readonly { expected_at: string | null }[],
  now: Date,
  timeZone: string | null,
): number {
  // The organization's day once, not once per purchase order.
  const isPast = pastExpectedDayTest(now, timeZone);
  let overdue = 0;
  for (const po of pos) {
    if (isPast(po.expected_at)) overdue += 1;
  }
  return overdue;
}

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
