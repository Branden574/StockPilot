import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext } from '@/test/supabase-mock';

/**
 * Task 15 — the requirements' named end-to-end import scenarios, run through
 * the REAL service layer (`createItemsFromPoLines` + the real
 * `InventoryService` + the real `ProductGroupsService`) against a STATEFUL
 * stub, exactly as R2 was proven in po-imports-lines.group-create.test.ts
 * (Task 14). That file already carries the canonical "three sizes collapse
 * onto one group" proof; this file extends it rather than repeating it —
 * R1/R2/R3 here add the assertions Task 14 did not need (zero
 * `serial_registry` touches, a group roll-up read, cross-group non-conflict)
 * — and adds the scenarios that are genuinely new at this layer: a mixed
 * multi-category file, an ambiguous-mapping block-then-confirm round trip,
 * and a 200-line/12-group bulk run.
 */

vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('@/lib/ai/embeddings', () => ({ embedInventoryItem: vi.fn(async () => undefined) }));

import { ServiceError } from './context';
import { InventoryService } from './inventory';
import { createItemsFromPoLines } from './po-imports-lines';
import { ProductGroupsService } from './product-groups';

const SHOE_CATEGORY_ID = 'cat-shoes';
const JERSEY_CATEGORY_ID = 'cat-jerseys';
const ELECTRONICS_CATEGORY_ID = 'cat-electronics';

const SHOE_CATEGORY = {
  id: SHOE_CATEGORY_ID,
  parent_id: null,
  tracking_mode: null,
  size_scale_id: null,
  default_unit_of_measure: 'pair',
  sports_subcategory_key: 'shoes',
  tracking_profile: null,
  deleted_at: null,
};
const JERSEY_CATEGORY = {
  id: JERSEY_CATEGORY_ID,
  parent_id: null,
  tracking_mode: null,
  size_scale_id: null,
  default_unit_of_measure: 'each',
  sports_subcategory_key: 'jerseys',
  tracking_profile: null,
  deleted_at: null,
};
const ELECTRONICS_CATEGORY = {
  id: ELECTRONICS_CATEGORY_ID,
  parent_id: null,
  tracking_mode: 'SERIALIZED',
  size_scale_id: null,
  default_unit_of_measure: 'unit',
  sports_subcategory_key: null,
  tracking_profile: null,
  deleted_at: null,
};

interface GroupRow {
  id: string;
  name: string;
  group_key: string;
  subcategory_key?: string | null;
  default_counting_unit?: string;
  [k: string]: unknown;
}

function baseLine(over: Record<string, unknown>): Record<string, unknown> {
  return {
    po_import_id: 'import-x',
    line_type: 'inventory',
    qty_ordered_original: 1,
    uom_original: 'EA',
    unit_cost: 0,
    vendor_item_number: null,
    vendor_product_number: null,
    auxiliary_number: null,
    item_id: null,
    variant_size: null,
    variant_size_original: null,
    variant_size_system: null,
    variant_width: null,
    variant_fit: null,
    variant_color: null,
    jersey_number: null,
    player_name: null,
    group_hint: null,
    serial_hint: null,
    suggested_group_id: null,
    mapping_confidence: null,
    ...over,
  };
}

/**
 * A STATEFUL, multi-category stub. `state.lines` is reassigned by each test
 * right before the call it feeds — mirroring how the real UI issues one
 * `createItemsFromPoLines` call per (import, category, line-subset), the
 * exact shape the "mixed CSV" scenario needs (one categoryId per call,
 * sharing the same underlying groups/items "database").
 */
function makeSportsImportStub(opts: {
  categoriesById: Record<string, Record<string, unknown>>;
  seedGroups?: GroupRow[];
  seedItems?: Array<Record<string, unknown>>;
}) {
  const state = { lines: [] as Array<Record<string, unknown>> };
  const groups: GroupRow[] = [...(opts.seedGroups ?? [])];
  const items: Array<Record<string, unknown>> = [...(opts.seedItems ?? [])];
  const fromCalls: string[] = [];

  function chainFor(table: string) {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    const eqs: Record<string, unknown> = {};
    let payload: unknown = null;

    function resolve(): { data: unknown; error: null; count?: number } {
      if (table === 'po_imports') return { data: { id: 'import-x', status: 'parsed' }, error: null };
      if (table === 'po_import_lines') {
        if (op === 'update') {
          const id = eqs.id as string | undefined;
          const idx = state.lines.findIndex((l) => l.id === id);
          if (idx >= 0) state.lines[idx] = { ...state.lines[idx], ...(payload as Record<string, unknown>) };
          return { data: null, error: null };
        }
        return { data: state.lines, error: null };
      }
      if (table === 'categories') {
        const id = eqs.id as string | undefined;
        return { data: (id ? opts.categoriesById[id] : null) ?? null, error: null };
      }
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
        // candidates() ilike-probes are not tracked as `eq`/`in` and land
        // here — this file never exercises the ambiguous-candidate path
        // (covered in po-imports-variants.test.ts), so it always misses.
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
      if (table === 'product_group_rollups') {
        const ids = (eqs.group_id as string[] | undefined) ?? [];
        const rows = ids.map((gid) => {
          const variants = items.filter((i) => i.group_id === gid);
          const totalQuantity = variants.reduce((s, i) => s + (Number(i.quantity_on_hand) || 0), 0);
          return {
            group_id: gid,
            variant_count: variants.length,
            total_quantity: totalQuantity,
            counting_unit: groups.find((g) => g.id === gid)?.default_counting_unit ?? 'each',
          };
        });
        return { data: rows, error: null };
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
  return { client, groups, items, state, fromCalls };
}

function ctxAndDeps(stub: ReturnType<typeof makeSportsImportStub>) {
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

describe('R1 — a serialized product blocks import with no serial', () => {
  it('refuses a Chromebook line the document printed no serial for: SERIAL_NUMBER_REQUIRED', async () => {
    const stub = makeSportsImportStub({ categoriesById: { [ELECTRONICS_CATEGORY_ID]: ELECTRONICS_CATEGORY } });
    const { deps } = ctxAndDeps(stub);
    stub.state.lines = [
      baseLine({
        id: 'line-chromebook',
        description: 'Lenovo 100e Chromebook',
        qty_ordered_original: 10,
        unit_cost: 250,
      }),
    ];

    const err = (await createItemsFromPoLines(deps, {
      poImportId: 'import-x',
      lineIds: ['line-chromebook'],
      vendorId: 'vendor-1',
      warehouseId: 'wh-1',
      categoryId: ELECTRONICS_CATEGORY_ID,
    }).catch((e: unknown) => e)) as ServiceError;

    expect(err).toBeInstanceOf(ServiceError);
    expect(err.code).toBe('validation_error');
    expect(err.details).toMatchObject({ code: 'SERIAL_NUMBER_REQUIRED' });
    expect(stub.items).toHaveLength(0);
    // Refused before creation — never even a serial table read.
    expect(stub.fromCalls).not.toContain('serial_registry');
  });
});

describe('R2 — a shoe size run is ONE group, per-size quantity, no serials', () => {
  it('three sizes of one style collapse onto one group with three variants, and never touch serial_registry', async () => {
    const stub = makeSportsImportStub({ categoriesById: { [SHOE_CATEGORY_ID]: SHOE_CATEGORY } });
    const { deps } = ctxAndDeps(stub);
    const sizes = ['8', '9', '10'];
    stub.state.lines = sizes.map((size, i) =>
      baseLine({
        id: `line-shoe-${size}`,
        line_number: i + 1,
        description: `Adidas Ultraboost - US ${size}`,
        qty_ordered_original: 4 + i,
        uom_original: 'PAIR',
        unit_cost: 120,
        vendor_product_number: 'UB-2200',
        variant_size: size,
        variant_size_original: `US ${size}`,
        variant_size_system: 'US_MENS',
        group_hint: 'Adidas Ultraboost',
      }),
    );

    const result = await createItemsFromPoLines(deps, {
      poImportId: 'import-x',
      lineIds: sizes.map((s) => `line-shoe-${s}`),
      vendorId: 'vendor-1',
      warehouseId: 'wh-1',
      categoryId: SHOE_CATEGORY_ID,
    });

    expect(result.created).toBe(3);
    expect(stub.groups).toHaveLength(1);
    expect(stub.items).toHaveLength(3);
    expect(new Set(stub.items.map((i) => i.variant_key)).size).toBe(3);
    expect(stub.items.map((i) => i.variant_size).sort()).toEqual(['10', '8', '9']);
    // R2: quantity is COUNTED, never serialized.
    for (const item of stub.items) expect(item.tracking_type).toBe('none');
    expect(stub.fromCalls).not.toContain('serial_registry');
  });
});

describe('R3 — jersey #12 in M and XL is ONE group, roll-up 5', () => {
  it('keeps #12 as two variants of one group, and the roll-up totals 5 once received', async () => {
    const stub = makeSportsImportStub({ categoriesById: { [JERSEY_CATEGORY_ID]: JERSEY_CATEGORY } });
    const { ctx, deps } = ctxAndDeps(stub);
    stub.state.lines = [
      baseLine({
        id: 'line-j12-m',
        line_number: 1,
        description: 'Falcons Home Jersey #12',
        qty_ordered_original: 3,
        unit_cost: 60,
        vendor_product_number: 'FAL-HOME',
        variant_size: 'M',
        variant_size_original: 'M',
        jersey_number: '12',
        group_hint: 'Falcons Home Jersey',
      }),
      baseLine({
        id: 'line-j12-xl',
        line_number: 2,
        description: 'Falcons Home Jersey #12',
        qty_ordered_original: 2,
        unit_cost: 60,
        vendor_product_number: 'FAL-HOME',
        variant_size: 'XL',
        variant_size_original: 'XL',
        jersey_number: '12',
        group_hint: 'Falcons Home Jersey',
      }),
    ];

    const result = await createItemsFromPoLines(deps, {
      poImportId: 'import-x',
      lineIds: ['line-j12-m', 'line-j12-xl'],
      vendorId: 'vendor-1',
      warehouseId: 'wh-1',
      categoryId: JERSEY_CATEGORY_ID,
    });

    expect(result.created).toBe(2);
    expect(stub.groups).toHaveLength(1);
    expect(stub.items).toHaveLength(2);
    expect(stub.items.every((i) => i.jersey_number === '12')).toBe(true);
    // Two DISTINCT variants (by size), sharing the number — never a serial.
    expect(new Set(stub.items.map((i) => i.variant_key)).size).toBe(2);

    // Receiving (post_receipt_v2) is the only thing that ever moves
    // quantity_on_hand — out of this task's scope, and proven elsewhere
    // (receiving.serial-optional.test.ts). Simulate its RESULT directly on
    // the stub to prove the roll-up VIEW correctly aggregates what
    // create-items wired up, without asserting anything about how receiving
    // itself writes.
    stub.items[0]!.quantity_on_hand = 3;
    stub.items[1]!.quantity_on_hand = 2;
    const groupId = stub.groups[0]!.id;
    const rollups = await new ProductGroupsService(ctx as never).rollups([groupId]);
    expect(rollups.get(groupId)?.variantCount).toBe(2);
    expect(rollups.get(groupId)?.totalQuantity).toBe(5);
  });
});

describe('the same number across two different groups', () => {
  it('creates two independent variants with no conflict', async () => {
    const stub = makeSportsImportStub({ categoriesById: { [JERSEY_CATEGORY_ID]: JERSEY_CATEGORY } });
    const { deps } = ctxAndDeps(stub);
    stub.state.lines = [
      baseLine({
        id: 'line-falcons-9',
        line_number: 1,
        description: 'Falcons Home Jersey #9',
        vendor_product_number: 'FAL-HOME',
        variant_size: 'M',
        variant_size_original: 'M',
        jersey_number: '9',
        group_hint: 'Falcons Home Jersey',
      }),
      baseLine({
        id: 'line-panthers-9',
        line_number: 2,
        description: 'Panthers Home Jersey #9',
        vendor_product_number: 'PAN-HOME',
        variant_size: 'M',
        variant_size_original: 'M',
        jersey_number: '9',
        group_hint: 'Panthers Home Jersey',
      }),
    ];

    const result = await createItemsFromPoLines(deps, {
      poImportId: 'import-x',
      lineIds: ['line-falcons-9', 'line-panthers-9'],
      vendorId: 'vendor-1',
      warehouseId: 'wh-1',
      categoryId: JERSEY_CATEGORY_ID,
    });

    expect(result.created).toBe(2);
    expect(stub.groups).toHaveLength(2);
    expect(stub.items).toHaveLength(2);
    expect(stub.items.map((i) => i.jersey_number)).toEqual(['9', '9']);
    expect(stub.items[0]!.group_id).not.toBe(stub.items[1]!.group_id);
  });
});

describe('a mixed CSV of shoes and jerseys resolves each subcategory with its own profile', () => {
  it('two categories, one file: each line-subset lands under its own tracking profile', async () => {
    const stub = makeSportsImportStub({
      categoriesById: { [SHOE_CATEGORY_ID]: SHOE_CATEGORY, [JERSEY_CATEGORY_ID]: JERSEY_CATEGORY },
    });
    const { deps } = ctxAndDeps(stub);

    const shoeLines = ['9', '10'].map((size, i) =>
      baseLine({
        id: `line-mixed-shoe-${size}`,
        line_number: i + 1,
        description: `Nike Pegasus 41 - US ${size}`,
        uom_original: 'PAIR',
        unit_cost: 90,
        vendor_product_number: 'FD2722',
        variant_size: size,
        variant_size_original: `US ${size}`,
        variant_size_system: 'US_MENS',
        group_hint: 'Nike Pegasus 41',
      }),
    );
    const jerseyLines = ['M', 'L'].map((size, i) =>
      baseLine({
        id: `line-mixed-jersey-${size}`,
        line_number: 10 + i,
        description: 'Wildcats Home Jersey #7',
        unit_cost: 55,
        vendor_product_number: 'WC-HOME',
        variant_size: size,
        variant_size_original: size,
        jersey_number: '7',
        group_hint: 'Wildcats Home Jersey',
      }),
    );

    stub.state.lines = shoeLines;
    const shoeResult = await createItemsFromPoLines(deps, {
      poImportId: 'import-x',
      lineIds: shoeLines.map((l) => l.id as string),
      vendorId: 'vendor-1',
      warehouseId: 'wh-1',
      categoryId: SHOE_CATEGORY_ID,
    });
    expect(shoeResult.created).toBe(2);

    stub.state.lines = jerseyLines;
    const jerseyResult = await createItemsFromPoLines(deps, {
      poImportId: 'import-x',
      lineIds: jerseyLines.map((l) => l.id as string),
      vendorId: 'vendor-1',
      warehouseId: 'wh-1',
      categoryId: JERSEY_CATEGORY_ID,
    });
    expect(jerseyResult.created).toBe(2);

    expect(stub.groups).toHaveLength(2);
    const shoeGroup = stub.groups.find((g) => g.subcategory_key === 'shoes');
    const jerseyGroup = stub.groups.find((g) => g.subcategory_key === 'jerseys');
    expect(shoeGroup).toBeDefined();
    expect(jerseyGroup).toBeDefined();
    expect(shoeGroup!.default_counting_unit).toBe('pair');
    expect(jerseyGroup!.default_counting_unit).toBe('each');

    const shoeItems = stub.items.filter((i) => i.group_id === shoeGroup!.id);
    const jerseyItems = stub.items.filter((i) => i.group_id === jerseyGroup!.id);
    expect(shoeItems).toHaveLength(2);
    expect(jerseyItems).toHaveLength(2);
    expect(shoeItems.every((i) => i.tracking_type === 'none' && i.jersey_number == null)).toBe(true);
    expect(jerseyItems.every((i) => i.jersey_number === '7')).toBe(true);
  });
});

describe('an ambiguous "Number" column blocks approval until the mapping is confirmed', () => {
  it('refuses item creation while unconfirmed, then succeeds once the reviewer confirms it', async () => {
    const stub = makeSportsImportStub({ categoriesById: { [JERSEY_CATEGORY_ID]: JERSEY_CATEGORY } });
    const { deps } = ctxAndDeps(stub);
    const line = baseLine({
      id: 'line-ambiguous',
      line_number: 1,
      description: 'Wildcats Home Jersey',
      qty_ordered_original: 4,
      unit_cost: 55,
      vendor_product_number: 'WC-HOME',
      variant_size: 'M',
      variant_size_original: 'M',
      group_hint: 'Wildcats Home Jersey',
      // The extractor tentatively read a bare "Number" column as the jersey
      // number, but at LOW confidence — exactly the ambiguity the
      // requirements name ("a bare Number column could be a jersey number,
      // a quantity, a serial, a style number...").
      jersey_number: '9',
      mapping_confidence: 0.4,
    });
    stub.state.lines = [line];
    const input = {
      poImportId: 'import-x',
      lineIds: ['line-ambiguous'],
      vendorId: 'vendor-1',
      warehouseId: 'wh-1',
      categoryId: JERSEY_CATEGORY_ID,
    };

    const err = (await createItemsFromPoLines(deps, input).catch((e: unknown) => e)) as ServiceError;
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.details).toMatchObject({ code: 'IMPORT_MAPPING_REVIEW_REQUIRED' });
    expect(stub.items).toHaveLength(0);
    expect(stub.groups).toHaveLength(0);

    // The reviewer confirms: yes, this column IS the jersey number
    // (mirrors what confirmLineMappings persists: mapping_confidence -> 1).
    stub.state.lines[0]!.mapping_confidence = 1;

    const result = await createItemsFromPoLines(deps, input);
    expect(result.created).toBe(1);
    expect(stub.items).toHaveLength(1);
    expect(stub.items[0]!.jersey_number).toBe('9');
  });
});

describe('bulk import — 200 lines across 12 groups', () => {
  it('completes and the group roll-ups are arithmetically correct', async () => {
    const GROUP_COUNT = 12;
    const TOTAL_LINES = 200;
    const base = Math.floor(TOTAL_LINES / GROUP_COUNT);
    const remainder = TOTAL_LINES - base * GROUP_COUNT;
    const perGroupCounts = Array.from({ length: GROUP_COUNT }, (_, i) => base + (i < remainder ? 1 : 0));
    expect(perGroupCounts.reduce((a, b) => a + b, 0)).toBe(TOTAL_LINES);

    const lines: Array<Record<string, unknown>> = [];
    let lineSeq = 0;
    perGroupCounts.forEach((count, groupIdx) => {
      for (let v = 0; v < count; v++) {
        lineSeq += 1;
        lines.push(
          baseLine({
            id: `line-${lineSeq}`,
            line_number: lineSeq,
            description: `Team ${groupIdx} Home Jersey`,
            unit_cost: 50,
            vendor_product_number: `STY-${groupIdx}`,
            variant_size: 'M',
            variant_size_original: 'M',
            jersey_number: String(v + 1),
            group_hint: `Team ${groupIdx} Home Jersey`,
          }),
        );
      }
    });

    const stub = makeSportsImportStub({ categoriesById: { [JERSEY_CATEGORY_ID]: JERSEY_CATEGORY } });
    const { ctx, deps } = ctxAndDeps(stub);
    stub.state.lines = lines;

    const result = await createItemsFromPoLines(deps, {
      poImportId: 'import-x',
      lineIds: lines.map((l) => l.id as string),
      vendorId: 'vendor-bulk',
      warehouseId: 'wh-bulk',
      categoryId: JERSEY_CATEGORY_ID,
    });

    expect(result.created).toBe(TOTAL_LINES);
    expect(stub.groups).toHaveLength(GROUP_COUNT);
    expect(stub.items).toHaveLength(TOTAL_LINES);

    // Arithmetic check: every group's variant count matches how many jersey
    // numbers were minted for it, and the 12 counts sum back to 200.
    const groupIds = stub.groups.map((g) => g.id);
    const rollups = await new ProductGroupsService(ctx as never).rollups(groupIds);
    expect(rollups.size).toBe(GROUP_COUNT);
    let totalVariants = 0;
    stub.groups.forEach((g, i) => {
      const r = rollups.get(g.id)!;
      expect(r.variantCount).toBe(perGroupCounts[i]);
      totalVariants += r.variantCount;
    });
    expect(totalVariants).toBe(TOTAL_LINES);
  });
});
