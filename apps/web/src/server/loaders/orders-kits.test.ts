import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createClientMock, modulesMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  modulesMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }));
vi.mock('@/lib/dashboard/request-cache', () => ({ getModulesForRequest: modulesMock }));

import { loadOrderKits, resolveKits } from './orders-kits';

const ORG = 'org-1';
const DC4 = 'wh-dc4';

type Named = { id: string; sku: string | null; warehouse_id: string | null; charter_id: string | null; deleted_at: string | null };
const named = (id: string, sku: string, over: Partial<Named> = {}): Named => ({
  id,
  sku,
  warehouse_id: DC4,
  charter_id: null,
  deleted_at: null,
  ...over,
});
const comp = (item: Named | null, quantity: number | string = 1, is_optional = false, item_id = item?.id ?? 'hidden') => ({
  item_id,
  quantity,
  is_optional,
  item,
});
const bundle = (id: string, name: string, components: ReturnType<typeof comp>[], sku: string | null = null) => ({
  id,
  name,
  sku,
  bundle_components: components,
});
const cat = (id: string, sku: string, over: { charterId?: string | null; rackLabel?: string | null } = {}) => ({
  id,
  sku,
  charterId: over.charterId ?? null,
  rackLabel: over.rackLabel ?? null,
});

// DC4 as production holds it: the backpack is two rows of one SKU, and the
// bundle names the 18-A row.
const BACKPACK_18A = named('backpack-18a', 'SP-X6IN2-E84');
const MUG = named('mug', 'SP-KS0UB-GLY');
const PAD = named('pad', 'SP-MN6U7-JW2');
const PLANNER = named('planner', 'SP-LQ5IM-K59');
const DC4_CATALOG = [
  cat('backpack-16b', 'SP-X6IN2-E84', { rackLabel: '16-B' }),
  cat('backpack-18a', 'SP-X6IN2-E84', { rackLabel: '18-A' }),
  cat('mug', 'SP-KS0UB-GLY'),
  cat('pad', 'SP-MN6U7-JW2'),
  cat('planner', 'SP-LQ5IM-K59'),
];
const NEW_HIRE = bundle('b-new-hire', 'New Hire Bundle', [comp(BACKPACK_18A), comp(MUG), comp(PAD), comp(PLANNER)]);

/** A stub of the one bundles read, recording its filters. */
function client(result: { data: unknown; error: unknown }) {
  const calls: Array<[string, unknown[]]> = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'order']) {
    chain[m] = (...args: unknown[]) => {
      calls.push([m, args]);
      return chain;
    };
  }
  chain.range = (...args: unknown[]) => {
    calls.push(['range', args]);
    return Promise.resolve(result);
  };
  const from = vi.fn((table: string) => {
    calls.push(['from', [table]]);
    return chain;
  });
  return { client: { from }, calls, from };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  modulesMock.mockResolvedValue(new Set(['orders', 'bundles']));
});

describe('loadOrderKits', () => {
  it("reads active, unarchived bundles of the org with the visitor's own client", async () => {
    const stub = client({ data: [NEW_HIRE], error: null });
    createClientMock.mockResolvedValue(stub.client);
    const out = await loadOrderKits(ORG, DC4, Promise.resolve({ items: DC4_CATALOG }));
    expect(out.status).toBe('ok');
    expect(stub.from).toHaveBeenCalledWith('bundles');
    expect(stub.calls).toContainEqual(['eq', ['organization_id', ORG]]);
    expect(stub.calls).toContainEqual(['eq', ['is_active', true]]);
    expect(stub.calls).toContainEqual(['is', ['archived_at', null]]);
    const select = stub.calls.find(([m]) => m === 'select')![1][0] as string;
    expect(select).toContain('bundle_components(item_id, quantity, is_optional, item:inventory_items(');
  });

  it('the backpack component uses both rows of its SKU, the named row first', async () => {
    const stub = client({ data: [NEW_HIRE], error: null });
    createClientMock.mockResolvedValue(stub.client);
    const out = await loadOrderKits(ORG, DC4, Promise.resolve({ items: DC4_CATALOG }));
    expect(out).toEqual({
      status: 'ok',
      kits: [
        {
          bundleId: 'b-new-hire',
          name: 'New Hire Bundle',
          sku: null,
          components: [
            { anchorItemId: 'backpack-18a', itemIds: ['backpack-18a', 'backpack-16b'], perKit: 1 },
            { anchorItemId: 'mug', itemIds: ['mug'], perKit: 1 },
            { anchorItemId: 'pad', itemIds: ['pad'], perKit: 1 },
            { anchorItemId: 'planner', itemIds: ['planner'], perKit: 1 },
          ],
        },
      ],
    });
  });

  it('returns no kits, and reads nothing, when the Bundles module is off', async () => {
    modulesMock.mockResolvedValue(new Set(['orders']));
    const out = await loadOrderKits(ORG, DC4, Promise.resolve({ items: DC4_CATALOG }));
    expect(out).toEqual({ status: 'ok', kits: [] });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('a failed bundles read is an ERROR, never "no kits", and it does not throw', async () => {
    const stub = client({ data: null, error: { message: 'boom', code: '57014' } });
    createClientMock.mockResolvedValue(stub.client);
    await expect(
      loadOrderKits(ORG, DC4, Promise.resolve({ items: DC4_CATALOG })),
    ).resolves.toEqual({ status: 'error' });
  });

  it('a failed catalog or module read is an error too', async () => {
    createClientMock.mockResolvedValue(client({ data: [NEW_HIRE], error: null }).client);
    await expect(loadOrderKits(ORG, DC4, Promise.reject(new Error('catalog')))).resolves.toEqual({
      status: 'error',
    });
    modulesMock.mockRejectedValue(new Error('org row'));
    await expect(
      loadOrderKits(ORG, DC4, Promise.resolve({ items: DC4_CATALOG })),
    ).resolves.toEqual({ status: 'error' });
  });
});

describe('resolveKits: which bundles are offered', () => {
  it('a component the visitor cannot read (row level security leaves it empty) drops the kit', () => {
    // Game Day Kit: a viewer granted only Sports reads the Football but not the
    // Home & Kitchen chopping board, so the kit is not offered to them.
    const football = named('football', 'FB-1');
    const b = bundle('b-game-day', 'Game Day Kit', [comp(football), comp(null, 1, false, 'board')]);
    expect(resolveKits([b], [cat('football', 'FB-1')], DC4)).toEqual([]);
  });

  it('a component whose SKU has no row in the visitor catalog here drops the kit', () => {
    expect(resolveKits([NEW_HIRE], DC4_CATALOG.filter((c) => c.id !== 'mug'), DC4)).toEqual([]);
  });

  it('a kit whose rows are at another warehouse is not offered here', () => {
    expect(resolveKits([NEW_HIRE], DC4_CATALOG, 'wh-lancaster')).toEqual([]);
  });

  it('a bundle with no required components is dropped, never unlimited', () => {
    expect(resolveKits([bundle('b-empty', 'Mid-edit', [])], DC4_CATALOG, DC4)).toEqual([]);
    expect(resolveKits([bundle('b-opt', 'Optional only', [comp(MUG, 1, true)])], DC4_CATALOG, DC4)).toEqual([]);
  });

  it('a per-kit quantity that is not a whole number drops the kit', () => {
    expect(resolveKits([bundle('b-frac', 'Half', [comp(MUG, '0.5000')])], DC4_CATALOG, DC4)).toEqual([]);
    expect(resolveKits([bundle('b-frac', 'Half', [comp(MUG, '1.5000')])], DC4_CATALOG, DC4)).toEqual([]);
    // numeric(14,4) arrives as "2.0000": a whole number.
    expect(resolveKits([bundle('b-two', 'Two', [comp(MUG, '2.0000')])], DC4_CATALOG, DC4)[0]!.components[0]!.perKit).toBe(2);
  });

  it('optional components are left out of the kit', () => {
    const b = bundle('b', 'With extra', [comp(MUG), comp(PAD, 1, true)]);
    expect(resolveKits([b], DC4_CATALOG, DC4)[0]!.components.map((c) => c.anchorItemId)).toEqual(['mug']);
  });

  it('a deleted named row drops the kit', () => {
    const b = bundle('b', 'Deleted', [comp(named('mug', 'SP-KS0UB-GLY', { deleted_at: '2026-09-01T00:00:00Z' }))]);
    expect(resolveKits([b], DC4_CATALOG, DC4)).toEqual([]);
  });

  it('the named row archived (not in the catalog) still offers the kit from its SKU other rows', () => {
    const catalog = DC4_CATALOG.filter((c) => c.id !== 'backpack-18a');
    const kit = resolveKits([NEW_HIRE], catalog, DC4)[0]!;
    expect(kit.components[0]).toEqual({
      anchorItemId: 'backpack-16b',
      itemIds: ['backpack-16b'],
      perKit: 1,
    });
  });

  it('never sends an item id the viewer catalog does not hold (review F8)', async () => {
    // 18-A archived: the walk found its id in the page's document stream as
    // the component's anchor, although the viewer was never given that row.
    const catalog = DC4_CATALOG.filter((c) => c.id !== 'backpack-18a');
    const stub = client({ data: [NEW_HIRE], error: null });
    createClientMock.mockResolvedValue(stub.client);
    const out = await loadOrderKits(ORG, DC4, Promise.resolve({ items: catalog }));
    expect(out.status).toBe('ok');
    const given = new Set(catalog.map((c) => c.id));
    const sent = JSON.stringify(out);
    expect(sent).not.toContain('backpack-18a');
    if (out.status !== 'ok') return;
    for (const component of out.kits.flatMap((k) => k.components)) {
      expect(given.has(component.anchorItemId)).toBe(true);
      for (const id of component.itemIds) expect(given.has(id)).toBe(true);
    }
  });

  it('never mixes stock earmarked for a charter into a generic component', () => {
    const catalog = [...DC4_CATALOG, cat('backpack-charter', 'SP-X6IN2-E84', { charterId: 'charter-9' })];
    const kit = resolveKits([NEW_HIRE], catalog, DC4)[0]!;
    expect(kit.components[0]!.itemIds).toEqual(['backpack-18a', 'backpack-16b']);
  });

  it('two components naming rows of one SKU are one component, counted once', () => {
    const b = bundle('b', 'Two backpacks', [
      comp(BACKPACK_18A),
      comp(named('backpack-16b', 'SP-X6IN2-E84'), 2),
    ]);
    expect(resolveKits([b], DC4_CATALOG, DC4)[0]!.components).toEqual([
      { anchorItemId: 'backpack-18a', itemIds: ['backpack-18a', 'backpack-16b'], perKit: 3 },
    ]);
  });

  it('a row with no SKU matches only itself', () => {
    const b = bundle('b', 'No SKU', [comp(named('loose', ''))]);
    const catalog = [cat('loose', ''), cat('other-blank', '')];
    expect(resolveKits([b], catalog, DC4)[0]!.components[0]!.itemIds).toEqual(['loose']);
  });
});
