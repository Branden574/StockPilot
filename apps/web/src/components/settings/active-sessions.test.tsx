/**
 * Settings > Security server-renders the device list, and each device says
 * when it was last active ("active 4 min ago"). The current device was active
 * moments ago, so the minute often rolls over between the server render and
 * hydration; React then throws error #418. The line carries
 * suppressHydrationWarning.
 */
import { describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift } from '@/test/hydration';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/sessions', () => ({
  renameSessionAction: vi.fn(),
  revokeOtherSessionsAction: vi.fn(),
  revokeSessionAction: vi.fn(),
}));

import { ActiveSessions } from './active-sessions';

const T0 = Date.parse('2026-10-05T21:00:00.000Z');

describe('ActiveSessions hydrates across a clock tick', () => {
  it('"active 4 min ago" rendered on the server and hydrated a minute later: no hydration error', async () => {
    const run = await hydrateAcrossClockShift(
      () => (
        <ActiveSessions
          sessions={[
            {
              id: 's1',
              label: 'Chrome on macOS',
              customName: null,
              ip: '203.0.113.7',
              lastActiveAt: new Date(T0 - 210_000).toISOString(),
              createdAt: new Date(T0 - 86_400_000).toISOString(),
              isMfa: true,
              isCurrent: true,
            },
          ]}
        />
      ),
      { serverNow: T0, browserNow: T0 + 60_000 },
    );
    try {
      expect(run.html).toContain('4 min ago');
      expect(run.errors).toEqual([]);
    } finally {
      run.unmount();
    }
  });
});
