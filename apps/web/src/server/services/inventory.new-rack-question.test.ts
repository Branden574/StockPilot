import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { NEW_RACK_REQUIRES_CONFIRMATION, type ModuleId } from '@stockpilot/core';

import {
  callArgs,
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
  type SupabaseStub,
} from '@/test/supabase-mock';

/**
 * "Create new rack 1-B?" asked by the SERVER (2026-10-24).
 *
 * On 2026-09-24 an item meant for rack 17-B was saved as "1-B". A manual
 * create resolves-or-CREATES the rack its opening stock is typed onto, so a
 * new rack 1-B appeared in DC4 and 130 units moved onto it. The phone has
 * asked first since #249; the web item form never did, and the server created
 * whatever rack any caller typed.
 *
 * The rule pinned here: a manual create (one item, a size run, a duplicate)
 * whose typed rack does not exist is refused BEFORE anything is written,
 * unless the request carries the person's yes (`confirmNewRack`). The refusal
 * carries the words every client shows. An existing rack is never asked
 * about, and "exists" means exactly what the placement's own lookup means:
 * same organization, same warehouse, kind rack, not deleted.
 */

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
  auditMany: vi.fn(async (payloads: readonly unknown[]) => ({ written: payloads.length, lost: 0 })),
}));
vi.mock('@/lib/ai/embeddings', () => ({ embedInventoryItem: vi.fn(async () => undefined) }));

import { audit, auditMany } from './audit';
import { ServiceError } from './context';
import { InventoryService } from './inventory';

const ORG = 'org-test';

function location(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: ORG,
    warehouse_id: 'wh-1',
    kind: 'rack',
    name,
    deleted_at: null,
    ...over,
  };
}

/** DC4's racks, the set the phone guard's own test uses (create-rack-check.test.ts). */
const DC4_RACKS = ['17-B', '18-B', '20-A', '22-A', '35', '35-A', '36-A'].map((n) =>
  location(`rack-${n.toLowerCase()}`, n),
);

/**
 * Five rows named 1-B that are NOT DC4's rack 1-B: a crate, a Site
 * (locations.kind NULL is a Site), another warehouse's rack, a deleted rack
 * and another organization's rack. None of them may stop the question.
 */
const NOT_DC4_RACK_1B = [
  location('crate-1b', '1-B', { kind: 'crate' }),
  location('site-1b', '1-B', { kind: null }),
  location('rack-1b-wh2', '1-B', { warehouse_id: 'wh-2' }),
  location('rack-1b-gone', '1-B', { deleted_at: '2026-09-25T00:00:00Z' }),
  location('rack-1b-other-org', '1-B', { organization_id: 'org-other' }),
];

const LOCATIONS = [...DC4_RACKS, ...NOT_DC4_RACK_1B];

const WAREHOUSES = [
  { id: 'wh-1', organization_id: ORG, name: 'DC4' },
  { id: 'wh-2', organization_id: ORG, name: 'DC5' },
];

const INCIDENT_MESSAGE =
  '1-B does not exist in DC4 yet. Continuing creates it and moves 130 units into it. Did you mean 17-B or 18-B?';

const BASE = {
  name: 'Test item',
  unitCost: 0,
  retailPrice: 0,
  quantityOnHand: 130,
  reorderPoint: 0,
  reorderQuantity: 0,
  trackingType: 'none' as const,
  itemType: 'product' as const,
  customFields: {},
  status: 'active' as const,
  expiryPolicy: 'warn' as const,
  warehouseId: 'wh-1',
  binLocation: '1-B',
};

function buildStub(over: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    // Plan-limit head count + the org's plan (enterprise = unlimited).
    'inventory_items.select': { data: null, error: null, count: 0 },
    'organizations.select': { data: { plan: 'enterprise' }, error: null },
    'custom_field_definitions.select': { data: [], error: null },
    'inventory_items.insert': { data: { id: 'item-new' }, error: null },
    'stock_movements.insert': { data: null, error: null },
    // Answered like PostgREST: the lookup's own filters decide what it sees.
    'locations.select': servedLikePostgrest(LOCATIONS),
    'locations.insert': { data: { id: 'rack-1b-new' }, error: null },
    'warehouses.select': servedLikePostgrest(WAREHOUSES),
    // The 0199 trigger seeded the opening stock in the warehouse's Unplaced.
    'item_stock_levels.select': {
      data: [{ item_id: 'item-new', location_id: 'unplaced-wh1', quantity: 130 }],
      error: null,
    },
    'rpc:transfer_stock': { data: null, error: null },
    ...over,
  });
}

/** Every (table, op) that is not a read, and every database function called. */
function writes(stub: SupabaseStub): string[] {
  return [
    ...[...stub.chainsAll.keys()].filter((k) => !k.endsWith('.select')),
    ...stub.rpcCalls.map((c) => `rpc:${c.name}`),
  ];
}

function createdRack(stub: SupabaseStub) {
  return stub.chainArgs.get('locations.insert')?.[0]?.[0] as Record<string, unknown> | undefined;
}

function transferTargets(stub: SupabaseStub) {
  return stub.rpcCalls
    .filter((c) => c.name === 'transfer_stock')
    .map((c) => (c.args as { p_to_location_id: string }).p_to_location_id);
}

async function refusal(promise: Promise<unknown>): Promise<ServiceError> {
  const e = await promise.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ServiceError);
  return e as ServiceError;
}

let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe('InventoryService.create asks before it creates a rack', () => {
  it('refuses a rack that does not exist before anything is written, in the words the phone uses', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    const e = await refusal(svc.create({ ...BASE }));

    expect(e.code).toBe('conflict');
    expect(e.message).toBe(INCIDENT_MESSAGE);
    expect(e.details).toEqual({
      reason: NEW_RACK_REQUIRES_CONFIRMATION,
      label: '1-B',
      title: 'Create new rack 1-B?',
      message: INCIDENT_MESSAGE,
      suggestions: ['17-B', '18-B'],
      canCreateRack: true,
    });
    // Nothing at all was written: no item, no ledger row, no rack, no move.
    expect(writes(stub)).toEqual([]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
    expect(vi.mocked(auditMany)).not.toHaveBeenCalled();
  });

  it('does not count a crate, a Site, another warehouse, a deleted rack or another organization as rack 1-B', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    // All five decoys are named 1-B. The refusal above already proves none of
    // them counted; this pins the filters that make it so.
    await refusal(svc.create({ ...BASE }));

    const lookup = stub.chainArgsAll.get('locations.select')?.[0] ?? [];
    expect(lookup).toEqual(
      expect.arrayContaining([
        ['organization_id', ORG],
        ['warehouse_id', 'wh-1'],
        ['kind', 'rack'],
        ['deleted_at', null],
      ]),
    );
  });

  it('treats confirmNewRack false the same as no answer', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    const e = await refusal(svc.create({ ...BASE, confirmNewRack: false }));

    expect(e.details?.reason).toBe(NEW_RACK_REQUIRES_CONFIRMATION);
    expect(writes(stub)).toEqual([]);
  });

  it('creates the rack and places the stock on it once the person confirmed it', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    const item = await svc.create({ ...BASE, confirmNewRack: true });

    expect(item).toEqual({ id: 'item-new', placementFailed: null });
    expect(createdRack(stub)).toMatchObject({
      organization_id: ORG,
      warehouse_id: 'wh-1',
      name: '1-B',
      kind: 'rack',
      type: 'shelf',
      rack_number: '1',
      rack_row: 'B',
    });
    expect(transferTargets(stub)).toEqual(['rack-1b-new']);
    // A confirmed create does not ask, so it never reads the words' inputs.
    expect(stub.fromCalls).not.toContain('warehouses');
  });

  it('never asks about a rack that exists, however it is typed, and creates nothing', async () => {
    for (const typed of ['17-B', '17-b', '17 - B']) {
      const stub = buildStub();
      const svc = new InventoryService(makeServiceContext(stub.client));

      const item = await svc.create({ ...BASE, binLocation: typed });

      expect(item).toEqual({ id: 'item-new', placementFailed: null });
      expect(createdRack(stub)).toBeUndefined();
      expect(transferTargets(stub)).toEqual(['rack-17-b']);
      // Found on the first read: no near-match list, no warehouse name.
      expect(stub.fromCalls).not.toContain('warehouses');
    }
  });

  it("asks nothing about a label that is another warehouse's existing rack", async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    const item = await svc.create({ ...BASE, warehouseId: 'wh-2' });

    expect(item).toEqual({ id: 'item-new', placementFailed: null });
    expect(createdRack(stub)).toBeUndefined();
    expect(transferTargets(stub)).toEqual(['rack-1b-wh2']);
  });

  it('asks nothing when no stock would move onto a rack: no opening quantity, or no rack typed', async () => {
    for (const over of [
      { quantityOnHand: 0 },
      { binLocation: '' },
      { binLocation: '   ' },
      { binLocation: undefined },
    ]) {
      const stub = buildStub();
      const svc = new InventoryService(makeServiceContext(stub.client));

      await expect(svc.create({ ...BASE, ...over })).resolves.toMatchObject({ id: 'item-new' });

      expect(stub.fromCalls).not.toContain('locations');
    }
  });

  it('asks nothing on the PO, PO-import and CSV-import creates, which never place on a rack', async () => {
    const paths = [
      { awaitingFirstReceipt: true },
      { awaitingFirstReceipt: true, source: 'import' as const },
      { planSlot: { release: () => {} } },
    ];
    for (const opts of paths) {
      const stub = buildStub();
      const svc = new InventoryService(makeServiceContext(stub.client));

      await expect(svc.create({ ...BASE }, opts)).resolves.toMatchObject({ id: 'item-new' });

      expect(stub.fromCalls).not.toContain('locations');
    }
  });

  it('still creates the rack for a caller nobody can ask (a restore, the phone build that asks on its own screen)', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    const item = await svc.create({ ...BASE }, { allowUnconfirmedNewRack: true });

    expect(item).toEqual({ id: 'item-new', placementFailed: null });
    expect(createdRack(stub)).toMatchObject({ name: '1-B', kind: 'rack', warehouse_id: 'wh-1' });
    expect(transferTargets(stub)).toEqual(['rack-1b-new']);
  });

  it('does not create a rack that disappeared after the question: the stock stays in Unplaced and the caller is told', async () => {
    let reads = 0;
    const stub = buildStub({
      // 17-B exists when the question looks, and is gone when the placement does.
      'locations.select': servedLikePostgrest(() =>
        reads++ === 0 ? LOCATIONS : LOCATIONS.filter((l) => l.name !== '17-B'),
      ),
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const item = await svc.create({ ...BASE, binLocation: '17-B' });

    expect(item).toEqual({ id: 'item-new', placementFailed: { rackName: '17-B', count: 1 } });
    expect(createdRack(stub)).toBeUndefined();
    expect(transferTargets(stub)).toEqual([]);
  });

  it('uses a rack someone else created between the two reads, without asking', async () => {
    let reads = 0;
    const late = location('rack-1b-late', '1-B');
    const stub = buildStub({
      // Missing on the existence read, present on the near-match read after it.
      'locations.select': servedLikePostgrest(() =>
        reads++ === 0 ? LOCATIONS : [...LOCATIONS, late],
      ),
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const item = await svc.create({ ...BASE });

    expect(item).toEqual({ id: 'item-new', placementFailed: null });
    expect(createdRack(stub)).toBeUndefined();
    expect(transferTargets(stub)).toEqual(['rack-1b-late']);
  });

  it('refuses rather than guesses when the rack lookup fails, and writes nothing', async () => {
    const stub = buildStub({
      'locations.select': { data: null, error: { message: 'connection reset' } },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const e = await refusal(svc.create({ ...BASE }));

    expect(e.code).toBe('internal_error');
    expect(writes(stub)).toEqual([]);
  });

  it('still asks when the near-matches or the warehouse name cannot be read, just with fewer words', async () => {
    const stub = buildStub({
      'locations.select': (call: MockCall) =>
        callArgs(call, 'select')?.[0] === 'id, name'
          ? { data: null, error: { message: 'statement timeout' } }
          : servedLikePostgrest(LOCATIONS)(call),
      'warehouses.select': { data: null, error: { message: 'statement timeout' } },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const e = await refusal(svc.create({ ...BASE }));

    expect(e.details).toEqual({
      reason: NEW_RACK_REQUIRES_CONFIRMATION,
      label: '1-B',
      title: 'Create new rack 1-B?',
      message: '1-B does not exist yet. Continuing creates it and moves 130 units into it.',
      suggestions: [],
      canCreateRack: true,
    });
    expect(writes(stub)).toEqual([]);
  });

  // 2026-10-25 review. Creating the rack needs Manage locations
  // (LocationsService.create) and moving the stock onto it needs Transfer
  // stock (transferStock). The Staff preset has items:create and
  // stock:transfer but not locations:manage, so a Staff yes never created the
  // rack: the create was refused, caught, and the stock stayed in Unplaced
  // right after a question that promised the move.
  describe('a member whose yes cannot put the stock on the new rack', () => {
    const STAFF_MESSAGE =
      '1-B does not exist in DC4 yet, and creating a rack needs the Manage locations permission. Saving does not put the 130 units on a rack. Did you mean 17-B or 18-B?';

    it('a Staff member is told they cannot create the rack, and nothing is written', async () => {
      const stub = buildStub();
      const svc = new InventoryService(makeServiceContext(stub.client, { role: 'staff' }));

      const e = await refusal(svc.create({ ...BASE }));

      expect(e.code).toBe('conflict');
      expect(e.message).toBe(STAFF_MESSAGE);
      expect(e.details).toEqual({
        reason: NEW_RACK_REQUIRES_CONFIRMATION,
        label: '1-B',
        title: 'Rack 1-B does not exist',
        message: STAFF_MESSAGE,
        suggestions: ['17-B', '18-B'],
        canCreateRack: false,
      });
      expect(writes(stub)).toEqual([]);
    });

    it("a Staff member's Save anyway saves the item, creates no rack, moves nothing, and says so", async () => {
      const stub = buildStub();
      const svc = new InventoryService(makeServiceContext(stub.client, { role: 'staff' }));

      const item = await svc.create({ ...BASE, confirmNewRack: true });

      expect(item).toEqual({ id: 'item-new', placementFailed: { rackName: '1-B', count: 1 } });
      expect(createdRack(stub)).toBeUndefined();
      expect(transferTargets(stub)).toEqual([]);
      // No create is attempted only to be refused: nothing to log as a failure.
      expect(errorSpy).not.toHaveBeenCalledWith(
        '[rack place] rack create failed',
        expect.anything(),
      );
    });

    it('the phone build that asks on its own screen gets the same result for a Staff member', async () => {
      const stub = buildStub();
      const svc = new InventoryService(makeServiceContext(stub.client, { role: 'staff' }));

      const item = await svc.create({ ...BASE }, { allowUnconfirmedNewRack: true });

      expect(item).toEqual({ id: 'item-new', placementFailed: { rackName: '1-B', count: 1 } });
      expect(createdRack(stub)).toBeUndefined();
      expect(transferTargets(stub)).toEqual([]);
    });

    it('a Staff member saving onto an existing rack is not asked, and the stock is placed', async () => {
      const stub = buildStub();
      const svc = new InventoryService(makeServiceContext(stub.client, { role: 'staff' }));

      const item = await svc.create({ ...BASE, binLocation: '17-B' });

      expect(item).toEqual({ id: 'item-new', placementFailed: null });
      expect(transferTargets(stub)).toEqual(['rack-17-b']);
    });

    it('a Staff member granted Manage locations is asked the ordinary question, and the yes creates the rack', async () => {
      const stub = buildStub();
      const ctx = makeServiceContext(stub.client, {
        role: 'staff',
        permissions: new Set(['items:create', 'stock:transfer', 'locations:manage']),
      });

      const e = await refusal(new InventoryService(ctx).create({ ...BASE }));
      expect(e.details).toMatchObject({ title: 'Create new rack 1-B?', canCreateRack: true });

      const item = await new InventoryService(ctx).create({ ...BASE, confirmNewRack: true });
      expect(item).toEqual({ id: 'item-new', placementFailed: null });
      expect(transferTargets(stub)).toEqual(['rack-1b-new']);
    });

    it('a member who may create racks but not move stock is told that, and the yes leaves no empty rack', async () => {
      const stub = buildStub();
      const ctx = makeServiceContext(stub.client, {
        role: 'manager',
        permissions: new Set(['items:create', 'locations:manage']),
      });

      const e = await refusal(new InventoryService(ctx).create({ ...BASE }));
      expect(e.details).toMatchObject({
        title: 'Rack 1-B does not exist',
        message:
          '1-B does not exist in DC4 yet, and moving stock onto a rack needs the Transfer stock permission. Saving does not put the 130 units on a rack. Did you mean 17-B or 18-B?',
        canCreateRack: false,
      });

      const item = await new InventoryService(ctx).create({ ...BASE, confirmNewRack: true });
      expect(item).toEqual({ id: 'item-new', placementFailed: { rackName: '1-B', count: 1 } });
      // Before: the rack was created, then the move was refused, and an empty
      // rack nobody asked for was left in the warehouse.
      expect(createdRack(stub)).toBeUndefined();
      expect(transferTargets(stub)).toEqual([]);
    });
  });

  describe('a refused sports create leaves no product group behind', () => {
    const SPORTS_ON = new Set<ModuleId>(['inventory', 'sports']);
    const shoes = {
      id: 'cat-1',
      parent_id: null,
      tracking_mode: null,
      size_scale_id: 'scale-1',
      default_unit_of_measure: null,
      sports_subcategory_key: 'shoes',
      tracking_profile: null,
      deleted_at: null,
    };
    const SHOE = {
      ...BASE,
      categoryId: 'cat-1',
      variantSize: '10',
      variantSizeSystem: 'US_MENS' as const,
      productGroup: {
        name: 'Nike Pegasus 41',
        brand: 'Nike',
        defaultCountingUnit: 'pair' as const,
      },
    };
    const sportsStub = (over: Record<string, unknown> = {}) =>
      buildStub({
        'categories.select': { data: shoes, error: null },
        'size_scales.select': { data: { id: 'scale-1', size_system: 'US_MENS' }, error: null },
        'size_scale_values.select': { data: [], error: null },
        'product_groups.select': { data: null, error: null },
        'product_groups.insert': { data: { id: 'grp-new' }, error: null },
        ...over,
      });

    it('for its new rack', async () => {
      const stub = sportsStub();
      const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });

      const e = await refusal(new InventoryService(ctx).create({ ...SHOE }));

      expect(e.details?.reason).toBe(NEW_RACK_REQUIRES_CONFIRMATION);
      expect(stub.fromCalls).not.toContain('product_groups');
      expect(writes(stub)).toEqual([]);
    });

    // The warehouse and charter checks used to run after the group was
    // found-or-created, so this refusal left an empty group behind.
    it('for its charter', async () => {
      const stub = sportsStub({ 'warehouse_charters.select': { data: null, error: null } });
      const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });

      const e = await refusal(
        new InventoryService(ctx).create({ ...SHOE, binLocation: undefined, charterId: 'ch-1' }),
      );

      expect(e.code).toBe('validation_error');
      expect(e.message).toMatch(/charter is not serviced/);
      expect(stub.fromCalls).not.toContain('product_groups');
      expect(writes(stub)).toEqual([]);
    });

    it('and a confirmed one still saves its group', async () => {
      const stub = sportsStub();
      const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });

      await new InventoryService(ctx).create({ ...SHOE, confirmNewRack: true });

      expect(stub.chainArgs.get('product_groups.insert')).toBeDefined();
      expect(transferTargets(stub)).toEqual(['rack-1b-new']);
    });
  });
});

describe('InventoryService.bulkCreateSizedVariants asks once for the whole run', () => {
  const categoryRow = {
    id: 'cat-1',
    parent_id: null,
    tracking_mode: null,
    size_scale_id: null,
    default_unit_of_measure: null,
    sports_subcategory_key: null,
    tracking_profile: null,
    deleted_at: null,
  };
  const RUN = {
    baseName: 'Nike Vapor',
    baseSku: 'SP-VAPOR',
    baseBarcode: null,
    description: null,
    categoryId: 'cat-1',
    supplierId: null,
    warehouseId: 'wh-1',
    charterId: null,
    primaryLocationId: null,
    binLocation: '1-B',
    rackNumber: '1',
    rackRow: 'B',
    retailPrice: 0,
    unitCost: 0,
    reorderPoint: 0,
    reorderQuantity: 0,
    variants: [
      { size: '9', quantity: 3 },
      { size: '9.5', quantity: 5 },
      { size: '10', quantity: 7 },
      { size: '11', quantity: 0 },
    ],
  };
  const INSERTED = [
    {
      id: 'v-9',
      name: 'Nike Vapor - 9',
      sku: 'SP-VAPOR-9',
      quantity_on_hand: 3,
      primary_location_id: null,
    },
    {
      id: 'v-95',
      name: 'Nike Vapor - 9.5',
      sku: 'SP-VAPOR-9.5',
      quantity_on_hand: 5,
      primary_location_id: null,
    },
    {
      id: 'v-10',
      name: 'Nike Vapor - 10',
      sku: 'SP-VAPOR-10',
      quantity_on_hand: 7,
      primary_location_id: null,
    },
    {
      id: 'v-11',
      name: 'Nike Vapor - 11',
      sku: 'SP-VAPOR-11',
      quantity_on_hand: 0,
      primary_location_id: null,
    },
  ];
  const runStub = (over: Record<string, unknown> = {}) =>
    buildStub({
      'categories.select': { data: categoryRow, error: null },
      'inventory_items.insert': { data: INSERTED, error: null },
      'item_stock_levels.select': {
        data: [
          { item_id: 'v-9', location_id: 'seed-v-9', quantity: 3 },
          { item_id: 'v-95', location_id: 'seed-v-95', quantity: 5 },
          { item_id: 'v-10', location_id: 'seed-v-10', quantity: 7 },
        ],
        error: null,
      },
      ...over,
    });

  it('refuses an unconfirmed new rack before any size is written, counting every stocked size', async () => {
    const stub = runStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    const e = await refusal(svc.bulkCreateSizedVariants({ ...RUN }));

    expect(e.code).toBe('conflict');
    expect(e.details).toEqual({
      reason: NEW_RACK_REQUIRES_CONFIRMATION,
      label: '1-B',
      title: 'Create new rack 1-B?',
      message:
        '1-B does not exist in DC4 yet. Continuing creates it and moves 15 units into it. Did you mean 17-B or 18-B?',
      suggestions: ['17-B', '18-B'],
      canCreateRack: true,
    });
    expect(writes(stub)).toEqual([]);
  });

  it('creates the rack once and places every stocked size on it when confirmed', async () => {
    const stub = runStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    const out = await svc.bulkCreateSizedVariants({ ...RUN, confirmNewRack: true });

    expect(out.placementFailed).toBeNull();
    expect(stub.chainArgsAll.get('locations.insert')).toHaveLength(1);
    expect(createdRack(stub)).toMatchObject({ name: '1-B', kind: 'rack', warehouse_id: 'wh-1' });
    expect(transferTargets(stub)).toEqual(['rack-1b-new', 'rack-1b-new', 'rack-1b-new']);
  });

  it('never asks about an existing rack', async () => {
    const stub = runStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    const out = await svc.bulkCreateSizedVariants({
      ...RUN,
      binLocation: '17-B',
      rackNumber: '17',
      rackRow: 'B',
    });

    expect(out.placementFailed).toBeNull();
    expect(createdRack(stub)).toBeUndefined();
    expect(transferTargets(stub)).toEqual(['rack-17-b', 'rack-17-b', 'rack-17-b']);
  });

  it('tells a Staff member once for the run, and Save anyway places no size and creates no rack', async () => {
    const stub = runStub();
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'staff' }));

    const e = await refusal(svc.bulkCreateSizedVariants({ ...RUN }));
    expect(e.details).toMatchObject({
      title: 'Rack 1-B does not exist',
      message:
        '1-B does not exist in DC4 yet, and creating a rack needs the Manage locations permission. Saving does not put the 15 units on a rack. Did you mean 17-B or 18-B?',
      canCreateRack: false,
    });
    expect(writes(stub)).toEqual([]);

    const out = await svc.bulkCreateSizedVariants({ ...RUN, confirmNewRack: true });
    expect(out.placementFailed).toEqual({ rackName: '1-B', count: 3 });
    expect(createdRack(stub)).toBeUndefined();
    expect(transferTargets(stub)).toEqual([]);
  });

  it('asks nothing for a run with no stock, and keeps creating for the phone build that asks on its own screen', async () => {
    const empty = runStub({
      'inventory_items.insert': {
        data: INSERTED.map((r) => ({ ...r, quantity_on_hand: 0 })),
        error: null,
      },
    });
    await expect(
      new InventoryService(makeServiceContext(empty.client)).bulkCreateSizedVariants({
        ...RUN,
        variants: RUN.variants.map((v) => ({ ...v, quantity: 0 })),
      }),
    ).resolves.toMatchObject({ placementFailed: null });
    expect(empty.fromCalls).not.toContain('locations');

    const legacy = runStub();
    await new InventoryService(makeServiceContext(legacy.client)).bulkCreateSizedVariants(
      { ...RUN },
      { allowUnconfirmedNewRack: true },
    );
    expect(createdRack(legacy)).toMatchObject({ name: '1-B', kind: 'rack' });
  });

  describe('a refused sports run leaves no product group behind', () => {
    const SPORTS_ON = new Set<ModuleId>(['inventory', 'sports']);
    const shoesRun = (over: Record<string, unknown> = {}) =>
      runStub({
        'categories.select': {
          data: { ...categoryRow, sports_subcategory_key: 'shoes', size_scale_id: 'scale-1' },
          error: null,
        },
        'size_scales.select': { data: { id: 'scale-1', size_system: 'US_MENS' }, error: null },
        'size_scale_values.select': { data: [], error: null },
        'product_groups.select': { data: null, error: null },
        'product_groups.insert': { data: { id: 'grp-new' }, error: null },
        ...over,
      });
    const GROUP = { name: 'Nike Vapor', brand: 'Nike', defaultCountingUnit: 'pair' as const };

    it('for its new rack', async () => {
      const stub = shoesRun();
      const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });

      const e = await refusal(
        new InventoryService(ctx).bulkCreateSizedVariants({ ...RUN, productGroup: GROUP }),
      );

      expect(e.details?.reason).toBe(NEW_RACK_REQUIRES_CONFIRMATION);
      expect(stub.fromCalls).not.toContain('product_groups');
      expect(writes(stub)).toEqual([]);
    });

    // The custom-field, warehouse and charter checks used to run after the
    // group was found-or-created, so this refusal left an empty group behind.
    it('for its charter', async () => {
      const stub = shoesRun({ 'warehouse_charters.select': { data: null, error: null } });
      const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });

      const e = await refusal(
        new InventoryService(ctx).bulkCreateSizedVariants({
          ...RUN,
          binLocation: null,
          charterId: 'ch-1',
          productGroup: GROUP,
        }),
      );

      expect(e.message).toMatch(/charter is not serviced/);
      expect(stub.fromCalls).not.toContain('product_groups');
      expect(writes(stub)).toEqual([]);
    });
  });
});

describe('InventoryService.duplicateItem asks before the copy is made', () => {
  const DUP = {
    originalId: '00000000-0000-0000-0000-000000000001',
    itemType: 'product' as const,
    rackNumber: '1',
    rackRow: 'B',
    quantity: 4,
  };
  const dupStub = () =>
    buildStub({
      'inventory_items.select': { data: { sku: 'SP-POLO', warehouse_id: 'wh-1' }, error: null },
      'rpc:duplicate_inventory_item': { data: 'dup-1', error: null },
      'item_stock_levels.select': {
        data: [{ item_id: 'dup-1', location_id: 'site-dc4', quantity: 4 }],
        error: null,
      },
    });

  it('refuses a copy onto a rack that does not exist, before the copy is made', async () => {
    const stub = dupStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    const e = await refusal(svc.duplicateItem({ ...DUP } as never));

    expect(e.code).toBe('conflict');
    expect(e.message).toBe(
      '1-B does not exist in DC4 yet. Continuing creates it and moves 4 units into it. Did you mean 17-B or 18-B?',
    );
    expect(writes(stub)).toEqual([]);
  });

  it('makes the copy, creates the rack and moves the stock onto it when confirmed', async () => {
    const stub = dupStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.duplicateItem({ ...DUP, confirmNewRack: true } as never)).resolves.toEqual({
      id: 'dup-1',
      placementFailed: null,
    });

    expect(createdRack(stub)).toMatchObject({ name: '1-B', kind: 'rack', warehouse_id: 'wh-1' });
    expect(transferTargets(stub)).toEqual(['rack-1b-new']);
  });

  it('never asks about an existing rack', async () => {
    const stub = dupStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(
      svc.duplicateItem({ ...DUP, rackNumber: '17', rackRow: 'B' } as never),
    ).resolves.toEqual({ id: 'dup-1', placementFailed: null });

    expect(createdRack(stub)).toBeUndefined();
    expect(transferTargets(stub)).toEqual(['rack-17-b']);
  });

  it('never asks about a book copy, which is not placed by the duplicate', async () => {
    const stub = dupStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(
      svc.duplicateItem({
        ...DUP,
        itemType: 'book',
        crateColor: 'blue',
        crateNumber: '1',
      } as never),
    ).resolves.toEqual({ id: 'dup-1', placementFailed: null });

    expect(stub.fromCalls).not.toContain('locations');
    expect(createdRack(stub)).toBeUndefined();
  });

  // 2026-10-25 review: a copy whose stock did not reach its rack was reported
  // only to Sentry, and the dialog said "Duplicated" over stock left at the
  // original's site. The copy's outcome now comes back, as create()'s does.
  it("tells a Staff member they cannot create the rack, and Save anyway's copy reports its stock not placed", async () => {
    const stub = dupStub();
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'staff' }));

    const e = await refusal(svc.duplicateItem({ ...DUP } as never));
    expect(e.details).toMatchObject({
      title: 'Rack 1-B does not exist',
      message:
        '1-B does not exist in DC4 yet, and creating a rack needs the Manage locations permission. Saving does not put the 4 units on a rack. Did you mean 17-B or 18-B?',
      canCreateRack: false,
    });
    expect(writes(stub)).toEqual([]);

    await expect(svc.duplicateItem({ ...DUP, confirmNewRack: true } as never)).resolves.toEqual({
      id: 'dup-1',
      placementFailed: { rackName: '1-B', count: 1 },
    });
    expect(createdRack(stub)).toBeUndefined();
    expect(transferTargets(stub)).toEqual([]);
  });

  it('reports a copy whose move onto an existing rack failed', async () => {
    const stub = buildStub({
      'inventory_items.select': { data: { sku: 'SP-POLO', warehouse_id: 'wh-1' }, error: null },
      'rpc:duplicate_inventory_item': { data: 'dup-1', error: null },
      'item_stock_levels.select': {
        data: [{ item_id: 'dup-1', location_id: 'site-dc4', quantity: 4 }],
        error: null,
      },
      'rpc:transfer_stock': { data: null, error: { message: 'insufficient stock' } },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(
      svc.duplicateItem({ ...DUP, rackNumber: '17', rackRow: 'B' } as never),
    ).resolves.toEqual({ id: 'dup-1', placementFailed: { rackName: '17-B', count: 1 } });
  });

  it('reports the copy as not placed when the placement itself fails', async () => {
    const stub = dupStub();
    const svc = new InventoryService(makeServiceContext(stub.client));
    const place = vi
      .spyOn(
        InventoryService.prototype as unknown as {
          placeManualCreateOnRack: (...args: unknown[]) => Promise<unknown>;
        },
        'placeManualCreateOnRack',
      )
      .mockRejectedValueOnce(new Error('connection reset'));

    try {
      await expect(
        svc.duplicateItem({ ...DUP, rackNumber: '17', rackRow: 'B' } as never),
      ).resolves.toEqual({ id: 'dup-1', placementFailed: { rackName: '17-B', count: 1 } });
    } finally {
      place.mockRestore();
    }
  });
});
