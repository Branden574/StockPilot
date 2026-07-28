import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildGroupKey, type ModuleId } from '@stockpilot/core';

import { makeServiceContext } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/ai/embeddings', () => ({ embedInventoryItem: vi.fn(async () => undefined) }));

import { InventoryService } from './inventory';
import { createItemsFromPoLines } from './po-imports-lines';

/**
 * R2, end to end: three size lines from ONE purchase order become ONE product
 * group.
 *
 * Every other test on this path mocks `InventoryService.create` and asserts
 * the ARGUMENT it received, which is exactly why the defect this covers
 * survived: `createItemsFromPoLines` passed `groupId: null` for a
 * `create_new_group` line and never passed `productGroup`, and `create()`
 * only find-or-creates a group when `productGroup` is present. Both halves
 * were individually "correct" and every line still landed `group_id = NULL`.
 *
 * So this test runs the REAL `InventoryService` against a STATEFUL stub: a
 * group inserted while line 1 is processed is readable by the time line 2
 * resolves, which is the only way "these three collapse onto one row" can be
 * asserted rather than assumed.
 */

const IMPORT_ID = '11111111-1111-4111-8111-111111111111';
const VENDOR_ID = '33333333-3333-4333-8333-333333333333';
const WAREHOUSE_ID = '44444444-4444-4444-8444-444444444444';
const CATEGORY_ID = '55555555-5555-4555-8555-555555555555';

const LINE_IDS = [
  '22222222-2222-4222-8222-22222222222a',
  '22222222-2222-4222-8222-22222222222b',
  '22222222-2222-4222-8222-22222222222c',
];

const SHOE_CATEGORY = {
  id: CATEGORY_ID,
  parent_id: null,
  tracking_mode: null,
  size_scale_id: null,
  default_unit_of_measure: 'pair',
  sports_subcategory_key: 'shoes',
  tracking_profile: null,
  deleted_at: null,
};

/** Three sizes of the SAME shoe, exactly as one PO prints them. */
function sizeRun() {
  return ['9', '10', '11'].map((size, i) => ({
    id: LINE_IDS[i],
    po_import_id: IMPORT_ID,
    line_number: i + 1,
    line_type: 'inventory',
    description: `Nike Pegasus 41 - US ${size}`,
    qty_ordered_original: 4,
    uom_original: 'PAIR',
    unit_cost: 90,
    vendor_item_number: null,
    vendor_product_number: 'FD2722',
    auxiliary_number: null,
    item_id: null,
    variant_size: size,
    variant_size_original: `US ${size}`,
    variant_size_system: 'US_MENS',
    variant_width: null,
    variant_fit: null,
    variant_color: null,
    jersey_number: null,
    player_name: null,
    group_hint: 'Nike Pegasus 41',
    serial_hint: null,
    suggested_group_id: null,
    mapping_confidence: null,
  }));
}

interface GroupRow {
  id: string;
  name: string;
  group_key: string;
  organization_id: string;
  subcategory_key: string;
  [k: string]: unknown;
}

/**
 * A stub that REMEMBERS. `product_groups` reads are served from the rows this
 * run inserted, so find-or-create can actually converge; `inventory_items`
 * insert rows are captured for the assertions.
 */
function statefulStub(lines: Array<Record<string, unknown>>) {
  const groups: GroupRow[] = [];
  const items: Array<Record<string, unknown>> = [];

  function chainFor(table: string) {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    const eqs: Record<string, unknown> = {};
    let payload: unknown = null;

    function resolve(): { data: unknown; error: null; count?: number } {
      if (table === 'po_imports') {
        return { data: { id: IMPORT_ID, status: 'parsed' }, error: null };
      }
      if (table === 'po_import_lines') {
        return op === 'select' ? { data: lines, error: null } : { data: null, error: null };
      }
      if (table === 'categories') return { data: SHOE_CATEGORY, error: null };
      if (table === 'organizations') return { data: { plan: 'enterprise' }, error: null };
      if (table === 'custom_field_definitions') return { data: [], error: null };
      if (table === 'product_groups') {
        if (op === 'insert') {
          const p = payload as Record<string, unknown>;
          const row = {
            ...p,
            id: `grp-${groups.length + 1}`,
            status: 'active',
          } as unknown as GroupRow;
          groups.push(row);
          return { data: row, error: null };
        }
        // findByKey / candidates: serve what has actually been created.
        const key = eqs.group_key as string | undefined;
        if (key != null) {
          return { data: groups.filter((g) => g.group_key === key), error: null };
        }
        return { data: [], error: null };
      }
      if (table === 'inventory_items') {
        if (op === 'insert') {
          const p = payload as Record<string, unknown>;
          const row = { ...p, id: `item-${items.length + 1}` };
          items.push(row);
          return { data: row, error: null };
        }
        // Plan-limit head count, barcode lookups, variantsByKey — all empty.
        return { data: [], error: null, count: 0 };
      }
      return { data: null, error: null };
    }

    const stub: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (res: (v: unknown) => void) => res(resolve());
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          return () => {
            const r = resolve();
            const data = Array.isArray(r.data) ? (r.data[0] ?? null) : r.data;
            return Promise.resolve({ ...r, data });
          };
        }
        return (...args: unknown[]) => {
          if (prop === 'insert' || prop === 'upsert') {
            op = 'insert';
            payload = args[0];
          } else if (prop === 'update') {
            op = 'update';
            payload = args[0];
          } else if (prop === 'delete') {
            op = 'delete';
          } else if (prop === 'eq') {
            eqs[String(args[0])] = args[1];
          }
          return new Proxy(stub, handler);
        };
      },
    };
    return new Proxy(stub, handler);
  }

  const client = {
    from: vi.fn((table: string) => chainFor(table)),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
  return { client, groups, items };
}

beforeEach(() => vi.clearAllMocks());

describe('createItemsFromPoLines — R2: a size run becomes ONE group', () => {
  it('creates exactly one product_groups row, and all three items share its id', async () => {
    const stub = statefulStub(sizeRun());
    const ctx = makeServiceContext(stub.client, {
      organizationId: 'org-test',
      role: 'admin',
      enabledModules: new Set<ModuleId>(['inventory', 'po_imports', 'sports']),
    });

    const r = await createItemsFromPoLines(
      {
        supabase: stub.client as never,
        organizationId: 'org-test',
        // The REAL service. A mock here cannot see the defect.
        inventorySvc: new InventoryService(ctx as never),
        mappingsSvc: { upsert: vi.fn(async () => {}) } as never,
        ctx: ctx as never,
      },
      {
        poImportId: IMPORT_ID,
        lineIds: LINE_IDS,
        vendorId: VENDOR_ID,
        warehouseId: WAREHOUSE_ID,
        categoryId: CATEGORY_ID,
      },
    );

    expect(r.created).toBe(3);

    // ONE group for the whole size run — the entire point of group-first
    // matching. Two would mean the second line failed to find the first's.
    expect(stub.groups).toHaveLength(1);
    const group = stub.groups[0]!;
    expect(group.group_key).toBe(
      buildGroupKey({
        subcategoryKey: 'shoes',
        model: 'Nike Pegasus 41',
        styleNumber: 'FD2722',
        name: 'Nike Pegasus 41',
      }),
    );

    // Three items, every one of them attached to it. `group_id = NULL` here is
    // the defect: invisible to the roll-up and to the next import's matcher.
    expect(stub.items).toHaveLength(3);
    for (const item of stub.items) {
      expect(item.group_id).toBe(group.id);
    }

    // Three DISTINCT variants, not one row three times.
    const keys = stub.items.map((i) => i.variant_key);
    expect(new Set(keys).size).toBe(3);
    expect(stub.items.map((i) => i.variant_size).sort()).toEqual(['10', '11', '9']);

    // R2: no fake serials anywhere on a counted variant.
    for (const item of stub.items) {
      expect(item.tracking_type).toBe('none');
    }
  });
});
