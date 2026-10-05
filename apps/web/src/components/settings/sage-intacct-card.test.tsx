/**
 * Settings > Integrations server-renders the Sage Intacct card, which prints
 * "Last connected" with toLocaleString(): the server's zone (UTC on Vercel)
 * while it renders, the viewer's while the browser hydrates, so a connected
 * card made React throw error #418 on every load. The time is printed once
 * the page has hydrated.
 */
import { within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift, inZone, BROWSER_ZONE } from '@/test/hydration';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/connections', () => ({
  beginConnectAction: vi.fn(),
  disconnectAction: vi.fn(),
  saveIntacctSettingsAction: vi.fn(),
}));
vi.mock('@/server/actions/intacct-import', () => ({ importFromIntacctAction: vi.fn() }));

import { SageIntacctCard } from './sage-intacct-card';

const T0 = Date.parse('2026-10-06T03:00:00.000Z');
const CONNECTED_AT = '2026-10-06T02:30:00.000Z';

describe('SageIntacctCard hydrates with the server in UTC and the browser in Los Angeles', () => {
  it("prints Last connected in the viewer's zone once hydrated, never the server's, with no hydration error", async () => {
    const run = await hydrateAcrossClockShift(
      () => (
        <SageIntacctCard
          status="active"
          externalAccountId="ACME-CO"
          lastConnectedAt={CONNECTED_AT}
          lastError={null}
          credentialsConfigured
          warehouses={[]}
          settings={{}}
        />
      ),
      { serverNow: T0, browserNow: T0 + 60_000 },
    );
    try {
      expect(run.errors).toEqual([]);
      expect(run.html).toContain('ACME-CO');
      expect(run.html).not.toContain(inZone('UTC', () => new Date(CONNECTED_AT).toLocaleString()));
      expect(
        within(run.container).getByText(
          inZone(BROWSER_ZONE, () => new Date(CONNECTED_AT).toLocaleString()),
        ),
      ).toBeInTheDocument();
    } finally {
      run.unmount();
    }
  });
});
