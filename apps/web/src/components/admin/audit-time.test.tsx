import { describe, expect, it } from 'vitest';

import { BROWSER_ZONE, hydrateAcrossClockShift, inZone } from '@/test/hydration';

import { AuditTime } from './audit-time';

/**
 * An audit row's exact time used to be printed by the server page in the
 * server's zone (UTC on Vercel) and shown unlabelled in the tooltip, so an
 * evening event in Los Angeles read as the next morning. AuditTime prints
 * the viewer's own clock once the page has hydrated, with no hydration error.
 */
const T0 = Date.parse('2026-10-06T03:00:00.000Z');
// 7:30 PM on Oct 5 in Los Angeles; 2:30 AM on Oct 6 in UTC.
const AT = '2026-10-06T02:30:00.000Z';

describe('AuditTime', () => {
  it("puts the viewer's time in the tooltip, never the server's, and keeps the relative words", async () => {
    const serverText = inZone('UTC', () => new Date(AT).toLocaleString());
    const viewerText = inZone(BROWSER_ZONE, () => new Date(AT).toLocaleString());
    expect(serverText).not.toBe(viewerText);
    const run = await hydrateAcrossClockShift(() => <AuditTime iso={AT} />, {
      serverNow: T0,
      browserNow: T0 + 90_000,
    });
    try {
      expect(run.errors).toEqual([]);
      expect(run.html).not.toContain(serverText);
      const time = run.container.querySelector('time')!;
      expect(time).toHaveAttribute('dateTime', AT);
      expect(time).toHaveAttribute('title', viewerText);
      expect(time.textContent).toMatch(/minutes ago/);
    } finally {
      run.unmount();
    }
  });
});
