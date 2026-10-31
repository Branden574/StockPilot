// The event page's header line says when the event happens in the
// ORGANIZATION's zone (small fixes slice 8): the page reads the zone from the
// request-cached organization row and hands it to formatEventRange, which
// printed every event in the default zone (Pacific) before. page.test.tsx
// fixes the formatters' words and a Los Angeles row, so it cannot see which
// zone the page passes; this file runs the real formatters for a New York
// organization. An unreadable row is the default zone, reported, and the page
// still renders.
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getOrgRowForRequest = vi.fn();
const reportError = vi.fn();
const h = vi.hoisted(() => ({ event: {} as Record<string, unknown> }));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'manager',
  })),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: (...args: unknown[]) => getOrgRowForRequest(...args),
}));
vi.mock('@/lib/error-reporter', () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));
// The real context.ts pulls next/headers and the server Supabase client.
vi.mock('@/server/services/context', () => ({
  ServiceError: class ServiceError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/server/actions/schedule', () => ({ updateScheduleEventAction: vi.fn() }));
vi.mock('@/server/services/schedule', () => ({
  ScheduleService: { forCurrentUser: vi.fn(async () => ({ get: vi.fn(async () => h.event) })) },
}));
vi.mock('@/server/services/bundles', () => ({ BundlesService: { forCurrentUser: vi.fn() } }));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: { forCurrentUser: vi.fn() },
}));

import ScheduleEventDetailPage from './page';

/** 1:30 AM on Wed Oct 21 in New York; 10:30 PM on Tue Oct 20 in Los Angeles. */
const STARTS_AT = '2026-10-21T05:30:00.000Z';

function event(startsAt: string, endsAt: string | null = null) {
  return {
    id: 'ev-1',
    title: 'Dock pickup',
    status: 'scheduled',
    startsAt,
    endsAt,
    allDay: false,
    locationText: null,
    warehouseName: null,
    requesterName: null,
    createdByName: null,
    details: null,
    orderRequestId: null,
    bundleId: null,
    bundleWarehouseId: null,
    bundleQuantity: null,
    bundleDistributed: false,
  };
}

async function renderPage() {
  const ui = await ScheduleEventDetailPage({ params: Promise.resolve({ id: 'ev-1' }) });
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  getOrgRowForRequest.mockResolvedValue({ timezone: 'America/New_York' });
  h.event = event(STARTS_AT);
});

describe("the event page's header line is in the organization's zone", () => {
  it("a New York organization: Wed, Oct 21 at 1:30 AM, not Pacific's Tue, Oct 20 at 10:30 PM", async () => {
    const { container } = await renderPage();
    expect(screen.getByText(/^Wed, Oct 21, 2026 · 1:30\sAM$/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Oct 20|10:30\sPM/);
    expect(getOrgRowForRequest).toHaveBeenCalledWith('org-1');
    expect(reportError).not.toHaveBeenCalled();
  });

  it('an event with an end: one day and both times there', async () => {
    // 1:30 AM to 3:00 AM on Oct 21 in New York; it starts on Oct 20 in Los Angeles.
    h.event = event(STARTS_AT, '2026-10-21T07:00:00.000Z');
    await renderPage();
    expect(screen.getByText(/^Wed, Oct 21, 2026 · 1:30\sAM – 3:00\sAM$/)).toBeInTheDocument();
  });

  it('an unreadable organization row is the default zone, reported, and the page still renders', async () => {
    getOrgRowForRequest.mockRejectedValue(new Error('getOrgRowForRequest: statement timeout'));
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Dock pickup' })).toBeInTheDocument();
    expect(screen.getByText(/^Tue, Oct 20, 2026 · 10:30\sPM$/)).toBeInTheDocument();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'schedule.event.org_timezone_failed', level: 'warning' }),
    );
  });
});
