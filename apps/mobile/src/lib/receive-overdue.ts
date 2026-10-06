import { isPastExpectedDay } from '@stockpilot/core';

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
  let overdue = 0;
  for (const po of pos) {
    if (isPastExpectedDay(po.expected_at, now, timeZone)) overdue += 1;
  }
  return overdue;
}
