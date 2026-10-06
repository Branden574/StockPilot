/**
 * Settings > Integrations server-renders the API keys, and each key says the
 * day it was last used with toLocaleDateString(): the server's zone (UTC on
 * Vercel) while it renders, the viewer's while the browser hydrates. A key
 * used in the evening in Los Angeles is the next day in UTC, so React threw
 * error #418. The day is printed once the page has hydrated.
 */
import { within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift, inZone, BROWSER_ZONE } from '@/test/hydration';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/api-keys', () => ({
  createApiKeyAction: vi.fn(),
  revokeApiKeyAction: vi.fn(),
}));

import { ApiKeysPanel, type PanelApiKey } from './api-keys-panel';

const T0 = Date.parse('2026-10-06T03:00:00.000Z');
// 7:30 PM on Oct 5 in Los Angeles; Oct 6 in UTC.
const LAST_USED = '2026-10-06T02:30:00.000Z';

const KEYS: PanelApiKey[] = [
  {
    id: 'k1',
    name: 'Zapier',
    keyPrefix: 'sp_live_ab12',
    scopes: ['inventory:read'],
    createdAt: '2026-09-01T17:00:00.000Z',
    lastUsedAt: LAST_USED,
    revokedAt: null,
  },
  {
    id: 'k2',
    name: 'Spare',
    keyPrefix: 'sp_live_cd34',
    scopes: ['orders:read'],
    createdAt: '2026-09-02T17:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
  },
];

describe('ApiKeysPanel hydrates with the server in UTC and the browser in Los Angeles', () => {
  it("prints the viewer's last-used day once hydrated, never the server's, with no hydration error", async () => {
    const serverDay = inZone('UTC', () => new Date(LAST_USED).toLocaleDateString());
    const viewerDay = inZone(BROWSER_ZONE, () => new Date(LAST_USED).toLocaleDateString());
    const run = await hydrateAcrossClockShift(() => <ApiKeysPanel apiKeys={KEYS} />, {
      serverNow: T0,
      browserNow: T0 + 60_000,
    });
    try {
      expect(run.errors).toEqual([]);
      expect(run.html).not.toContain(serverDay);
      // A key never used says so at once; it has no date to wait for.
      expect(run.html).toContain('never used');
      expect(
        within(run.container).getByText(`last used ${viewerDay}`, { exact: false }),
      ).toBeInTheDocument();
    } finally {
      run.unmount();
    }
  });
});
