import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ModuleId, type Role } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { orderReadinessFacts, visibleItemFacts } from '@/test/order-readiness-facts';
import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

/**
 * loadShortfallPoAction (F2-5): what the order page's "Draft PO for what is
 * short" dialog reads when it opens, and again after a refusal because the
 * numbers moved. Driven through the REAL readiness and suppliers services over
 * a stubbed client: readiness read again as core's shortfall view, and the
 * names of the suppliers the rows name (by id, archived ones included), in
 * parallel, for the draft's own floors only.
 * It never throws and never writes.
 */

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
const holder = vi.hoisted(() => ({ ctx: null as unknown, fail: false }));
vi.mock('@/server/services/context', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/context')>();
  return {
    ...real,
    withContext: vi.fn(async () => {
      if (holder.fail) throw new Error('no session');
      return holder.ctx;
    }),
  };
});

import { loadShortfallPoAction } from './order-readiness';

const ORDER = '0f000000-0000-4000-8000-000000000009';
const ITEM = '0f000000-0000-4000-8000-0000000000a1';
const SUP = '0f000000-0000-4000-8000-0000000000f1';

/** One line of 10; 2 on the shelf: 8 to draft, from SUP. */
const FACTS = orderReadinessFacts(
  ORDER,
  'approved',
  [{ lineId: 'L1', itemId: ITEM, requested: 10 }],
  [visibleItemFacts(ITEM, { here: { rack: 2 }, supplierId: SUP })],
);

function setup(
  opts: {
    role?: Role;
    permissions?: string[];
    modules?: ModuleId[];
    facts?: QueryResult;
    suppliers?: QueryResult;
  } = {},
) {
  const stub = makeSupabaseStub({
    'rpc:order_readiness_facts': opts.facts ?? { data: FACTS, error: null },
    'suppliers.select': opts.suppliers ?? {
      data: [
        { id: SUP, name: 'Acme Supply', deleted_at: null },
        { id: 'other', name: 'Paper Co', deleted_at: null },
      ],
      error: null,
    },
  });
  holder.ctx = makeServiceContext(stub.client, {
    role: opts.role ?? 'manager',
    enabledModules: new Set<ModuleId>(opts.modules ?? ['orders', 'purchase_orders', 'suppliers']),
    ...(opts.permissions ? { permissions: new Set(opts.permissions) } : {}),
  });
  return stub;
}

beforeEach(() => {
  vi.clearAllMocks();
  holder.fail = false;
});

describe('loadShortfallPoAction', () => {
  it("reads readiness again (core's shortfall view) and the names of the suppliers asked for, by id, and writes nothing", async () => {
    const stub = setup();
    const res = await loadShortfallPoAction({ orderId: ORDER, supplierIds: [SUP] });

    expect(res.supplierNames).toEqual({
      [SUP]: { name: 'Acme Supply', archived: false },
      other: { name: 'Paper Co', archived: false },
    });
    expect(res.view?.orderId).toBe(ORDER);
    expect(res.view?.rows.map((r) => [r.itemId, r.state, r.draftable, r.supplierId, r.detail])).toEqual([
      [ITEM, 'draftable', 8, SUP, 'Short 8'],
    ]);
    // One readiness read of THIS order, and nothing else called.
    expect(stub.rpcCalls).toEqual([{ name: 'order_readiness_facts', args: { p_order_id: ORDER } }]);
    expect([...new Set(stub.fromCalls)].sort()).toEqual(['suppliers']);
    // By id (review, pattern #3: never the organization's whole list), and
    // archived suppliers included (no deleted_at filter).
    const chains = stub.chainsAll.get('suppliers.select')!;
    const args = stub.chainArgsAll.get('suppliers.select')!;
    expect(chains).toHaveLength(1);
    expect(chains[0]).toContain('in');
    expect(chains[0]).not.toContain('is');
    expect(args[0]![chains[0]!.indexOf('in')]).toEqual(['id', [SUP]]);
    expect(args[0]![chains[0]!.indexOf('select')]).toEqual(['id, name, deleted_at']);
  });

  it('an archived supplier comes back marked archived (the draft still goes to it; core names it so)', async () => {
    setup({ suppliers: { data: [{ id: SUP, name: 'Acme Supply', deleted_at: '2026-09-01T00:00:00Z' }], error: null } });
    const res = await loadShortfallPoAction({ orderId: ORDER, supplierIds: [SUP] });
    expect(res.supplierNames).toEqual({ [SUP]: { name: 'Acme Supply', archived: true } });
  });

  it('a supplier the fresh view names beyond the ids asked for is read after, by id', async () => {
    const stub = setup();
    const res = await loadShortfallPoAction({ orderId: ORDER, supplierIds: [] });
    const chains = stub.chainsAll.get('suppliers.select')!;
    const args = stub.chainArgsAll.get('suppliers.select')!;
    expect(chains).toHaveLength(1);
    expect(args[0]![chains[0]!.indexOf('in')]).toEqual(['id', [SUP]]);
    expect(res.supplierNames?.[SUP]).toEqual({ name: 'Acme Supply', archived: false });
  });

  it('reads nothing for anyone the draft would refuse: not a manager, no purchase_orders:manage, a module off', async () => {
    const cases: Array<Parameters<typeof setup>[0]> = [
      // Staff with a purchase_orders:manage override (the database's manager_required).
      { role: 'staff', permissions: ['orders:read', 'purchase_orders:manage', 'items:update'] },
      // A manager whose purchase_orders:manage was revoked.
      { role: 'manager', permissions: ['orders:read', 'orders:approve', 'purchase_orders:read'] },
      { modules: ['purchase_orders', 'suppliers'] },
      { modules: ['orders', 'suppliers'] },
    ];
    for (const c of cases) {
      const stub = setup(c);
      expect(await loadShortfallPoAction({ orderId: ORDER, supplierIds: [SUP] })).toEqual({ view: null, supplierNames: null });
      expect(stub.rpcCalls).toEqual([]);
      expect(stub.fromCalls).toEqual([]);
    }
  });

  it('a bad id (the order or a supplier), or no session, reads nothing and does not throw', async () => {
    const stub = setup();
    expect(await loadShortfallPoAction({ orderId: 'not-a-uuid' })).toEqual({ view: null, supplierNames: null });
    expect(await loadShortfallPoAction({ orderId: ORDER, supplierIds: ['x'] })).toEqual({ view: null, supplierNames: null });
    holder.fail = true;
    expect(await loadShortfallPoAction({ orderId: ORDER })).toEqual({ view: null, supplierNames: null });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('each half that fails is null on its own: a failed readiness read keeps the names, a failed supplier read keeps the view', async () => {
    setup({ facts: { data: null, error: { message: 'boom', code: 'XX000' } } });
    const noView = await loadShortfallPoAction({ orderId: ORDER, supplierIds: [SUP] });
    expect(noView.view).toBeNull();
    expect(noView.supplierNames?.[SUP]).toEqual({ name: 'Acme Supply', archived: false });

    vi.mocked(reportError).mockClear();
    setup({ suppliers: { data: null, error: { message: 'timeout', code: '57014' } } });
    const noNames = await loadShortfallPoAction({ orderId: ORDER, supplierIds: [SUP] });
    expect(noNames.view?.rows).toHaveLength(1);
    expect(noNames.supplierNames).toBeNull();
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'actions.orders.shortfall_po_suppliers', level: 'warning' }),
    );
  });

  it('with the Suppliers module off, the supplier a draft will go to is still named (a label of what the item records, as on the PO screens)', async () => {
    const stub = setup({ modules: ['orders', 'purchase_orders'] });
    const res = await loadShortfallPoAction({ orderId: ORDER, supplierIds: [SUP] });
    expect(res.supplierNames?.[SUP]).toEqual({ name: 'Acme Supply', archived: false });
    expect(res.view?.rows).toHaveLength(1);
    expect(stub.fromCalls).toEqual(['suppliers']);
  });
});
