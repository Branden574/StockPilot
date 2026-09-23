import { describe, it, expect, vi } from 'vitest';

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
  assertPermission: vi.fn(),
  assertPlanLimit: vi.fn(),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));

import { InventoryService } from './inventory';

/**
 * The service delegates to the public.inventory_distinct_racks_for_org
 * Postgres function (migration 0357). The Supabase JS client's
 * `.rpc()` is what we mock here — the server-side DISTINCT + sort
 * is exercised in the SQL function itself
 * (supabase/tests/0357_inventory_distinct_racks_org_scope.test.sql).
 */
function makeSvc(rpcResult: { data: string[] | null; error: unknown }) {
  const rpcCalls: Array<[string, Record<string, unknown>]> = [];
   
  const supabase: any = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push([name, args]);
      return Promise.resolve(rpcResult);
    },
  };
  const svc = new InventoryService({
    supabase,
    organizationId: 'org-1',
    userId: 'u1',
    email: 'a@b.c',
    role: 'admin',
     
  } as any);
  return { svc, rpcCalls };
}

describe('InventoryService.listDistinctRacks', () => {
  it('passes the items scope through to the RPC and numeric-sorts the result', async () => {
    const { svc, rpcCalls } = makeSvc({
      // RPC sorts lexicographically ("12" < "20-A" < "5-B"), so the
      // service re-sorts numerically before returning. The dropdown
      // user reads "Rack 5 → 12 → 20" top-down instead of "12 → 20 → 5".
      data: ['12', '20-A', '5-B'],
      error: null,
    });
    const out = await svc.listDistinctRacks({ scope: 'items' });
    expect(rpcCalls).toEqual([
      ['inventory_distinct_racks_for_org', { p_org: 'org-1', p_scope: 'items' }],
    ]);
    expect(out).toEqual(['5-B', '12', '20-A']);
  });

  it('passes the books scope through to the RPC', async () => {
    const { svc, rpcCalls } = makeSvc({
      data: ['38-A', '40-B'],
      error: null,
    });
    const out = await svc.listDistinctRacks({ scope: 'books' });
    expect(rpcCalls).toEqual([
      ['inventory_distinct_racks_for_org', { p_org: 'org-1', p_scope: 'books' }],
    ]);
    expect(out).toEqual(['38-A', '40-B']);
  });

  // RLS scopes by MEMBERSHIP, so without the organization a user in two
  // organizations got both organizations' racks (the one-argument function).
  it('"all" asks for both scopes, each for THIS organization, and merges them', async () => {
    const { svc, rpcCalls } = makeSvc({ data: ['5-B', '12'], error: null });
    const out = await svc.listDistinctRacks({ scope: 'all' });
    expect(rpcCalls).toEqual([
      ['inventory_distinct_racks_for_org', { p_org: 'org-1', p_scope: 'items' }],
      ['inventory_distinct_racks_for_org', { p_org: 'org-1', p_scope: 'books' }],
    ]);
    expect(out).toEqual(['5-B', '12']);
  });

  it('never calls the organization-less function', async () => {
    const { svc, rpcCalls } = makeSvc({ data: [], error: null });
    await svc.listDistinctRacks({ scope: 'items' });
    await svc.listDistinctRacks({ scope: 'books' });
    await svc.listDistinctRacks({ scope: 'all' });
    expect(rpcCalls.map(([name]) => name)).not.toContain('inventory_distinct_racks');
    expect(rpcCalls.every(([, args]) => args.p_org === 'org-1')).toBe(true);
  });

  it('returns [] when the RPC returns null data', async () => {
    const { svc } = makeSvc({ data: null, error: null });
    const out = await svc.listDistinctRacks({ scope: 'items' });
    expect(out).toEqual([]);
  });

  it('throws a ServiceError when the RPC errors', async () => {
    const { svc } = makeSvc({ data: null, error: { message: 'rpc boom' } });
    await expect(svc.listDistinctRacks({ scope: 'items' })).rejects.toThrow(
      /rpc boom/,
    );
  });
});

// The app deploys when main is pushed; migrations are applied separately. A
// deploy that lands before 0357 must not take the Items and Books pages down.
describe('InventoryService.listDistinctRacks before migration 0357 is applied', () => {
  function makeSvcWithoutNewFunction(missingCode: string) {
    const rpcCalls: Array<[string, Record<string, unknown>]> = [];
    const supabase: any = {
      rpc: (name: string, args: Record<string, unknown>) => {
        rpcCalls.push([name, args]);
        if (name === 'inventory_distinct_racks_for_org') {
          return Promise.resolve({
            data: null,
            error: { code: missingCode, message: 'Could not find the function' },
          });
        }
        return Promise.resolve({ data: ['12', '5-B'], error: null });
      },
    };
    const svc = new InventoryService({
      supabase,
      organizationId: 'org-1',
      userId: 'u1',
      email: 'a@b.c',
      role: 'admin',
    } as any);
    return { svc, rpcCalls };
  }

  it.each(['PGRST202', '42883'])(
    'a missing function (%s) falls back to the one-argument function instead of failing the page',
    async (code) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { svc, rpcCalls } = makeSvcWithoutNewFunction(code);
      await expect(svc.listDistinctRacks({ scope: 'books' })).resolves.toEqual(['5-B', '12']);
      expect(rpcCalls).toEqual([
        ['inventory_distinct_racks_for_org', { p_org: 'org-1', p_scope: 'books' }],
        ['inventory_distinct_racks', { p_scope: 'books' }],
      ]);
      warn.mockRestore();
    },
  );

  it('any OTHER error still fails, with no fallback', async () => {
    const { svc, rpcCalls } = makeSvc({ data: null, error: { code: '57014', message: 'timeout' } });
    await expect(svc.listDistinctRacks({ scope: 'items' })).rejects.toThrow('timeout');
    expect(rpcCalls).toHaveLength(1);
  });
});
