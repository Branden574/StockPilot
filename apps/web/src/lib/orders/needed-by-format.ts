import { formatOrgDateTime } from '@stockpilot/core';

/**
 * An order's needed-by as the order page prints it, "Mon, Sep 28, 2:00 PM",
 * in the ORG's zone.
 *
 * One definition for the page's Dates card (a server component) and the
 * approval panel's needed-by chip and AI suggestion (a client component).
 * Both used toLocaleString with no zone, which prints in the zone of whatever
 * runtime formats it: the server's (UTC on Vercel) for the Dates card, so an
 * order in a Los Angeles org due at 2:00 PM said 9:00 PM (F2-1 production
 * walk, 2026-09-28), and the server's then the browser's for the chip, so its
 * server HTML and its hydration disagreed (React #418). Formatted in the org's
 * zone, the words are the same on the server and in every browser.
 */
export function formatNeededBy(iso: string, timeZone: string): string {
  return formatOrgDateTime(
    iso,
    { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
    timeZone,
  );
}
