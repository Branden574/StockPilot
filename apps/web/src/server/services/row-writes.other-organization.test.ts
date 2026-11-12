// Security invariant (S41, listed in scripts/security-test.sh): a table write
// named by a row id stays in the active organization, and a write that changed
// no row says so and leaves no audit row.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
  type QueryResult,
} from '@/test/supabase-mock';

vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => 'notif-1') }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeSupabaseStub().client }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('./lib/defer', () => ({ defer: vi.fn() }));

import { audit } from './audit';
import { BundlesService } from './bundles';
import { ChartersService } from './charters';
import { CustomersService } from './customers';
import { CycleCountsService } from './cycle-counts';
import { DeliveryTrackingService } from './delivery-tracking';
import { OrderRequestsService } from './order-requests';
import { ScheduleService } from './schedule';
import { TagsService } from './tags';
import { TeamService } from './team';
import { UomConversionsService } from './uom-conversions';
import { VendorItemMappingsService } from './vendor-item-mappings';
import { WarehouseChartersService } from './warehouse-charters';
import { WarehousesService } from './warehouses';

/**
 * S41: a row of organization B, named by its id from a request that runs in
 * organization A (a page left open after the person switched organizations).
 *
 * Two rules, one per describe block below:
 *
 *   1. A write filtered to A matches no row of B. It asks its rows back, and
 *      when none came back it answers not_found and writes no audit row.
 *   2. A write to a child table (or a table keyed by an id alone) reads its
 *      parent in A first, or carries A in its own filter, so a row of B is
 *      never written.
 *
 * Every case has its control: the same call made while working in B changes
 * the row and is recorded in B.
 */

const ROW_ID = '00000000-0000-4000-8000-0000000000b1';
const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const B_ROW = { id: ROW_ID, organization_id: 'org-B' };

/**
 * A write answered as PostgREST answers one: only the rows the chain's own
 * `eq` filters keep are written, and they come back only when the chain asks
 * for them with `.select()`.
 */
function writtenLikePostgrest(
  rows: ReadonlyArray<Record<string, unknown>>,
): (call: MockCall) => QueryResult {
  return (call) => {
    let out = [...rows];
    call.methods.forEach((method, i) => {
      if (method !== 'eq') return;
      const [col, value] = (call.args[i] ?? []) as [string, unknown];
      out = out.filter((r) => r[col] === value);
    });
    return { data: call.methods.includes('select') ? out : null, error: null };
  };
}

const ALL_MODULES = new Set(Object.keys(MODULE_REGISTRY) as ModuleId[]);

function ctxFor(stub: ReturnType<typeof makeSupabaseStub>, org: string) {
  return makeServiceContext(stub.client, {
    organizationId: org,
    role: 'admin',
    enabledModules: ALL_MODULES,
  });
}

/** The eq filters of the first chain started against `key`. */
function filtersOf(stub: ReturnType<typeof makeSupabaseStub>, key: string): unknown[][] {
  const methods = stub.chainsAll.get(key)?.[0] ?? [];
  const args = stub.chainArgsAll.get(key)?.[0] ?? [];
  return args.filter((_, i) => methods[i] === 'eq');
}

function expectRecordedIn(org: string, event: string) {
  expect(audit).toHaveBeenCalledWith(
    expect.objectContaining({ event }),
    expect.objectContaining({ organizationId: org }),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('a write that changed no row answers not_found and leaves no audit row', () => {
  type Case = {
    name: string;
    /** `<table>.<op>` the stub answers for the write. */
    write: string;
    /** `<table>.select` the method reads first, when it does. */
    read?: string;
    row?: Record<string, unknown>;
    run: (stub: ReturnType<typeof makeSupabaseStub>, org: string) => Promise<unknown>;
    message: string;
    /** The audit event of the change, when the service records one. */
    event?: string;
  };

  const cases: Case[] = [
    {
      name: 'archiving a kit',
      write: 'bundles.update',
      run: (stub, org) => new BundlesService(ctxFor(stub, org)).archive(ROW_ID),
      message: 'Bundle not found',
      event: 'bundle.archived',
    },
    {
      name: 'restoring a kit',
      write: 'bundles.update',
      run: (stub, org) => new BundlesService(ctxFor(stub, org)).restore(ROW_ID),
      message: 'Bundle not found',
      event: 'bundle.restored',
    },
    {
      name: 'switching a kit on or off',
      write: 'bundles.update',
      run: (stub, org) => new BundlesService(ctxFor(stub, org)).setActive(ROW_ID, false),
      message: 'Bundle not found',
      event: 'bundle.updated',
    },
    {
      name: 'editing a warehouse',
      write: 'warehouses.update',
      read: 'warehouses.select',
      run: (stub, org) =>
        new WarehousesService(ctxFor(stub, org)).update(ROW_ID, { name: 'Example warehouse' }),
      message: 'Warehouse not found.',
      event: 'warehouse.updated',
    },
    {
      name: 'deleting a tag',
      write: 'tags.delete',
      run: (stub, org) => new TagsService(ctxFor(stub, org)).delete(ROW_ID),
      message: 'Tag not found',
      event: 'tag.deleted',
    },
    {
      name: 'deleting a unit conversion',
      write: 'uom_conversions.delete',
      run: (stub, org) => new UomConversionsService(ctxFor(stub, org)).delete(ROW_ID),
      message: 'Unit conversion not found.',
      event: 'uom_conversion.deleted',
    },
    {
      name: 'editing a charter',
      write: 'charters.update',
      run: (stub, org) =>
        new ChartersService(ctxFor(stub, org)).update(ROW_ID, { name: 'Example charter' }),
      message: 'Charter not found.',
      event: 'charter.updated',
    },
    {
      name: 'deleting a schedule event',
      write: 'schedule_events.delete',
      read: 'schedule_events.select',
      row: { ...B_ROW, title: 'Example event', status: 'scheduled', warehouse_id: null },
      run: (stub, org) => new ScheduleService(ctxFor(stub, org)).delete(ROW_ID),
      message: 'Event not found',
      event: 'schedule.deleted',
    },
    {
      name: 'deleting a vendor item mapping',
      write: 'vendor_item_mappings.delete',
      run: (stub, org) => new VendorItemMappingsService(ctxFor(stub, org)).delete(ROW_ID),
      message: 'Vendor item mapping not found.',
      event: 'vendor_mapping.deleted',
    },
    {
      name: 'opening a warehouse to public orders',
      write: 'warehouses.update',
      run: (stub, org) =>
        new OrderRequestsService(ctxFor(stub, org)).setWarehousePublicOrderable(ROW_ID, true),
      message: 'Warehouse not found.',
    },
    {
      name: 'revoking an invite',
      write: 'organization_invites.delete',
      run: (stub, org) => new TeamService(ctxFor(stub, org)).revokeInvite(ROW_ID),
      message: 'Invite not found',
    },
  ];

  function stubFor(c: Case) {
    const row = c.row ?? B_ROW;
    return makeSupabaseStub({
      [c.write]: writtenLikePostgrest([row]),
      ...(c.read ? { [c.read]: servedLikePostgrest([row]) } : {}),
    });
  }

  it.each(cases)(
    '$name: a row that is not in A is not found, and nothing is recorded',
    async (c) => {
      const stub = stubFor(c);

      await expect(c.run(stub, 'org-A')).rejects.toMatchObject({
        code: 'not_found',
        message: c.message,
      });

      expect(audit).not.toHaveBeenCalled();
      // Whatever was sent to the table was filtered to A, so B's row is as it was.
      const sent = stub.chainsAll.get(c.write)?.length ?? 0;
      if (sent > 0) {
        expect(filtersOf(stub, c.write)).toEqual(
          expect.arrayContaining([
            ['organization_id', 'org-A'],
            ['id', ROW_ID],
          ]),
        );
      }
    },
  );

  it.each(cases)('$name: working in B, the row changes and is recorded in B', async (c) => {
    const stub = stubFor(c);

    await c.run(stub, 'org-B');

    expect(filtersOf(stub, c.write)).toEqual(
      expect.arrayContaining([
        ['organization_id', 'org-B'],
        ['id', ROW_ID],
      ]),
    );
    if (c.event) expectRecordedIn('org-B', c.event);
  });

  it('a charter edit with nothing to change writes nothing and records nothing', async () => {
    const stubFor = () =>
      makeSupabaseStub({
        'charters.select': servedLikePostgrest([B_ROW]),
        'charters.update': writtenLikePostgrest([B_ROW]),
      });

    const inA = stubFor();
    await expect(
      new ChartersService(ctxFor(inA, 'org-A')).update(ROW_ID, {}),
    ).rejects.toMatchObject({ code: 'not_found', message: 'Charter not found.' });

    const inB = stubFor();
    await new ChartersService(ctxFor(inB, 'org-B')).update(ROW_ID, {});

    expect(inA.chainsAll.get('charters.update')).toBeUndefined();
    expect(inB.chainsAll.get('charters.update')).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });

  it('a warehouse that is not in A is refused before its charter list is read or written', async () => {
    const stub = makeSupabaseStub({
      'warehouses.select': servedLikePostgrest([B_ROW]),
      'warehouses.update': writtenLikePostgrest([B_ROW]),
    });

    await expect(
      new WarehousesService(ctxFor(stub, 'org-A')).update(ROW_ID, { charterIds: [] }),
    ).rejects.toMatchObject({ code: 'not_found', message: 'Warehouse not found.' });

    expect(stub.fromCalls).not.toContain('warehouse_charters');
    expect(stub.chainsAll.get('warehouses.update')).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });

  it("setting a warehouse's charters reads the warehouse in A first", async () => {
    const stub = makeSupabaseStub({
      'warehouses.select': servedLikePostgrest([B_ROW]),
      'warehouse_charters.select': { data: [], error: null },
      'warehouse_charters.insert': { data: null, error: null },
    });

    await expect(
      new WarehouseChartersService(ctxFor(stub, 'org-A')).setForWarehouse(ROW_ID, [
        '33333333-3333-4333-8333-333333333333',
      ]),
    ).rejects.toMatchObject({ code: 'not_found', message: 'Warehouse not found.' });

    expect(stub.fromCalls).not.toContain('warehouse_charters');
    expect(audit).not.toHaveBeenCalled();
  });

  it("working in B, a warehouse's charters are set and recorded in B", async () => {
    const stub = makeSupabaseStub({
      'warehouses.select': servedLikePostgrest([B_ROW]),
      'warehouse_charters.select': { data: [], error: null },
      'warehouse_charters.insert': { data: null, error: null },
    });

    await new WarehouseChartersService(ctxFor(stub, 'org-B')).setForWarehouse(ROW_ID, [
      '33333333-3333-4333-8333-333333333333',
    ]);

    expect(stub.chainsAll.get('warehouse_charters.insert')).toHaveLength(1);
    expectRecordedIn('org-B', 'warehouse_charters.updated');
  });
});

describe('a child row is written only after its parent is read in the active organization', () => {
  type Case = {
    name: string;
    parent: string;
    child: string;
    run: (stub: ReturnType<typeof makeSupabaseStub>, org: string) => Promise<unknown>;
    message: string;
  };

  const cases: Case[] = [
    {
      name: 'removing a price from a price list',
      parent: 'price_lists',
      child: 'price_list_items',
      run: (stub, org) => new CustomersService(ctxFor(stub, org)).removePrice(ROW_ID, ITEM_ID),
      message: 'Price list not found',
    },
    {
      name: "removing an item from a customer's catalog",
      parent: 'customers',
      child: 'customer_catalog',
      run: (stub, org) =>
        new CustomersService(ctxFor(stub, org)).removeCatalogItem(ROW_ID, ITEM_ID),
      message: 'Customer not found',
    },
    {
      name: "removing a customer's portal user",
      parent: 'customers',
      child: 'customer_users',
      run: (stub, org) => new CustomersService(ctxFor(stub, org)).removeUser(ROW_ID, USER_ID),
      message: 'Customer not found',
    },
  ];

  function stubFor(c: Case) {
    return makeSupabaseStub({
      [`${c.parent}.select`]: servedLikePostgrest([B_ROW]),
      [`${c.child}.delete`]: { data: null, error: null },
    });
  }

  it.each(cases)(
    '$name: a parent that is not in A is not found, and nothing is deleted',
    async (c) => {
      const stub = stubFor(c);

      await expect(c.run(stub, 'org-A')).rejects.toMatchObject({
        code: 'not_found',
        message: c.message,
      });

      expect(filtersOf(stub, `${c.parent}.select`)).toEqual(
        expect.arrayContaining([
          ['organization_id', 'org-A'],
          ['id', ROW_ID],
        ]),
      );
      expect(stub.chainsAll.get(`${c.child}.delete`)).toBeUndefined();
    },
  );

  it.each(cases)('$name: working in B, the row is deleted', async (c) => {
    const stub = stubFor(c);

    await c.run(stub, 'org-B');

    expect(stub.chainsAll.get(`${c.child}.delete`)).toHaveLength(1);
  });
});

describe('a write keyed by an id alone carries the active organization', () => {
  const B_SCAN = { ...B_ROW, created_by: 'user-test' };

  it('confirming a shelf scan that is not in A is not found, and the scan is not written', async () => {
    const stub = makeSupabaseStub({
      'cycle_count_ai_scans.update': writtenLikePostgrest([B_SCAN]),
    });

    await expect(
      new CycleCountsService(ctxFor(stub, 'org-A')).markAiScanConfirmed(ROW_ID),
    ).rejects.toMatchObject({
      code: 'not_found',
      message: 'Scan not found or no longer editable.',
    });

    expect(filtersOf(stub, 'cycle_count_ai_scans.update')).toEqual(
      expect.arrayContaining([
        ['organization_id', 'org-A'],
        ['id', ROW_ID],
      ]),
    );
  });

  it('working in B, the shelf scan is confirmed', async () => {
    const stub = makeSupabaseStub({
      'cycle_count_ai_scans.update': writtenLikePostgrest([B_SCAN]),
    });

    await expect(
      new CycleCountsService(ctxFor(stub, 'org-B')).markAiScanConfirmed(ROW_ID),
    ).resolves.toBeUndefined();
  });

  it("clearing an order's live delivery point is filtered to the active organization", async () => {
    const stub = makeSupabaseStub({ 'delivery_locations.delete': { data: null, error: null } });

    await new DeliveryTrackingService(ctxFor(stub, 'org-A')).purgeForOrder(ROW_ID);

    expect(filtersOf(stub, 'delivery_locations.delete')).toEqual(
      expect.arrayContaining([
        ['organization_id', 'org-A'],
        ['order_request_id', ROW_ID],
      ]),
    );
  });
});
