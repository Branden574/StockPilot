/**
 * Settings > Integrations server-renders the QuickBooks and EasyPost cards,
 * which print dates and times with toLocaleString(): the server's zone (UTC
 * on Vercel) while it renders, the viewer's while the browser hydrates. A
 * time of day differs in every zone but UTC, so a connected integration made
 * React throw error #418 on every load. The times are printed once the page
 * has hydrated.
 */
import { within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift, inZone, BROWSER_ZONE } from '@/test/hydration';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/connections', () => ({
  beginConnectAction: vi.fn(),
  connectEasyPostAction: vi.fn(),
  disconnectAction: vi.fn(),
  disconnectEasyPostAction: vi.fn(),
  replaySyncAction: vi.fn(),
  saveAccountMappingAction: vi.fn(),
}));

import { IntegrationsPanel } from './integrations-panel';

const T0 = Date.parse('2026-10-06T03:00:00.000Z');
const CONNECTED_AT = '2026-10-01T16:05:00.000Z';
const SYNCED_AT = '2026-10-06T02:30:00.000Z';
const HEALTH_AT = '2026-10-05T20:10:00.000Z';
const FAILED_AT = '2026-10-04T18:45:00.000Z';
const EASYPOST_AT = '2026-09-30T23:15:00.000Z';
const ALL = [CONNECTED_AT, SYNCED_AT, HEALTH_AT, FAILED_AT, EASYPOST_AT];

describe('IntegrationsPanel hydrates with the server in UTC and the browser in Los Angeles', () => {
  it("prints every time in the viewer's zone once hydrated, never the server's, with no hydration error", async () => {
    const run = await hydrateAcrossClockShift(
      () => (
        <IntegrationsPanel
          status="active"
          externalAccountId="9130 3555 1234"
          lastConnectedAt={CONNECTED_AT}
          lastSyncedAt={SYNCED_AT}
          lastError={null}
          accountIds={{}}
          health={[
            {
              topic: 'receipt.posted',
              status: 'success',
              attempts: 1,
              externalId: 'bill-1',
              lastError: null,
              completedAt: HEALTH_AT,
              createdAt: HEALTH_AT,
            },
          ]}
          easyPost={{
            status: 'active',
            mode: 'test',
            lastConnectedAt: EASYPOST_AT,
            lastError: null,
          }}
          failedSyncs={[
            {
              id: 'f1',
              topic: 'receipt.posted',
              status: 'dead',
              attempts: 5,
              externalId: null,
              lastError: 'Token expired',
              nextAttemptAt: null,
              completedAt: null,
              createdAt: FAILED_AT,
              updatedAt: FAILED_AT,
            },
          ]}
        />
      ),
      { serverNow: T0, browserNow: T0 + 60_000 },
    );
    try {
      expect(run.errors).toEqual([]);
      const page = within(run.container);
      for (const at of ALL) {
        expect(run.html).not.toContain(inZone('UTC', () => new Date(at).toLocaleString()));
        expect(
          page.getByText(inZone(BROWSER_ZONE, () => new Date(at).toLocaleString())),
        ).toBeInTheDocument();
      }
    } finally {
      run.unmount();
    }
  });
});
