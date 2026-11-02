import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';
import { DEFAULT_MODULE_IDS } from '@stockpilot/core';

/**
 * New event and Edit event with the Schedule on and Bundles off (B67).
 *
 * Schedule depends only on Inventory, so an owner or admin can switch Bundles
 * off and keep the Schedule. Both pages loaded the Bundle box with the strict
 * `BundlesService.list()`, which refuses with `module_disabled` when Bundles is
 * off, inside an uncaught Promise.all: both pages were "Something broke
 * loading this page", so no event could be added or changed on the web. They
 * now read `listForLookups()`: no bundles while the module is off, and an
 * event already linked to a bundle keeps its link in the form's defaults.
 *
 * The REAL BundlesService and module gate, on a context without Bundles.
 */

const h = vi.hoisted(() => ({
  ctx: null as unknown,
  event: null as Record<string, unknown> | null,
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'owner',
    permissions: null,
  })),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(async () => ({ timezone: 'America/Los_Angeles' })),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/services/schedule', () => ({
  ScheduleService: {
    forCurrentUser: vi.fn(async () => ({
      listInRange: vi.fn(async () => []),
      get: vi.fn(async () => h.event),
    })),
  },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: {
    forCurrentUser: vi.fn(async () => ({
      listNames: vi.fn(async () => [{ id: 'wh-1', name: 'Sample DC' }]),
    })),
  },
}));
// The real service, built on the context each test sets.
vi.mock('@/server/services/bundles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/bundles')>();
  return {
    ...actual,
    BundlesService: {
      forCurrentUser: vi.fn(
        async () =>
          new actual.BundlesService(
            h.ctx as ConstructorParameters<typeof actual.BundlesService>[0],
          ),
      ),
    },
  };
});
vi.mock('@/components/schedule/schedule-event-form', () => ({
  ScheduleEventForm: vi.fn(() => null),
}));

import { ScheduleEventForm } from '@/components/schedule/schedule-event-form';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import EditScheduleEventPage from './[id]/edit/page';
import NewScheduleEventPage from './new/page';

const EVENT_ID = '0a000000-0000-4000-8000-0000000000e1';
const BUNDLE_ID = '0a000000-0000-4000-8000-0000000000b7';

const BUNDLE_ROWS = [
  {
    id: BUNDLE_ID,
    name: 'Sample starter kit',
    sku: 'KIT-1',
    is_active: true,
    preassembly_enabled: false,
    phantom_item_id: null,
    archived_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    components: [],
    phantom: null,
  },
];

function event(linked: boolean) {
  return {
    id: EVENT_ID,
    title: 'Sample delivery',
    startsAt: '2026-11-10T17:00:00.000Z',
    endsAt: null,
    allDay: false,
    locationText: null,
    warehouseId: 'wh-1',
    requesterName: null,
    details: null,
    status: 'scheduled',
    bundleId: linked ? BUNDLE_ID : null,
    bundleQuantity: linked ? 5 : null,
    bundleWarehouseId: linked ? 'wh-1' : null,
    bundleDistributed: false,
  };
}

function signIn(bundlesOn: boolean) {
  const enabledModules = new Set<ModuleId>(DEFAULT_MODULE_IDS);
  enabledModules.add('schedule');
  if (bundlesOn) enabledModules.add('bundles');
  else enabledModules.delete('bundles');
  const stub = makeSupabaseStub({
    'bundles.select': { data: BUNDLE_ROWS, error: null },
    'bundle_distributions.select': { data: [], error: null },
  });
  h.ctx = makeServiceContext(stub.client, {
    organizationId: 'org-1',
    role: 'owner',
    enabledModules,
  });
  return stub;
}

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
  new: () => NewScheduleEventPage({ searchParams: Promise.resolve({ date: '2026-11-10' }) }),
  edit: () => EditScheduleEventPage({ params: Promise.resolve({ id: EVENT_ID }) }),
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  h.event = event(false);
});

describe.each(['new', 'edit'] as const)('the %s event page', (which) => {
  it('Bundles off: opens with no bundles in the Bundle box, and reads none', async () => {
    const stub = signIn(false);
    const props = findProps(await pages[which](), ScheduleEventForm);
    expect(props).not.toBeNull();
    expect(props?.bundles).toEqual([]);
    expect(stub.fromCalls).not.toContain('bundles');
  });

  it('Bundles on: offers the bundles as before', async () => {
    signIn(true);
    const props = findProps(await pages[which](), ScheduleEventForm);
    expect(props?.bundles).toEqual([{ id: BUNDLE_ID, name: 'Sample starter kit', sku: 'KIT-1' }]);
  });
});

describe('the edit event page, Bundles off, for an event linked to a bundle', () => {
  it('keeps the link, its quantity and its warehouse in the form', async () => {
    h.event = event(true);
    signIn(false);
    const props = findProps(await pages.edit(), ScheduleEventForm);
    expect(props?.bundles).toEqual([]);
    expect(props?.defaults).toMatchObject({
      bundleId: BUNDLE_ID,
      bundleQuantity: 5,
      bundleWarehouseId: 'wh-1',
    });
  });
});
