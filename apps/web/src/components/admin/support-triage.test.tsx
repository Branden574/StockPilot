/**
 * Support triage (Admin and the platform console) is server-rendered, and
 * each ticket prints the day it came in with toLocaleDateString(): the
 * server's zone (UTC on Vercel) while it renders, the viewer's while the
 * browser hydrates. An evening ticket in Los Angeles is the next day in UTC,
 * so React threw error #418. The day is printed once the page has hydrated.
 */
import { within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift, inZone, BROWSER_ZONE } from '@/test/hydration';

import type { SupportTicketRow } from '@/server/services/support-tickets';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/support-tickets', () => ({ updateSupportTicketAction: vi.fn() }));

import { SupportTriage } from './support-triage';

const T0 = Date.parse('2026-10-06T03:00:00.000Z');
// 7:30 PM on Oct 5 in Los Angeles; Oct 6 in UTC.
const CREATED_AT = '2026-10-06T02:30:00.000Z';

const TICKET: SupportTicketRow = {
  id: 't1',
  organizationId: 'org-1',
  submittedBy: 'u-1',
  name: 'Dana Lee',
  email: 'dana@example.com',
  category: 'bug',
  priority: 'normal',
  subject: 'Scanner stops after one scan',
  message: 'It stops.',
  status: 'open',
  pageUrl: null,
  adminNotes: null,
  attachmentPath: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  resolvedAt: null,
};

describe('SupportTriage hydrates with the server in UTC and the browser in Los Angeles', () => {
  it("prints the viewer's day once hydrated, never the server's, with no hydration error", async () => {
    const serverDay = inZone('UTC', () => new Date(CREATED_AT).toLocaleDateString());
    const viewerDay = inZone(BROWSER_ZONE, () => new Date(CREATED_AT).toLocaleDateString());
    const run = await hydrateAcrossClockShift(() => <SupportTriage tickets={[TICKET]} />, {
      serverNow: T0,
      browserNow: T0 + 60_000,
    });
    try {
      expect(run.errors).toEqual([]);
      expect(run.html).toContain('Scanner stops after one scan');
      expect(run.html).not.toContain(serverDay);
      expect(within(run.container).getByText(viewerDay, { exact: false })).toBeInTheDocument();
    } finally {
      run.unmount();
    }
  });
});
