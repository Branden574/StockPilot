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
 * The service now delegates to the public.inventory_distinct_racks
 * Postgres function (migration 0066). The Supabase JS client's
 * `.rpc()` is what we mock here — the server-side DISTINCT + sort
 * is exercised in the SQL function itself.
 */
function makeSvc(rpcResult: { data: string[] | null; error: unknown }) {
  const rpcCalls: Array<[string, Record<string, unknown>]> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return { svc, rpcCalls };
}

describe('InventoryService.listDistinctRacks', () => {
  it('passes the items scope through to the RPC', async () => {
    const { svc, rpcCalls } = makeSvc({
      data: ['12', '20-A', '5-B'],
      error: null,
    });
    const out = await svc.listDistinctRacks({ scope: 'items' });
    expect(rpcCalls).toEqual([['inventory_distinct_racks', { p_scope: 'items' }]]);
    expect(out).toEqual(['12', '20-A', '5-B']);
  });

  it('passes the books scope through to the RPC', async () => {
    const { svc, rpcCalls } = makeSvc({
      data: ['38-A', '40-B'],
      error: null,
    });
    const out = await svc.listDistinctRacks({ scope: 'books' });
    expect(rpcCalls).toEqual([['inventory_distinct_racks', { p_scope: 'books' }]]);
    expect(out).toEqual(['38-A', '40-B']);
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
