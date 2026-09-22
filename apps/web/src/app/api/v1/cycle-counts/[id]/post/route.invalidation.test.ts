// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The phone posts a cycle count through this route and nothing else. It used
 * to return without touching the Items/Books cache, so after a count posted on
 * the floor every manager's web list served the pre-count quantities for up
 * to the 60s TTL. These tests run the REAL route and the REAL
 * CycleCountsService.post against a Supabase stub, with only next/cache's
 * revalidateTag observed, so they prove the invalidation the phone now gets
 * and that a failed invalidation cannot turn a posted count into an error.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
// Warehouse scope is proven by the service's own tests; a manager passes here.
vi.mock('@/lib/auth/warehouse', () => ({
  assertWarehouseAccess: vi.fn(async () => undefined),
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-1'],
    writableIds: ['wh-1'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-1',
  })),
  ForbiddenError: class ForbiddenError extends Error {},
}));
vi.mock('@/server/services/integration-events', () => ({
  dispatchEvent: vi.fn(async () => undefined),
}));
// setup.ts stubs the never-throwing wrapper for every other file; run the real one.
vi.mock('@/server/services/lib/inventory-list-cache', async (importOriginal) => importOriginal());
vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidateTag: vi.fn(),
}));

import { revalidateTag } from 'next/cache';

import { POST } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const ORG = 'org-1';

function stubFor(rpc: { data: unknown; error: { message: string } | null }) {
  return makeSupabaseStub({
    // assertSessionAccess: the count's warehouse, then the write gate above.
    'cycle_counts.select': { data: { warehouse_id: 'wh-1' }, error: null },
    'rpc:post_cycle_count': rpc,
  });
}

function ctxFor(stub: ReturnType<typeof makeSupabaseStub>) {
  return {
    organizationId: ORG,
    userId: 'u-1',
    role: 'manager' as const,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['cycle_counts']),
  };
}

function request() {
  return {
    req: new Request(`https://test.local/api/v1/cycle-counts/${ID}/post`, {
      method: 'POST',
    }) as unknown as Parameters<typeof POST>[0],
    params: { params: Promise.resolve({ id: ID }) },
  };
}

const inventoryTagCalls = () =>
  vi.mocked(revalidateTag).mock.calls.filter(([tag]) => String(tag).startsWith('inventory-list-'));

describe('POST /api/v1/cycle-counts/[id]/post invalidates the Items/Books cache', () => {
  beforeEach(() => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  it('expires the org tag immediately, and only after the RPC committed', async () => {
    const stub = stubFor({ data: { id: ID, status: 'completed' }, error: null });
    vi.mocked(withApiContext).mockResolvedValueOnce(ctxFor(stub));
    const { req, params } = request();

    const res = await POST(req, params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cycleCount: { id: ID, status: 'completed' } });
    expect(stub.rpcCalls).toEqual([{ name: 'post_cycle_count', args: { p_cycle_count_id: ID } }]);
    // { expire: 0 }, not 'max': the next view must recompute, never serve the
    // pre-count entry one more time.
    expect(inventoryTagCalls()).toEqual([[`inventory-list-${ORG}`, { expire: 0 }]]);
    expect(vi.mocked(stub.client.rpc).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(revalidateTag).mock.invocationCallOrder[0]!,
    );
  });

  it('does not invalidate when the RPC refused the post (nothing moved)', async () => {
    const stub = stubFor({ data: null, error: { message: 'cycle_count_not_open' } });
    vi.mocked(withApiContext).mockResolvedValueOnce(ctxFor(stub));
    const { req, params } = request();

    const res = await POST(req, params);

    expect(res.status).toBe(409);
    expect(inventoryTagCalls()).toEqual([]);
  });

  it('a failed invalidation never fails the post: 200, the row, and a labelled warning', async () => {
    const stub = stubFor({ data: { id: ID, status: 'completed' }, error: null });
    vi.mocked(withApiContext).mockResolvedValueOnce(ctxFor(stub));
    vi.mocked(revalidateTag).mockImplementation(() => {
      throw new Error('Invariant: static generation store missing');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { req, params } = request();

    const res = await POST(req, params);

    // A 500 here would make the phone retry, and a retried post is refused as
    // "no longer open" after the stock already moved — the count looks lost.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cycleCount: { id: ID, status: 'completed' } });
    expect(warn).toHaveBeenCalledWith(
      '[inventory-list] invalidation skipped after cycle_count.post:',
      'Invariant: static generation store missing',
    );
  });
});
