import { describe, expect, it, vi } from 'vitest';

/**
 * The distribution preview must count the same stock distribute_bundle()
 * will draw (0365): a component counts only when its item row is in the
 * chosen warehouse or has none, and is not soft-deleted; pre-assembled kits
 * count only when the phantom item is in the chosen warehouse or has none.
 *
 * The preview used to filter components with `.eq('warehouse_id', …)` (so an
 * org-level item with no warehouse read as 0), never looked at deleted_at,
 * and counted the phantom wherever it sat. Each of those made the preview
 * disagree with the RPC: "no shortage" and then insufficient_stock, or a
 * phantom-first split that the RPC would not take.
 *
 * The inventory_items mock below APPLIES the `.eq` / `.in` / `.is` filters the
 * service asks for, so what the preview counts is decided by its own query
 * and its own rule, not by a canned rowset.
 */

vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

import { makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import { BundlesService } from './bundles';

const WH = 'wh-chosen';
const OTHER_WH = 'wh-other';

type ItemRow = {
  id: string;
  organization_id: string;
  quantity_on_hand: number;
  warehouse_id: string | null;
  deleted_at: string | null;
};

const IN_WH: ItemRow = {
  id: 'c-in-wh',
  organization_id: 'org-test',
  quantity_on_hand: 10,
  warehouse_id: WH,
  deleted_at: null,
};
const OTHER: ItemRow = {
  id: 'c-other-wh',
  organization_id: 'org-test',
  quantity_on_hand: 50,
  warehouse_id: OTHER_WH,
  deleted_at: null,
};
const NO_WH: ItemRow = {
  id: 'c-no-wh',
  organization_id: 'org-test',
  quantity_on_hand: 7,
  warehouse_id: null,
  deleted_at: null,
};
const DELETED: ItemRow = {
  id: 'c-deleted',
  organization_id: 'org-test',
  quantity_on_hand: 20,
  warehouse_id: WH,
  deleted_at: '2026-09-01T00:00:00Z',
};

/** Apply the chain's eq / in / is filters to `rows`, like PostgREST would. */
function filtered(call: MockCall, rows: ItemRow[]): ItemRow[] {
  return rows.filter((r) =>
    call.methods.every((m, i) => {
      const [col, val] = call.args[i] as [keyof ItemRow, unknown];
      if (m === 'eq') return r[col] === val;
      if (m === 'in') return (val as unknown[]).includes(r[col]);
      if (m === 'is') return (r[col] ?? null) === val;
      return true;
    }),
  );
}

function component(item: ItemRow, perKit = 1, optional = false) {
  return {
    quantity: perKit,
    is_optional: optional,
    item: {
      id: item.id,
      name: item.id,
      sku: item.id,
      quantity_on_hand: item.quantity_on_hand,
      unit_cost: 1,
    },
  };
}

function previewFor(opts: {
  components: ItemRow[];
  phantom?: { quantity_on_hand: number; warehouse_id: string | null } | null;
}) {
  const stub = makeSupabaseStub({
    'bundles.select.maybeSingle': {
      data: {
        id: 'b-1',
        organization_id: 'org-test',
        name: 'Kit',
        phantom_item_id: opts.phantom ? 'phantom-1' : null,
      },
      error: null,
    },
    'bundle_components.select': { data: opts.components.map((c) => component(c)), error: null },
    // The phantom read (get()).
    'inventory_items.select.maybeSingle': {
      data: opts.phantom ? { id: 'phantom-1', ...opts.phantom } : null,
      error: null,
    },
    // The component stock read (preview()).
    'inventory_items.select': (call) => ({ data: filtered(call, opts.components), error: null }),
  });
  const svc = new BundlesService(makeServiceContext(stub.client));
  return { stub, svc };
}

describe('BundlesService.preview — same availability rule as distribute_bundle', () => {
  it('counts a component in the chosen warehouse and one with NO warehouse', async () => {
    const { svc } = previewFor({ components: [IN_WH, NO_WH] });
    const p = await svc.preview('b-1', 5, WH);
    const byId = new Map(p.components.map((c) => [c.itemId, c]));
    expect(byId.get(IN_WH.id)?.available).toBe(10);
    // An org-level item (warehouse_id null) is drawable from any warehouse.
    expect(byId.get(NO_WH.id)?.available).toBe(7);
    expect(p.hasShortage).toBe(false);
  });

  it('counts a component in ANOTHER warehouse as 0 available', async () => {
    const { svc } = previewFor({ components: [OTHER] });
    const p = await svc.preview('b-1', 5, WH);
    expect(p.components[0]).toMatchObject({ available: 0, shortage: 5 });
    expect(p.hasShortage).toBe(true);
  });

  it('counts a soft-deleted component as 0 available, even in the chosen warehouse', async () => {
    const { svc } = previewFor({ components: [DELETED] });
    const p = await svc.preview('b-1', 5, WH);
    expect(p.components[0]).toMatchObject({ available: 0, shortage: 5 });
    expect(p.hasShortage).toBe(true);
  });

  it('reads deleted_at and warehouse_id for the rule, and no longer narrows by warehouse in SQL', async () => {
    const { stub, svc } = previewFor({ components: [IN_WH] });
    await svc.preview('b-1', 1, WH);
    const reads = stub.chainArgsAll.get('inventory_items.select') ?? [];
    const componentRead = reads[reads.length - 1]!;
    const columns = String(componentRead[0]?.[0]);
    expect(columns).toContain('warehouse_id');
    expect(columns).toContain('deleted_at');
    const methods = stub.chainsAll.get('inventory_items.select')!.at(-1)!;
    const eqCols = methods
      .map((m, i) => (m === 'eq' ? (componentRead[i]?.[0] as string) : null))
      .filter(Boolean);
    expect(eqCols).not.toContain('warehouse_id');
  });
});

describe('BundlesService.preview — pre-assembled kits', () => {
  it('counts kits boxed in ANOTHER warehouse as 0: every unit comes from components', async () => {
    const { svc } = previewFor({
      components: [IN_WH],
      phantom: { quantity_on_hand: 3, warehouse_id: OTHER_WH },
    });
    const p = await svc.preview('b-1', 4, WH);
    expect(p.fromPhantom).toBe(0);
    expect(p.fromComponents).toBe(4);
    expect(p.components[0]).toMatchObject({ needed: 4, available: 10 });
  });

  it('drains kits in the chosen warehouse first', async () => {
    const { svc } = previewFor({
      components: [IN_WH],
      phantom: { quantity_on_hand: 3, warehouse_id: WH },
    });
    const p = await svc.preview('b-1', 4, WH);
    expect(p.fromPhantom).toBe(3);
    expect(p.fromComponents).toBe(1);
  });

  it('drains kits whose phantom has no warehouse', async () => {
    const { svc } = previewFor({
      components: [IN_WH],
      phantom: { quantity_on_hand: 3, warehouse_id: null },
    });
    const p = await svc.preview('b-1', 2, WH);
    expect(p.fromPhantom).toBe(2);
    expect(p.fromComponents).toBe(0);
  });

  it('treats a negative kit count as 0, like the RPC', async () => {
    const { svc } = previewFor({
      components: [IN_WH],
      phantom: { quantity_on_hand: -2, warehouse_id: WH },
    });
    const p = await svc.preview('b-1', 4, WH);
    expect(p.fromPhantom).toBe(0);
    expect(p.fromComponents).toBe(4);
  });
});
