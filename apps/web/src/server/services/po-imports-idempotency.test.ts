import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildGroupKey, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Task 15 — import idempotency.
 *
 * The requirement (verbatim): "batch id + source-row identity + idempotency
 * key + org scope + resulting txn id. Distinguish same-request retry from an
 * intentional second shipment — never permanently block a file hash."
 *
 * Four surfaces carry this:
 *   1. `createItemsFromPoLines` — a line already carrying `item_id` is a
 *      RETRY (source-row identity), not a second shipment.
 *   2. `ProductGroupsService.findOrCreate` — the 23505 race (Task 8) makes a
 *      concurrent retry converge on ONE group instead of erroring or forking.
 *   3. `createFromUpload` — the file hash (idempotency key) is freed, never
 *      permanently blocked, once its predecessor's PO is cancelled (migs
 *      0286/0287); the group/variant identity created under the dead
 *      predecessor is NOT recreated.
 *   4. `approve()` — the header's own status is the txn-id guard: a second
 *      approve on an already-approved import is refused before it can touch
 *      the ledger a second time.
 */

vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('@/lib/ai/embeddings', () => ({ embedInventoryItem: vi.fn(async () => undefined) }));

import { InventoryService } from './inventory';
import { createItemsFromPoLines } from './po-imports-lines';
import { PoImportsService } from './po-imports';
import { ProductGroupsService } from './product-groups';

const IMPORT_ID = '11111111-1111-4111-8111-111111111111';
const VENDOR_ID = '33333333-3333-4333-8333-333333333333';
const WAREHOUSE_ID = '44444444-4444-4444-8444-444444444444';
const CATEGORY_ID = '55555555-5555-4555-8555-555555555555';
const LINE_A = '22222222-2222-4222-8222-22222222222a';
const LINE_B = '22222222-2222-4222-8222-22222222222b';

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

function sizeLine(id: string, lineNumber: number, size: string) {
  return {
    id,
    po_import_id: IMPORT_ID,
    line_number: lineNumber,
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
  };
}

interface GroupRow {
  id: string;
  name: string;
  group_key: string;
  [k: string]: unknown;
}

/**
 * A STATEFUL stub whose `po_import_lines`, `product_groups` and
 * `inventory_items` tables all REMEMBER writes across multiple calls made
 * against the SAME stub instance. This is the only way a "run it twice" test
 * can prove convergence rather than assume it: the second call re-reads
 * exactly what the first call wrote.
 */
function makeConvergenceStub(opts: {
  lines: Array<Record<string, unknown>>;
  category?: Record<string, unknown> | null;
  seedGroups?: GroupRow[];
  seedItems?: Array<Record<string, unknown>>;
  importStatus?: string;
}) {
  const lines = opts.lines.map((l) => ({ ...l }));
  const groups: GroupRow[] = [...(opts.seedGroups ?? [])];
  const items: Array<Record<string, unknown>> = [...(opts.seedItems ?? [])];
  const fromCalls: string[] = [];

  function chainFor(table: string) {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    const eqs: Record<string, unknown> = {};
    let payload: unknown = null;

    function resolve(): { data: unknown; error: null; count?: number } {
      if (table === 'po_imports') {
        return { data: { id: IMPORT_ID, status: opts.importStatus ?? 'parsed' }, error: null };
      }
      if (table === 'po_import_lines') {
        if (op === 'update') {
          const id = eqs.id as string | undefined;
          const idx = lines.findIndex((l) => l.id === id);
          if (idx >= 0) lines[idx] = { ...lines[idx], ...(payload as Record<string, unknown>) };
          return { data: null, error: null };
        }
        return { data: lines, error: null };
      }
      if (table === 'categories') return { data: opts.category ?? null, error: null };
      if (table === 'organizations') return { data: { plan: 'enterprise' }, error: null };
      if (table === 'custom_field_definitions') return { data: [], error: null };
      if (table === 'product_groups') {
        if (op === 'insert') {
          const p = payload as Record<string, unknown>;
          const row = { ...p, id: `grp-${groups.length + 1}`, status: 'active' } as unknown as GroupRow;
          groups.push(row);
          return { data: row, error: null };
        }
        const key = eqs.group_key as string | undefined;
        if (key != null) return { data: groups.filter((g) => g.group_key === key), error: null };
        return { data: [], error: null };
      }
      if (table === 'inventory_items') {
        if (op === 'insert') {
          const p = payload as Record<string, unknown>;
          const row = { ...p, id: `item-${items.length + 1}` };
          items.push(row);
          return { data: row, error: null };
        }
        const id = eqs.id as string | undefined;
        if (id != null) {
          const hit = items.find((i) => i.id === id);
          return { data: hit ? [hit] : [], error: null, count: hit ? 1 : 0 };
        }
        const groupId = eqs.group_id as string | undefined;
        const variantKey = eqs.variant_key as string | undefined;
        if (groupId != null && variantKey != null) {
          const matches = items.filter((i) => i.group_id === groupId && i.variant_key === variantKey);
          return { data: matches, error: null, count: matches.length };
        }
        return { data: [], error: null, count: 0 };
      }
      return { data: null, error: null };
    }

    const stub: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === 'then') return (res: (v: unknown) => void) => res(resolve());
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
          } else if (prop === 'eq' || prop === 'in') {
            eqs[String(args[0])] = args[1];
          }
          return new Proxy(stub, handler);
        };
      },
    };
    return new Proxy(stub, handler);
  }

  const client = {
    from: vi.fn((table: string) => {
      fromCalls.push(table);
      return chainFor(table);
    }),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
  return { client, groups, items, lines, fromCalls };
}

function ctxAndDeps(stub: ReturnType<typeof makeConvergenceStub>) {
  const ctx = makeServiceContext(stub.client, {
    organizationId: 'org-test',
    role: 'admin',
    enabledModules: new Set<ModuleId>(['inventory', 'po_imports', 'sports']),
  });
  const deps = {
    supabase: stub.client as never,
    organizationId: 'org-test',
    inventorySvc: new InventoryService(ctx as never),
    mappingsSvc: { upsert: vi.fn(async () => {}) } as never,
    ctx: ctx as never,
  };
  return { ctx, deps };
}

beforeEach(() => vi.clearAllMocks());

describe('createItemsFromPoLines — same-request retry is idempotent', () => {
  it('creates the group and items ONCE; a retry with the same lineIds reports them skipped', async () => {
    const stub = makeConvergenceStub({
      lines: [sizeLine(LINE_A, 1, '9'), sizeLine(LINE_B, 2, '10')],
      category: SHOE_CATEGORY,
    });
    const { deps } = ctxAndDeps(stub);
    const input = {
      poImportId: IMPORT_ID,
      lineIds: [LINE_A, LINE_B],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      categoryId: CATEGORY_ID,
    };

    const first = await createItemsFromPoLines(deps, input);
    expect(first.created).toBe(2);
    expect(first.skipped).toBe(0);
    expect(stub.groups).toHaveLength(1);
    expect(stub.items).toHaveLength(2);
    // The writes landed on the SAME stub's lines array, exactly as a real
    // retry would re-read them from the database.
    expect(stub.lines.every((l) => l.item_id != null)).toBe(true);

    // Same request, replayed (e.g. a client retry after a dropped response).
    const second = await createItemsFromPoLines(deps, input);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(2);
    // Nothing new was spawned — the retry converged, it did not duplicate.
    expect(stub.groups).toHaveLength(1);
    expect(stub.items).toHaveLength(2);
  });
});

describe('ProductGroupsService.findOrCreate — two concurrent callers converge on one id', () => {
  const CREATE_INPUT = {
    subcategoryKey: 'shoes',
    name: 'Nike Pegasus 41',
    categoryId: CATEGORY_ID,
    brand: 'Nike',
    model: 'Pegasus 41',
    styleNumber: 'FD2722',
    colorway: null as string | null,
    defaultCountingUnit: 'pair' as const,
  };
  const GROUP_KEY = buildGroupKey(CREATE_INPUT);

  /**
   * One caller's product_groups client, sharing the SAME `groups` array as
   * every other caller against this "database". `forceMissOnce` and
   * `forceConflictOnce` simulate a transaction that started before its rival
   * committed: its own pre-check misses (the row is not yet visible to it)
   * and its own insert 23505s (the rival won). The RE-READ after that
   * conflict is NOT forced — it reads the real, shared state, so it can only
   * pass by actually converging on the row the other caller inserted.
   */
  function raceCallerClient(
    groups: GroupRow[],
    opts: { forceMissOnce?: boolean; forceConflictOnce?: boolean } = {},
  ) {
    let selectCalls = 0;
    let insertCalls = 0;

    function chain() {
      let op: 'select' | 'insert' = 'select';
      const stub: Record<string, unknown> = {};
      function resolveSingle(): { data: unknown; error: { code?: string; message: string } | null } {
        if (op === 'insert') {
          insertCalls += 1;
          if (opts.forceConflictOnce && insertCalls === 1) {
            return { data: null, error: { code: '23505', message: 'duplicate key' } };
          }
          const row: GroupRow = { id: `grp-${groups.length + 1}`, group_key: GROUP_KEY, name: CREATE_INPUT.name };
          groups.push(row);
          return { data: row, error: null };
        }
        selectCalls += 1;
        if (opts.forceMissOnce && selectCalls === 1) return { data: null, error: null };
        const hit = groups.find((g) => g.group_key === GROUP_KEY) ?? null;
        return { data: hit, error: null };
      }
      const handler: ProxyHandler<Record<string, unknown>> = {
        get(_t, prop: string) {
          if (prop === 'then') return (res: (v: unknown) => void) => res(resolveSingle());
          if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve(resolveSingle());
          return (...args: unknown[]) => {
            if (prop === 'insert') op = 'insert';
            void args;
            return new Proxy(stub, handler);
          };
        },
      };
      return new Proxy(stub, handler);
    }

    return { from: vi.fn(() => chain()), rpc: vi.fn(async () => ({ data: null, error: null })) };
  }

  function raceCtx(client: unknown) {
    return makeServiceContext(client, {
      organizationId: 'org-test',
      role: 'admin',
      enabledModules: new Set<ModuleId>(['inventory', 'sports']),
    });
  }

  it("caller B's own 23505 re-read resolves to the SAME row caller A just inserted", async () => {
    const groups: GroupRow[] = [];

    // Caller A: an ordinary miss-then-insert. Wins the race.
    const a = await new ProductGroupsService(
      raceCtx(raceCallerClient(groups)) as never,
    ).findOrCreate(CREATE_INPUT);
    expect(a.created).toBe(true);
    expect(groups).toHaveLength(1);

    // Caller B: its own pre-check missed (forced), its own insert lost the
    // race (forced 23505) — and its re-read is NOT forced, so it can only
    // converge by actually reading what A wrote.
    const b = await new ProductGroupsService(
      raceCtx(raceCallerClient(groups, { forceMissOnce: true, forceConflictOnce: true })) as never,
    ).findOrCreate(CREATE_INPUT);

    expect(b.created).toBe(false);
    expect(b.group.id).toBe(a.group.id);
    // Still exactly one row — the race did not fork the identity.
    expect(groups).toHaveLength(1);
  });
});

describe('a second import of the SAME file after cancellation', () => {
  const SHA256 = 'a'.repeat(64);
  const UPLOAD = {
    sourceType: 'csv' as const,
    storagePath: 'org-1/po-imports/f.csv',
    fileName: 'po.csv',
    fileMimeType: 'text/csv',
    fileSize: 10,
    sha256: SHA256,
  };

  /**
   * The upload-time dedupe decision (0286/0287 supersede lineage) is
   * exhaustively covered in po-imports.reimport.test.ts — this proves only
   * the ONE fact that file is never PERMANENTLY blocked: a cancelled-PO
   * predecessor frees the hash for a brand-new import row.
   */
  it('proceeds: createFromUpload allows the reimport instead of blocking the hash forever', async () => {
    const stub = makeSupabaseStub({
      'po_imports.select': {
        data: [{ id: 'old-import', status: 'approved', approved_po_id: 'po-1', created_at: '2026-07-01' }],
        error: null,
      },
      'po_imports.insert': { data: { id: 'new-import' }, error: null },
      'po_imports.update': { data: [{ id: 'old-import' }], error: null },
      'purchase_orders.select': { data: [{ id: 'po-1', status: 'cancelled', po_number: 'CVW-1' }], error: null },
    });
    const svc = new (PoImportsService as unknown as new (ctx: unknown) => PoImportsService)(
      makeServiceContext(stub.client, {
        organizationId: 'org-1',
        role: 'admin',
        enabledModules: new Set<ModuleId>(['po_imports']),
      }),
    );

    const res = await svc.createFromUpload(UPLOAD);
    expect(res.duplicateOf).toBeNull();
    expect(res.id).toBe('new-import');
    expect(res.reimportOfCancelled?.predecessorImportId).toBe('old-import');
  });

  /**
   * The part Task 15 actually adds: once the new import's lines reach
   * `createItemsFromPoLines`, they must find the group/variant the DEAD
   * predecessor already created — never spawn a second group — and tie the
   * new PO line to the SAME item, which is what lets it receive the
   * additional shipment's quantity rather than fork the product's identity.
   */
  it('creates NO duplicate group and ties the new lines to the EXISTING variant', async () => {
    const existingGroup: GroupRow = {
      id: 'grp-existing-1',
      name: 'Nike Pegasus 41',
      group_key: buildGroupKey({
        subcategoryKey: 'shoes',
        model: 'Nike Pegasus 41',
        styleNumber: 'FD2722',
        name: 'Nike Pegasus 41',
      }),
      status: 'active',
    };
    const existingItem = {
      id: 'item-existing-10',
      sku: 'SKU-EXIST-10',
      name: 'Nike Pegasus 41 - 10',
      barcode: null,
      charter_id: null,
      unit_cost: 90,
      retail_price: 0,
      category_id: CATEGORY_ID,
      supplier_id: null,
      warehouse_id: WAREHOUSE_ID,
      unit_of_measure: 'pair',
      item_type: 'product',
      tracking_type: 'none',
      group_id: 'grp-existing-1',
      variant_size: '10',
      variant_size_original: 'US 10',
      variant_size_system: 'US_MENS',
      variant_width: null,
      variant_fit: null,
      variant_color: null,
      jersey_number: null,
      player_name: null,
      variant_key: 'size=10|system=us_mens',
    };

    const stub = makeConvergenceStub({
      lines: [sizeLine('reimport-line-10', 1, '10')],
      category: SHOE_CATEGORY,
      seedGroups: [existingGroup],
      seedItems: [existingItem],
    });
    const { deps } = ctxAndDeps(stub);

    const result = await createItemsFromPoLines(deps, {
      poImportId: 'new-import',
      lineIds: ['reimport-line-10'],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      categoryId: CATEGORY_ID,
    });

    // NO new group — the file's history is not blocked, but its identity is
    // not re-created either.
    expect(stub.groups).toHaveLength(1);
    expect(stub.groups[0]!.id).toBe('grp-existing-1');
    // NO new item — the line ties to the SAME variant the cancelled import's
    // predecessor already made, which is what lets receiving add quantity to
    // it rather than fork a second row for the same physical product.
    expect(stub.items).toHaveLength(1);
    expect(result.created).toBe(0);
    expect(result.linked).toBe(1);
  });
});

describe('PoImportsService.approve — the second call does not double the ledger', () => {
  function svcFor(results: Record<string, unknown>) {
    const stub = makeSupabaseStub(results as never);
    const svc = new (PoImportsService as unknown as new (ctx: unknown) => PoImportsService)(
      makeServiceContext(stub.client, {
        organizationId: 'org-test',
        role: 'admin',
        enabledModules: new Set<ModuleId>(['inventory', 'po_imports']),
      }),
    );
    return { svc, stub };
  }

  it('approves once, then refuses a second approve on the now-approved import (conflict, not a second PO)', async () => {
    let approved = false;
    let lineSelectCall = 0;
    const LINE = {
      id: 'line-1',
      po_import_id: IMPORT_ID,
      line_number: 1,
      line_type: 'inventory',
      description: 'Widget',
      qty_ordered_original: 3,
      unit_cost: 4,
      line_total: 12,
      item_id: 'itm-1',
      item_created: false,
      mapping_confidence: null,
      jersey_number: null,
      variant_size: null,
      variant_size_original: null,
      variant_size_system: null,
      variant_color: null,
      player_name: null,
      group_hint: null,
      serial_hint: null,
    };

    const { svc, stub } = svcFor({
      'po_imports.select': () => ({
        data: { id: IMPORT_ID, organization_id: 'org-test', status: approved ? 'approved' : 'parsed' },
        error: null,
      }),
      'po_import_lines.select': () => {
        lineSelectCall += 1;
        // Odd calls are `get()`'s line fetch; even calls are the
        // `item_created = true` sweep at the end of approve() — empty here
        // since this line was linked, not created by the import.
        return lineSelectCall % 2 === 1 ? { data: [LINE], error: null } : { data: [], error: null };
      },
      'locations.select': { data: { id: 'loc-1' }, error: null },
      'rpc:next_po_number': { data: 'PO-500', error: null },
      'purchase_orders.insert': { data: { id: 'po-new' }, error: null },
      'purchase_order_items.insert': { data: null, error: null },
      'po_imports.update': { data: null, error: null },
    });

    const APPROVE_INPUT = {
      poImportId: IMPORT_ID,
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      locationId: 'loc-1',
      lineOverrides: [],
    };

    const first = await svc.approve(APPROVE_INPUT as never);
    expect(first.poId).toBe('po-new');
    approved = true; // mirrors the po_imports.update the real call just made

    await expect(svc.approve(APPROVE_INPUT as never)).rejects.toMatchObject({ code: 'conflict' });

    // The ledger was only ever touched ONCE — the second call never reached
    // it. Quantity is not doubled because there is no second PO to double it.
    expect(stub.chainsAll.get('purchase_orders.insert')).toHaveLength(1);
    expect(stub.chainsAll.get('purchase_order_items.insert')).toHaveLength(1);
  });
});
