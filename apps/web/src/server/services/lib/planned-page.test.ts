import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const groups = vi.hoisted(() => ({
  forOrg: vi.fn(),
  byIds: vi.fn(),
}));
vi.mock('./display-groups', () => ({
  readDisplayGroupsForOrgAsMember: groups.forOrg,
  readDisplayGroupsByItemIds: groups.byIds,
}));

import type { InventoryService, PlanRow } from '../inventory';

import { planLivePage, readPlannedPage } from './planned-page';

// Phase 2 of the grouping brief: a staff member's or viewer's Items or Books
// page is planned group-aware over the whole filtered view (planLivePage) and
// then read exactly (readPlannedPage). PR #364 review: the failure paths and
// the batching had no tests of their own.

function planRow(id: string, over: Partial<PlanRow> = {}): PlanRow {
  return {
    id,
    sku: `SKU-${id}`,
    name: `Item ${id}`,
    group_id: null,
    quantity_on_hand: 1,
    unit_cost: 1,
    reorder_point: 0,
    category_id: null,
    status: 'active',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

function svc(over: Partial<Record<'listPlanRows' | 'list', ReturnType<typeof vi.fn>>>) {
  return {
    listPlanRows: over.listPlanRows ?? vi.fn(),
    list: over.list ?? vi.fn(),
  } as unknown as InventoryService;
}

const base = {
  viewFilters: {},
  sort: 'updated_desc' as const,
  page: 1,
  pageSize: 30,
  view: 'items' as const,
  client: {} as never,
  organizationId: 'org-1',
  logLabel: '[test page]',
};

beforeEach(() => {
  vi.clearAllMocks();
  groups.forOrg.mockResolvedValue(new Map());
  groups.byIds.mockResolvedValue(new Map());
});

describe('planLivePage', () => {
  it('a failed scan is no plan (the page keeps fixed slices), and the memberships still serve the page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const org = new Map([['a', { id: 'g1', name: 'Tees', version: 1 }]]);
    groups.forOrg.mockResolvedValue(org);
    const out = await planLivePage({
      ...base,
      inventorySvc: svc({ listPlanRows: vi.fn().mockRejectedValue(new Error('boom')) }),
    });
    expect(out).toEqual({ plannedPage: null, totals: null, displayGroups: org });
    expect(warn).toHaveBeenCalledWith(
      '[test page] page plan unavailable, using fixed pages:',
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('a view over the cap is no plan, with the totals left to the fixed page', async () => {
    const out = await planLivePage({
      ...base,
      inventorySvc: svc({ listPlanRows: vi.fn().mockResolvedValue(null) }),
    });
    expect(out.plannedPage).toBeNull();
    expect(out.totals).toBeNull();
  });

  it("an organization with more memberships than one request reads the planned view's own, and the plan keeps their group whole", async () => {
    groups.forOrg.mockResolvedValue(null);
    const rows = [planRow('g-1')];
    for (let i = 1; i <= 40; i++) {
      rows.push(
        planRow(`r${String(i).padStart(3, '0')}`, {
          updated_at: new Date(Date.UTC(2026, 9, 1) - i * 120_000).toISOString(),
        }),
      );
    }
    rows.push(planRow('g-2', { updated_at: '2026-09-01T00:00:00Z' }));
    const ref = { id: 'grp-1', name: 'Pair', version: 1 };
    groups.byIds.mockResolvedValue(
      new Map([
        ['g-1', ref],
        ['g-2', ref],
      ]),
    );
    const out = await planLivePage({
      ...base,
      inventorySvc: svc({
        listPlanRows: vi.fn().mockResolvedValue({ rows, total: rows.length, valueOnHand: 42 }),
      }),
    });
    expect(groups.byIds).toHaveBeenCalledWith(
      base.client,
      'org-1',
      rows.map((r) => r.id),
    );
    expect(out.plannedPage!.pageIds).toEqual(expect.arrayContaining(['g-1', 'g-2']));
    expect(out.totals).toEqual({ total: rows.length, valueOnHand: 42 });
    expect(out.displayGroups!.get('g-2')).toEqual(ref);
  });

  it("with no plan and more memberships than one request, the page reads its own records' (null)", async () => {
    groups.forOrg.mockResolvedValue(null);
    const out = await planLivePage({
      ...base,
      inventorySvc: svc({ listPlanRows: vi.fn().mockResolvedValue(null) }),
    });
    expect(out.displayGroups).toBeNull();
    expect(groups.byIds).not.toHaveBeenCalled();
  });
});

describe('readPlannedPage', () => {
  const totals = { total: 485, valueOnHand: 1234.5 };
  const item = (id: string) => ({ id }) as never;

  it('reads at most 100 ids per request, every read with the planned totals and the stock elsewhere, rows in the planned order', async () => {
    const ids = Array.from({ length: 150 }, (_x, i) => `id-${String(149 - i).padStart(3, '0')}`);
    const list = vi.fn(async (f: { ids: string[] }) => ({
      // The database answers in its own order.
      items: [...f.ids].sort().map(item),
      total: 485,
      valueOnHand: 1234.5,
      elsewhereUnavailable: false,
    }));
    const out = await readPlannedPage(svc({ list }), { q: 'tee' }, ids, totals);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls.map(([f]) => f.ids.length)).toEqual([100, 50]);
    for (const [f] of list.mock.calls) {
      expect(f).toMatchObject({
        q: 'tee',
        offset: 0,
        limit: f.ids.length,
        plannedTotals: totals,
        withElsewhere: true,
      });
    }
    expect(out.items.map((i: { id: string }) => i.id)).toEqual(ids);
    expect(out).toMatchObject({ total: 485, valueOnHand: 1234.5, elsewhereUnavailable: false });
  });

  it('a record gone between the plan and the read leaves no hole, and one read without the stock elsewhere says so', async () => {
    const list = vi.fn().mockResolvedValueOnce({
      items: [item('a'), item('c')],
      total: 3,
      valueOnHand: 0,
      elsewhereUnavailable: true,
    });
    const out = await readPlannedPage(svc({ list }), {}, ['a', 'b', 'c'], totals);
    expect(out.items.map((i: { id: string }) => i.id)).toEqual(['a', 'c']);
    expect(out.elsewhereUnavailable).toBe(true);
    expect(out.total).toBe(485);
  });

  it('an empty page reads nothing and answers the totals', async () => {
    const list = vi.fn();
    const out = await readPlannedPage(svc({ list }), {}, [], totals);
    expect(list).not.toHaveBeenCalled();
    expect(out).toEqual({
      items: [],
      total: 485,
      valueOnHand: 1234.5,
      elsewhereUnavailable: false,
    });
  });
});
