import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HOLD_NOT_APPLICABLE_COPY, type ModuleId } from '@stockpilot/core';

import { withContext } from '@/server/services/context';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * "Hold available stock" on the web (F2-2): the REAL action and the REAL
 * OrderRequestsService.holdStock against a Supabase stub; only the request
 * context, the warehouse check, the audit write, the broadcast and next/cache
 * are faked. It passes the order id only, answers what was held, refreshes
 * the storefront catalog (holds change what it shows as available) and words
 * every refusal as the service does.
 */

vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(),
}));
vi.mock('@/lib/auth/warehouse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/warehouse')>()),
  assertWarehouseAccess: vi.fn(async () => undefined),
}));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderChanged: vi.fn(async () => undefined) }));
vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { revalidatePath, revalidateTag } from 'next/cache';

import { holdOrderStockAction } from './order-requests';

const ORDER = '33333333-3333-4333-8333-333333333333';

function arrange(
  rpc: { data: unknown; error: { message: string; code?: string; hint?: string } | null },
  opts: { role?: 'manager' | 'viewer' } = {},
) {
  const stub = makeSupabaseStub({
    // requireWarehouseAccess reads the order's warehouse first.
    'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1' }, error: null },
    'rpc:hold_order_stock': rpc,
  });
  vi.mocked(withContext).mockResolvedValue(
    makeServiceContext(stub.client, {
      role: opts.role ?? 'manager',
      enabledModules: new Set<ModuleId>(['orders']),
    }) as never,
  );
  return stub;
}

beforeEach(() => {
  vi.mocked(revalidateTag).mockReset();
  vi.mocked(revalidatePath).mockReset();
});

describe('holdOrderStockAction (F2-2)', () => {
  it('holds for THIS order, answers what was held and still short, and refreshes the storefront catalog', async () => {
    const stub = arrange({
      data: { held: [{ itemId: 'i1', added: '8.0000' }], stillShort: [{ itemId: 'i2', quantity: 6 }] },
      error: null,
    });

    const res = await holdOrderStockAction({ id: ORDER });

    expect(res).toEqual({
      ok: true,
      data: { held: [{ itemId: 'i1', added: 8 }], stillShort: [{ itemId: 'i2', quantity: 6 }] },
    });
    expect(stub.rpcCalls).toEqual([{ name: 'hold_order_stock', args: { p_order_id: ORDER } }]);
    expect(revalidateTag).toHaveBeenCalledWith('orders-new-v2-catalog', 'max');
    expect(revalidatePath).toHaveBeenCalledWith(`/dashboard/orders/${ORDER}`);
  });

  it("a refusal comes back in the service's words, and nothing is refreshed", async () => {
    arrange({ data: null, error: { message: 'hold_not_applicable', code: 'P0001' } });
    await expect(holdOrderStockAction({ id: ORDER })).resolves.toEqual({
      ok: false,
      error: { code: 'conflict', message: HOLD_NOT_APPLICABLE_COPY },
    });
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('someone who may not approve orders is refused before the function is called', async () => {
    const stub = arrange({ data: { held: [], stillShort: [] }, error: null }, { role: 'viewer' });
    const res = await holdOrderStockAction({ id: ORDER });
    expect(res.ok).toBe(false);
    expect(stub.rpcCalls).toEqual([]);
    // The approve gate's own refusal (assertPermission), not the function's.
    if (!res.ok) expect(res.error.code).toBe('forbidden');
  });

  it('refuses an id that is not a uuid without calling anything', async () => {
    const stub = arrange({ data: { held: [], stillShort: [] }, error: null });
    await expect(holdOrderStockAction({ id: 'not-a-uuid' })).resolves.toEqual({
      ok: false,
      error: { code: 'validation_error', message: 'Invalid input' },
    });
    expect(stub.rpcCalls).toEqual([]);
  });
});
