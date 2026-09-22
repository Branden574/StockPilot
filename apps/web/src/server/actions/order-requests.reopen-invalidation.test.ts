import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withContext } from '@/server/services/context';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Reopen picking gives complete_picking's draw back to the shelf
 * (reopen_picking -> adjust_stock). The web action used to revalidate only the
 * order pages and the storefront catalog, so after a manager reopened an order
 * the Items/Books list kept showing the picked units as gone for up to the 60s
 * TTL. This runs the REAL action and the REAL OrderRequestsService.reopenPicking
 * against a Supabase stub; only the request context and next/cache are faked.
 */

vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(),
}));
vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn(async () => undefined) }));
vi.mock('@/lib/realtime/broadcast', () => ({
  broadcastOrderChanged: vi.fn(async () => undefined),
}));
// setup.ts stubs the never-throwing wrapper for every other file; run the real one.
vi.mock('@/server/services/lib/inventory-list-cache', async (importOriginal) => importOriginal());
vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { revalidateTag } from 'next/cache';

import { reopenPickingAction } from './order-requests';

const ORDER = '22222222-2222-4222-8222-222222222222';
const ORG = 'org-reopen';

function arrange(rpc: { data: unknown; error: { message: string } | null }) {
  const stub = makeSupabaseStub({
    // requireWarehouseAccess reads the order's warehouse first.
    'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1' }, error: null },
    'rpc:reopen_picking': rpc,
  });
  vi.mocked(withContext).mockResolvedValue(
    makeServiceContext(stub.client, {
      organizationId: ORG,
      role: 'manager',
      enabledModules: new Set<ModuleId>(['orders']),
    }) as never,
  );
  return stub;
}

const inventoryTagCalls = () =>
  vi.mocked(revalidateTag).mock.calls.filter(([tag]) => String(tag).startsWith('inventory-list-'));

describe('reopenPickingAction invalidates the Items/Books cache', () => {
  beforeEach(() => {
    vi.mocked(revalidateTag).mockImplementation(() => undefined);
  });

  it('expires the org tag immediately after reopen_picking restocks', async () => {
    const stub = arrange({ data: { id: ORDER, status: 'picking_in_progress' }, error: null });

    const res = await reopenPickingAction({ id: ORDER, reason: '  Miscount on line 2 ' });

    expect(res).toEqual({ ok: true, data: undefined });
    expect(stub.rpcCalls).toEqual([
      { name: 'reopen_picking', args: { p_id: ORDER, p_reason: 'Miscount on line 2' } },
    ]);
    expect(inventoryTagCalls()).toEqual([[`inventory-list-${ORG}`, { expire: 0 }]]);
  });

  it('does not invalidate when the RPC refuses (already signed: nothing moved)', async () => {
    arrange({ data: null, error: { message: 'already_signed' } });

    const res = await reopenPickingAction({ id: ORDER, reason: 'Miscount' });

    expect(res).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(inventoryTagCalls()).toEqual([]);
  });

  it('a failed invalidation never fails the reopen', async () => {
    arrange({ data: { id: ORDER, status: 'picking_in_progress' }, error: null });
    vi.mocked(revalidateTag).mockImplementation((tag) => {
      if (String(tag).startsWith('inventory-list-')) throw new Error('cache backend down');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await reopenPickingAction({ id: ORDER, reason: 'Miscount' });

    // The stock already went back to the shelf; reporting failure would invite
    // a second reopen attempt against an order that is already reopened.
    expect(res).toEqual({ ok: true, data: undefined });
    expect(warn).toHaveBeenCalledWith(
      '[inventory-list] invalidation skipped after order.reopen_picking:',
      'cache backend down',
    );
  });
});
