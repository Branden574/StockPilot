import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DigestPayload } from '@/server/services/digest';

/**
 * The weekly digest names a purchase order's expected date in its Needs action
 * row (HTML) and in its plain-text list. That date is the DAY the buyer picked,
 * stored as that day's midnight UTC, and the email printed it in the server's
 * zone: a formatter with no zone (HTML) and toLocaleDateString('en-US')
 * (text). On Vercel (UTC) that is the picked day; on a server west of UTC it
 * was the day before. Both now read it through @stockpilot/core's
 * formatCalendarDate.
 *
 * The family module builds its formatters when it is imported, in the zone of
 * that moment, so each case sets the zone and then imports it fresh.
 */

function payload(): DigestPayload {
  return {
    lowStock: [],
    lowStockTotal: 0,
    outOfStockTotal: 0,
    openPos: [
      {
        id: '5b6c7d8e-2222-4333-8444-955555555555',
        poNumber: 'PO-2041',
        supplierName: 'Meridian Supply Co',
        expectedAt: '2026-07-10T00:00:00Z',
        status: 'ordered',
        isOverdue: true,
      },
    ],
    openPosTotal: 1,
    overduePosTotal: 1,
    openCycleCounts: [],
  };
}

const OPTS = {
  orgName: 'L4L North Region',
  appUrl: 'https://app.test',
  settingsUrl: 'https://app.test/dashboard/settings/notifications',
  recipientName: 'Dana Whitfield',
  now: new Date('2026-07-20T18:00:00Z'),
  timeZone: 'America/Los_Angeles',
};

async function familyIn(zone: string) {
  process.env.TZ = zone;
  vi.resetModules();
  return import('./digest');
}

describe("the digest prints a purchase order's expected date as the day that was set", () => {
  const previousZone = process.env.TZ;
  afterEach(() => {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
    vi.resetModules();
  });

  it('on a server in Los Angeles: Jul 10 in the HTML and 7/10/2026 in the text, not the day before', async () => {
    const { renderWeeklyDigestHtml, weeklyDigestText } = await familyIn('America/Los_Angeles');
    const html = renderWeeklyDigestHtml(payload(), OPTS);
    expect(html).toContain('PO-2041 &middot; Meridian Supply Co &middot; expected Jul 10, 2026');
    expect(html).not.toContain('Jul 9, 2026');
    const text = weeklyDigestText(payload(), OPTS);
    expect(text).toContain('PO-2041  Meridian Supply Co  expected 7/10/2026 [OVERDUE]');
  });

  it('on a server in UTC (Vercel): the same words as before', async () => {
    const { renderWeeklyDigestHtml, weeklyDigestText } = await familyIn('UTC');
    expect(renderWeeklyDigestHtml(payload(), OPTS)).toContain('expected Jul 10, 2026');
    expect(weeklyDigestText(payload(), OPTS)).toContain('expected 7/10/2026 [OVERDUE]');
  });
});
