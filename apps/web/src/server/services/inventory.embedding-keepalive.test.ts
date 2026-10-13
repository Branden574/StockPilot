import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

/**
 * An item's search data (its embedding) is written after the item itself, so a
 * slow embedding call never holds up a create or an edit. The work is handed to
 * keepAlive, the mechanism #352 added for audit rows: it gives the running work
 * to the platform's waitUntil, so the response is not delayed and the work is
 * not cut off if the instance is suspended.
 *
 * WHY THE 12 LEARN4LIFE ITEMS HAD NONE (found 2026-10-13, backfilled by the
 * owner from Settings > AI): they were size runs. bulkCreateSizedVariants (the
 * web Add sizes form and the phone's POST /api/v1/items/sized-variants) never
 * embedded at all, and neither did Duplicate. Both now embed their new rows the
 * moment they are saved. create() and update() had started theirs as a bare
 * `void (async () => ...)()`; holding them with keepAlive is hardening (every
 * item created through create() since 2026-09-28 has its embedding).
 *
 * THE EMBED HERE IS DEFERRED: each call stays pending until the test settles
 * it. So a test can see what is still running after the method has returned,
 * and that the promise handed to keepAlive settles only after the last embed
 * does. A dropped `await` inside the loop, or a loop that is started but not
 * handed to keepAlive, fails these tests.
 */

const h = vi.hoisted(() => ({
  kept: [] as Promise<unknown>[],
  embeds: [] as Array<{
    id: string;
    organizationId: string;
    supabase: unknown;
    settle: () => void;
  }>,
}));

vi.mock('./lib/defer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/defer')>()),
  keepAlive: vi.fn((work: Promise<unknown>) => {
    h.kept.push(work);
  }),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [], writableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
  auditMany: vi.fn(async (payloads: readonly unknown[]) => ({ written: payloads.length, lost: 0 })),
}));
vi.mock('@/lib/ai/embeddings', () => ({
  embedInventoryItem: vi.fn(
    (id: string, ctx: { organizationId: string; supabase: unknown }) =>
      new Promise<void>((settle) => {
        h.embeds.push({ id, organizationId: ctx.organizationId, supabase: ctx.supabase, settle });
      }),
  ),
}));
// update() copies product-level fields to the SKU's other rack records with the
// server-key client (the edit fan-out); here it answers with no rows.
vi.mock('@/lib/supabase/admin', () => {
  const chain = () => {
    const p: Record<string, unknown> = {};
    for (const m of ['from', 'update', 'select', 'eq', 'neq', 'is', 'in']) p[m] = () => p;
    (p as { then: unknown }).then = (res: (v: unknown) => unknown) =>
      res({ data: [], error: null });
    return p;
  };
  return { createAdminClient: () => chain() };
});

import { embedInventoryItem } from '@/lib/ai/embeddings';

import { InventoryService } from './inventory';
import { keepAlive } from './lib/defer';

beforeEach(() => {
  vi.clearAllMocks();
  h.kept = [];
  h.embeds = [];
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** Follows a promise without changing it. */
function watch(p: Promise<unknown>) {
  const state = { settled: false };
  void p.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

/**
 * The method under test has returned. Settles the embeds for `ids` one at a
 * time, oldest first, and checks at every step that the kept promise is still
 * pending, that no more than four embeds run at once (and that four do, when
 * there are four to run), and that it settles once the last one has.
 */
async function expectHeldUntilEveryEmbedSettles(kept: Promise<unknown>, ids: readonly string[]) {
  const state = watch(kept);
  const mine = () => h.embeds.filter((e) => ids.includes(e.id));
  for (let settled = 0; settled < ids.length; settled += 1) {
    // The embeddings module is imported lazily, so the loop reaches it a few
    // ticks after the method returned.
    await vi.waitFor(() => expect(mine().length).toBeGreaterThan(settled));
    await flush();
    const inFlight = mine().length - settled;
    expect(inFlight).toBeLessThanOrEqual(4);
    if (settled === 0) expect(inFlight).toBe(Math.min(4, ids.length));
    expect(state.settled).toBe(false);
    mine()[settled]!.settle();
    await flush();
  }
  await flush();
  expect(state.settled).toBe(true);
  expect(
    mine()
      .map((e) => e.id)
      .sort(),
  ).toEqual([...ids].sort());
}

/* ─────────────────────────────── create() ─────────────────────────────── */

const CREATE = {
  name: 'Chromebook',
  unitCost: 0,
  retailPrice: 0,
  quantityOnHand: 0,
  reorderPoint: 0,
  reorderQuantity: 0,
  trackingType: 'none' as const,
  itemType: 'product' as const,
  customFields: {},
  status: 'active' as const,
  expiryPolicy: 'warn' as const,
  warehouseId: 'wh-1',
};

function createStub(over: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'inventory_items.select': { data: null, error: null, count: 0 },
    'organizations.select': { data: { plan: 'enterprise' }, error: null },
    'custom_field_definitions.select': { data: [], error: null },
    'inventory_items.insert': { data: { id: 'itm-new', quantity_on_hand: 0 }, error: null },
    'item_stock_levels.select': { data: [], error: null },
    ...over,
  });
}

describe('create(): the new item is embedded after the response, held by keepAlive', () => {
  it('hands one embed of the new item to keepAlive, still running when create() returns', async () => {
    const stub = createStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.create({ ...CREATE })).resolves.toMatchObject({ id: 'itm-new' });

    expect(keepAlive).toHaveBeenCalledTimes(1);
    await expectHeldUntilEveryEmbedSettles(h.kept[0]!, ['itm-new']);
    // With the caller's own client, scoped to the caller's organization.
    expect(h.embeds[0]).toMatchObject({ organizationId: 'org-test', supabase: stub.client });
  });

  it('embeds the saved item even when create() then throws (its opening stock was refused)', async () => {
    // The row exists from the insert on; the refused opening movement makes
    // create() roll the quantity back and throw. The embed must already be
    // running by then, not wait for a line the throw never reaches.
    const stub = createStub({
      'inventory_items.insert': { data: { id: 'itm-new', quantity_on_hand: 5 }, error: null },
      'stock_movements.insert': { data: null, error: { message: 'refused' } },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.create({ ...CREATE, quantityOnHand: 5 })).rejects.toMatchObject({
      code: 'internal_error',
      internalDetail: expect.stringMatching(/opening stock could not be recorded/),
    });

    expect(keepAlive).toHaveBeenCalledTimes(1);
    await expectHeldUntilEveryEmbedSettles(h.kept[0]!, ['itm-new']);
  });

  it('a loop that fails outright is logged, and keepAlive is never handed a rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(embedInventoryItem).mockImplementationOnce(() =>
      Promise.reject(new Error('the embeddings module failed to load')),
    );
    const svc = new InventoryService(makeServiceContext(createStub().client));

    await svc.create({ ...CREATE });

    expect(keepAlive).toHaveBeenCalledTimes(1);
    await expect(h.kept[0]).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[embeddings] background embed failed:',
      expect.objectContaining({ message: 'the embeddings module failed to load' }),
    );
  });
});

/* ──────────────────────── bulkCreateSizedVariants() ──────────────────────── */

const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];

const RUN = {
  baseName: 'L4L Black T-Shirt',
  baseSku: 'SP-TEE',
  baseBarcode: null,
  description: null,
  categoryId: 'cat-1',
  supplierId: null,
  warehouseId: 'wh-1',
  charterId: null,
  primaryLocationId: null,
  binLocation: null,
  retailPrice: 12,
  unitCost: 4,
  reorderPoint: 0,
  reorderQuantity: 0,
  unitOfMeasure: 'unit',
  variants: SIZES.map((size) => ({ size, quantity: 0 })),
};

const CATEGORY = {
  id: 'cat-1',
  parent_id: null,
  tracking_mode: null,
  size_scale_id: null,
  default_unit_of_measure: null,
  sports_subcategory_key: null,
  tracking_profile: null,
  deleted_at: null,
};

/** The insert answers with one row per size it was given, ids v-1..v-n. */
function runStub(over: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'inventory_items.select': { data: null, error: null, count: 0 },
    'organizations.select': { data: { plan: 'enterprise' }, error: null },
    'categories.select': { data: CATEGORY, error: null },
    'custom_field_definitions.select': { data: [], error: null },
    'inventory_items.insert': (call: MockCall) => {
      const rows = (call.args[0]?.[0] ?? []) as Array<{
        name: string;
        sku: string;
        quantity_on_hand: number;
      }>;
      return {
        data: rows.map((r, i) => ({
          id: `v-${i + 1}`,
          name: r.name,
          sku: r.sku,
          quantity_on_hand: r.quantity_on_hand,
          primary_location_id: null,
        })),
        error: null,
      };
    },
    'stock_movements.insert': { data: null, error: null },
    ...over,
  });
}

const RUN_IDS = SIZES.map((_, i) => `v-${i + 1}`);

describe('bulkCreateSizedVariants(): every size of the run is embedded when it is saved', () => {
  it('hands ONE loop over all the new sizes to keepAlive, at most four at a time', async () => {
    const stub = runStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    const created = await svc.bulkCreateSizedVariants({ ...RUN });

    expect(created.rows.map((r) => r.id)).toEqual(RUN_IDS);
    expect(keepAlive).toHaveBeenCalledTimes(1);
    await expectHeldUntilEveryEmbedSettles(h.kept[0]!, RUN_IDS);
    for (const e of h.embeds) {
      expect(e).toMatchObject({ organizationId: 'org-test', supabase: stub.client });
    }
  });

  it('embeds every saved size even when the run then throws (its opening stock was refused)', async () => {
    const stub = runStub({
      'stock_movements.insert': { data: null, error: { message: 'refused' } },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(
      svc.bulkCreateSizedVariants({
        ...RUN,
        variants: SIZES.map((size) => ({ size, quantity: 2 })),
      }),
    ).rejects.toMatchObject({
      code: 'internal_error',
      internalDetail: expect.stringMatching(/opening stock could not be recorded/),
    });

    expect(keepAlive).toHaveBeenCalledTimes(1);
    await expectHeldUntilEveryEmbedSettles(h.kept[0]!, RUN_IDS);
  });

  it('a refused insert saves nothing and embeds nothing', async () => {
    const stub = runStub({
      'inventory_items.insert': { data: null, error: { message: 'boom', code: 'XX000' } },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.bulkCreateSizedVariants({ ...RUN })).rejects.toMatchObject({
      code: 'internal_error',
      internalDetail: 'boom',
    });

    expect(keepAlive).not.toHaveBeenCalled();
    expect(embedInventoryItem).not.toHaveBeenCalled();
  });
});

/* ───────────────────────────── duplicateItem() ───────────────────────────── */

function duplicateCtx(rpcError: { code: string; message: string } | null = null) {
  const supabase = {
    rpc: vi.fn(async () =>
      rpcError ? { data: null, error: rpcError } : { data: 'dup-1', error: null },
    ),
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { sku: 'SP-ABC', warehouse_id: 'wh-1', charter_id: null },
              error: null,
            }),
          }),
        }),
      }),
    }),
  };
  return { supabase, ctx: makeServiceContext(supabase) };
}

describe('duplicateItem(): the copy is embedded when it is saved', () => {
  it('hands one embed of the copy to keepAlive, still running when duplicateItem() returns', async () => {
    const { supabase, ctx } = duplicateCtx();
    const svc = new InventoryService(ctx);

    await expect(
      svc.duplicateItem({
        originalId: '00000000-0000-0000-0000-000000000001',
        itemType: 'product',
        rackNumber: '38',
        rackRow: 'A',
        quantity: 0,
      }),
    ).resolves.toBe('dup-1');

    expect(keepAlive).toHaveBeenCalledTimes(1);
    await expectHeldUntilEveryEmbedSettles(h.kept[0]!, ['dup-1']);
    expect(h.embeds[0]).toMatchObject({ organizationId: 'org-test', supabase });
  });

  it('a refused copy embeds nothing', async () => {
    const { ctx } = duplicateCtx({ code: 'P0002', message: 'gone' });
    const svc = new InventoryService(ctx);

    await expect(
      svc.duplicateItem({
        originalId: '00000000-0000-0000-0000-000000000001',
        itemType: 'product',
        rackNumber: '38',
        rackRow: 'A',
        quantity: 0,
      }),
    ).rejects.toThrow('Original item no longer exists.');

    expect(keepAlive).not.toHaveBeenCalled();
  });
});

/* ──────────────────────────────── update() ──────────────────────────────── */

const ITEM = {
  id: 'itm-1',
  organization_id: 'org-1',
  sku: 'OLD-SKU',
  barcode: null,
  name: 'Widget',
  warehouse_id: null,
  bin_location: null,
  charter_id: null,
  custom_fields: {},
  status: 'active',
  item_type: 'product',
  tracking_type: 'none',
  quantity_on_hand: 5,
};

/** update() reads the item (a SELECT), then writes it; every other table is empty. */
function updateCtx(updated: Record<string, unknown>) {
  const chain = (result: { data: unknown; error: unknown }) => {
    const p: Record<string, unknown> = {};
    for (const m of ['select', 'update', 'eq', 'is', 'in', 'order', 'limit']) p[m] = () => p;
    p.single = async () => result;
    p.maybeSingle = async () => result;
    (p as { then: unknown }).then = (res: (v: unknown) => unknown) => res(result);
    return p;
  };
  const supabase = {
    from: (table: string) => {
      if (table !== 'inventory_items') return chain({ data: [], error: null });
      let isUpdate = false;
      const p: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit']) p[m] = () => p;
      p.update = () => {
        isUpdate = true;
        return p;
      };
      const answer = () =>
        isUpdate ? { data: updated, error: null } : { data: ITEM, error: null };
      p.single = async () => answer();
      p.maybeSingle = async () => answer();
      (p as { then: unknown }).then = (res: (v: unknown) => unknown) =>
        res(isUpdate ? { data: updated, error: null } : { data: [ITEM], error: null });
      return p;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin',
    supabase,
    enabledModules: new Set<string>(),
  } as never;
}

describe('update(): a changed searched field is re-embedded, held by keepAlive', () => {
  it('an edit to a searched field holds the re-embedding of that item until it settles', async () => {
    const svc = new InventoryService(updateCtx({ ...ITEM, name: 'Widget Pro' }));

    await svc.update('itm-1', { name: 'Widget Pro' });

    expect(keepAlive).toHaveBeenCalledTimes(1);
    await expectHeldUntilEveryEmbedSettles(h.kept[0]!, ['itm-1']);
    expect(h.embeds[0]?.organizationId).toBe('org-1');
  });

  it('an edit to a field that search does not read embeds nothing', async () => {
    const svc = new InventoryService(updateCtx({ ...ITEM, reorder_point: 3 }));

    await svc.update('itm-1', { reorderPoint: 3 });

    expect(keepAlive).not.toHaveBeenCalled();
    expect(embedInventoryItem).not.toHaveBeenCalled();
  });
});

describe('no embedding in the service is fired and forgotten', () => {
  it('no embedding in the service is fired and forgotten', () => {
    const code = readFileSync(resolve(__dirname, 'inventory.ts'), 'utf8');
    // Every place that embeds an item goes through embedInBackground, whose
    // one call hands the work to keepAlive.
    const sites = code.split('embedInventoryItem(').length - 1;
    expect(sites).toBeGreaterThanOrEqual(1);
    expect(code).not.toMatch(/void \(async \(\) => \{[^}]*embedInventoryItem/);
  });
});
