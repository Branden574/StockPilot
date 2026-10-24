import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * New event and Edit event hand the form the ORGANIZATION's zone, so its date
 * and time fields are a wall clock there, as the calendar and the event's page
 * draw them (schedule-event-form.org-zone.test.tsx has the form). They handed
 * none, and the form used the viewer's zone (small fixes slice 8 review). The
 * zone is read the way the calendar reads it: the request-cached org row; a
 * failed read is the documented default zone, reported, never an error page.
 */

const getOrgRowForRequest = vi.fn();
const reportError = vi.fn();

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'u1', role: 'owner', permissions: null })),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: (...args: unknown[]) => getOrgRowForRequest(...args),
}));
vi.mock('@/lib/error-reporter', () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));
vi.mock('@/server/services/schedule', () => ({
  ScheduleService: {
    forCurrentUser: vi.fn(async () => ({
      listInRange: vi.fn(async () => []),
      get: vi.fn(async () => ({
        id: 'ev-1',
        title: 'Evening delivery',
        startsAt: '2026-11-08T04:00:00.000Z',
        endsAt: null,
        allDay: false,
        locationText: null,
        warehouseId: 'wh-1',
        requesterName: null,
        details: null,
        status: 'scheduled',
        bundleId: null,
        bundleQuantity: null,
        bundleWarehouseId: null,
        bundleDistributed: false,
      })),
    })),
  },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: { forCurrentUser: vi.fn(async () => ({ listNames: vi.fn(async () => [{ id: 'wh-1', name: 'Fresno HQ' }]) })) },
}));
vi.mock('@/server/services/bundles', () => ({
  BundlesService: { forCurrentUser: vi.fn(async () => ({ list: vi.fn(async () => []) })) },
}));
vi.mock('@/components/schedule/schedule-event-form', () => ({ ScheduleEventForm: vi.fn(() => null) }));

import { ScheduleEventForm } from '@/components/schedule/schedule-event-form';

import EditScheduleEventPage from './[id]/edit/page';
import NewScheduleEventPage from './new/page';

function findProps(node: unknown, type: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findProps(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!React.isValidElement(node)) return null;
  if (node.type === type) return node.props as Record<string, unknown>;
  return findProps((node.props as { children?: unknown }).children, type);
}

const pages = {
  new: () => NewScheduleEventPage({ searchParams: Promise.resolve({ date: '2026-11-07' }) }),
  edit: () => EditScheduleEventPage({ params: Promise.resolve({ id: 'ev-1' }) }),
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  getOrgRowForRequest.mockResolvedValue({ timezone: 'America/New_York' });
});

describe.each(['new', 'edit'] as const)("the %s event page hands the form the organization's zone", (which) => {
  it("passes the organization's zone", async () => {
    const props = findProps(await pages[which](), ScheduleEventForm);
    expect(props?.timeZone).toBe('America/New_York');
    expect(getOrgRowForRequest).toHaveBeenCalledWith('org-1');
  });

  it('a failed read is the default zone, reported, and the page still renders', async () => {
    getOrgRowForRequest.mockRejectedValueOnce(new Error('statement timeout'));
    const props = findProps(await pages[which](), ScheduleEventForm);
    expect(props?.timeZone).toBe('America/Los_Angeles');
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'schedule.event_form.org_timezone_failed', level: 'warning' }),
    );
  });
});
