import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ScheduleService.get: what the event's distribution handed out (B103).
 *
 * The event page said a kit "will be distributed from <warehouse> when this
 * event is marked complete" after the event had handed it out, because get()
 * read only WHETHER a bundle_distributions row points at the event. It now
 * reads that row's kit, quantity and warehouse (0082 allows one row per
 * event), so the page can say what was handed out. The read is for display:
 * a failed read, or an answer that is not a list, is reported and reads as no
 * distribution, as the "distributed" flag always has, and the event still
 * loads.
 */

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/auth/warehouse', () => ({
  assertWarehouseAccess: vi.fn(),
  ForbiddenError: class ForbiddenError extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./purchase-orders', () => ({ PurchaseOrdersService: class {} }));

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type QueryResult,
} from '@/test/supabase-mock';

import { ScheduleService } from './schedule';

const ORG = 'org-test';
const EVENT = 'e0000000-0000-4000-8000-000000000001';
const OTHER_EVENT = 'e0000000-0000-4000-8000-000000000002';
const KIT = 'b0000000-0000-4000-8000-00000000000a';
const OTHER_KIT = 'b0000000-0000-4000-8000-00000000000b';
const EAST = 'a0000000-0000-4000-8000-00000000000e';
const WEST = 'a0000000-0000-4000-8000-00000000000f';

/** The event as it was saved: 2 kits of KIT from EAST, completed. */
const eventRow = {
  id: EVENT,
  organization_id: ORG,
  title: 'Kit drop',
  starts_at: '2026-10-20T16:00:00Z',
  ends_at: null,
  all_day: false,
  status: 'completed',
  bundle_id: KIT,
  bundle_quantity: 2,
  bundle_warehouse_id: EAST,
  order_request_id: null,
  created_by: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-20T17:00:00Z',
};

const tags = () =>
  reportError.mock.calls.map((c) => (c as unknown as [Error, { tag: string }])[1].tag);

function get(distributions: QueryResult | ReturnType<typeof servedLikePostgrest>) {
  const stub = makeSupabaseStub({
    'schedule_events.select': { data: [eventRow], error: null },
    'user_profiles.select': { data: [], error: null },
    'bundle_distributions.select': distributions,
  });
  const ctx = makeServiceContext(stub.client, {
    organizationId: ORG,
    enabledModules: new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'schedule' as ModuleId]),
  });
  return new ScheduleService(ctx as never).get(EVENT);
}

beforeEach(() => {
  reportError.mockClear();
});

describe('ScheduleService.get: what the event handed out (B103)', () => {
  it("reads the kit, quantity and warehouse of the event's own distribution row", async () => {
    const row = await get(
      servedLikePostgrest([
        // Another event's hand-out, and one of another organization.
        {
          organization_id: ORG,
          schedule_event_id: OTHER_EVENT,
          bundle_id: KIT,
          quantity: 5,
          warehouse_id: EAST,
        },
        {
          organization_id: 'org-other',
          schedule_event_id: EVENT,
          bundle_id: KIT,
          quantity: 7,
          warehouse_id: EAST,
        },
        // This event's: a hand-out from the bundle page that named it, of
        // another kit, quantity and warehouse than the event planned.
        {
          organization_id: ORG,
          schedule_event_id: EVENT,
          bundle_id: OTHER_KIT,
          quantity: 3,
          warehouse_id: WEST,
        },
      ]),
    );
    expect(row.bundleDistribution).toEqual({ bundleId: OTHER_KIT, quantity: 3, warehouseId: WEST });
    expect(row.bundleDistributed).toBe(true);
    // The event's own kit fields are unchanged: they are what it planned.
    expect([row.bundleId, row.bundleQuantity, row.bundleWarehouseId]).toEqual([KIT, 2, EAST]);
    expect(tags()).toEqual([]);
  });

  it('an event with no distribution has none and is not flagged', async () => {
    const row = await get(servedLikePostgrest([]));
    expect(row.bundleDistribution).toBeNull();
    expect(row.bundleDistributed).toBe(false);
    expect(tags()).toEqual([]);
  });

  it('a failed read is reported and reads as no distribution; the event still loads', async () => {
    const row = await get({ data: null, error: { message: 'statement timeout' } });
    expect(row.id).toBe(EVENT);
    expect(row.bundleDistribution).toBeNull();
    expect(row.bundleDistributed).toBe(false);
    expect(tags()).toEqual(['schedule.event_distribution']);
  });

  it('an answer that is not a list is a failed read too, not "no distribution"', async () => {
    const row = await get({ data: null, error: null });
    expect(row.bundleDistribution).toBeNull();
    expect(row.bundleDistributed).toBe(false);
    expect(tags()).toEqual(['schedule.event_distribution']);
  });
});
