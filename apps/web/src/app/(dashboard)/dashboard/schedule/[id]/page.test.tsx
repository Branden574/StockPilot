// The event page's header actions (P4.F2, row W-WS-05). PageHeader puts the
// secondary actions first and the ink commit button last (DESIGN-SPEC 6.1:
// "Export (secondary), New item (secondary), Receive stock (ink)"), so the
// page reads Edit, Cancel, Start (or Mark complete), with the ink button
// rightmost. Who sees them is unchanged: schedule:manage holders only; a
// schedule:read grantee gets the page with no write controls.
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Role = 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';

const h = vi.hoisted(() => ({
  ctx: { role: 'manager' as Role, permissions: undefined as ReadonlySet<string> | undefined },
  event: {} as Record<string, unknown>,
}));

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
    role: h.ctx.role,
    ...(h.ctx.permissions ? { permissions: h.ctx.permissions } : {}),
  })),
}));
// The organization's zone, for the event's date and times (event-range.ts).
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(async () => ({ timezone: 'America/Los_Angeles' })),
}));
// Deterministic org-time words regardless of the test host's zone.
vi.mock('@/lib/timezone', () => ({
  formatOrgDate: () => 'Tue, Oct 20, 2026',
  formatOrgTime: () => '9:00 AM',
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

const EVENT_ID = '5eed0000-0000-4000-8000-0000000000b1';

function event(status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled') {
  return {
    id: EVENT_ID,
    title: 'Dock pickup',
    status,
    startsAt: '2026-10-20T16:00:00.000Z',
    endsAt: null,
    allDay: false,
    locationText: 'Dock 2',
    warehouseName: 'Main',
    requesterName: 'Dana',
    createdByName: 'Sam',
    details: null,
    orderRequestId: null,
    bundleId: null,
    bundleWarehouseId: null,
    bundleQuantity: null,
    bundleDistributed: false,
  };
}

async function renderPage() {
  const ui = await ScheduleEventDetailPage({ params: Promise.resolve({ id: EVENT_ID }) });
  return render(ui);
}

/** The header's actions row, in the order it renders. */
function headerActions(container: HTMLElement): string[] {
  const row = container.querySelector('[data-slot="page-header-actions"]');
  if (!row) return [];
  return Array.from(row.querySelectorAll('a, button')).map((el) => el.textContent?.trim() ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  h.ctx = { role: 'manager', permissions: undefined };
});

describe('the event page header', () => {
  it('a scheduled event reads Edit, Cancel, Start, with the ink Start rightmost', async () => {
    h.event = event('scheduled');
    const { container } = await renderPage();
    expect(headerActions(container)).toEqual(['Edit', 'Cancel', 'Start']);
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      `/dashboard/schedule/${EVENT_ID}/edit`,
    );
    expect(screen.getByRole('button', { name: 'Start' })).toHaveClass('bg-primary');
  });

  it('an event in progress reads Edit, Cancel, Mark complete', async () => {
    h.event = event('in_progress');
    const { container } = await renderPage();
    expect(headerActions(container)).toEqual(['Edit', 'Cancel', 'Mark complete']);
    expect(screen.getByRole('button', { name: 'Mark complete' })).toHaveClass('bg-primary');
  });

  it.each(['completed', 'cancelled'] as const)('a %s event reads Edit, Reopen', async (status) => {
    h.event = event(status);
    const { container } = await renderPage();
    expect(headerActions(container)).toEqual(['Edit', 'Reopen']);
  });

  it('a schedule:read grantee sees the event with no write controls', async () => {
    h.ctx = { role: 'viewer', permissions: new Set(['schedule:read']) };
    h.event = event('scheduled');
    const { container } = await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Dock pickup' })).toBeInTheDocument();
    expect(headerActions(container)).toEqual([]);
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    // The way back is still there.
    expect(within(container).getByRole('link', { name: /Back to calendar/ })).toHaveAttribute(
      'href',
      '/dashboard/schedule',
    );
  });

  it('a member with neither schedule:read nor schedule:manage gets a 404', async () => {
    h.ctx = { role: 'viewer', permissions: new Set() };
    h.event = event('scheduled');
    await expect(renderPage()).rejects.toThrow('notFound');
  });
});

// B63: a mistyped or cut-off link is Page not found before the event is read
// (its invalid-uuid error reached the error boundary), and ahead of the
// schedule:read gate.
describe('schedule/[id]: an event id that is not a uuid', () => {
  it('is the not-found page, with nothing read', async () => {
    const { requireOrgContext } = await import('@/lib/auth/session');
    const { ScheduleService } = await import('@/server/services/schedule');
    for (const id of ['not-a-uuid', EVENT_ID.slice(0, -1)]) {
      await expect(
        ScheduleEventDetailPage({ params: Promise.resolve({ id }) }),
        id,
      ).rejects.toThrow('notFound');
    }
    expect(requireOrgContext).not.toHaveBeenCalled();
    expect(ScheduleService.forCurrentUser).not.toHaveBeenCalled();
  });
});
