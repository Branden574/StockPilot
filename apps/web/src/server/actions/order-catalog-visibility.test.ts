import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, ORDER_ITEMS_INTERNAL_COPY, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * setOrderCatalogVisibilityAction (ordering visibility, 0413; design 4.3 and
 * 7.2 item 4), through the real service: surface 'web', refusals with their
 * details, an internal error in core's words only, the catalog tag expired
 * with { expire: 0 }, and nothing handed to after() (no prewarm from a write).
 */

const { afterCallbacks, ctxRef, revalidateTag, reportError } = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => unknown>,
  ctxRef: { current: null as unknown },
  revalidateTag: vi.fn(),
  reportError: vi.fn(async () => {}),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ after: (cb: () => unknown) => afterCallbacks.push(cb) }));
vi.mock('next/cache', () => ({ revalidateTag, unstable_cache: vi.fn((fn: unknown) => fn) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/server/services/public-catalog', () => ({ expireOrgPublicCatalogs: vi.fn(async () => 0) }));
vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return { ...actual, withContext: vi.fn(async () => ctxRef.current) };
});

import { setOrderCatalogVisibilityAction } from './order-catalog-visibility';

const ORG = '0a0a0a0a-0000-4000-8000-000000000001';
const OP = '0c0c0c0c-0000-4000-8000-000000000001';
const ITEM = '0e0e0e0e-0000-4000-8000-000000000001';

function wire(rpc: { data: unknown; error: unknown }, permissions = ['orders:manage_catalog_visibility']) {
  const stub = makeSupabaseStub({ 'rpc:set_order_catalog_visibility': rpc as never });
  ctxRef.current = {
    ...makeServiceContext(stub.client, {
      organizationId: ORG,
      userId: 'user-1',
      role: 'manager',
      permissions: new Set(permissions),
      enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS),
    }),
    mfaEnrolled: false,
  };
  return stub;
}

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  vi.stubEnv('ORDER_ITEMS_MANAGE_ORGS', ORG);
});

describe('setOrderCatalogVisibilityAction', () => {
  it('hides through the one write path with surface web, expiring the catalog tag with expire 0', async () => {
    const stub = wire({
      data: { organizationId: ORG, operationId: OP, visible: false, changed: [ITEM], unchanged: [] },
      error: null,
    });

    const result = await setOrderCatalogVisibilityAction({ itemIds: [ITEM], visible: false, operationId: OP });

    expect(result).toEqual({
      ok: true,
      data: { organizationId: ORG, operationId: OP, visible: false, changed: [ITEM], unchanged: [] },
    });
    expect((stub.rpcCalls[0]!.args as { p_surface: string }).p_surface).toBe('web');
    expect(revalidateTag.mock.calls).toEqual([[`orders-new-v2-catalog:${ORG}`, { expire: 0 }]]);
    // No warming from a write (the no-request-path-prewarm guard).
    expect(afterCallbacks).toHaveLength(0);
  });

  it('a refusal keeps its code and details (the page decides by details.reason)', async () => {
    wire({
      data: null,
      error: { code: '55P03', message: 'canceling statement due to lock timeout' },
    });
    const result = await setOrderCatalogVisibilityAction({ itemIds: [ITEM], visible: false, operationId: OP });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'conflict', details: { reason: 'busy', retryable: true, operationId: OP } },
    });
    expect(afterCallbacks).toHaveLength(0);
  });

  it('no capability is the final forbidden refusal, nothing sent', async () => {
    const stub = wire({ data: null, error: null }, []);
    const result = await setOrderCatalogVisibilityAction({ itemIds: [ITEM], visible: true, operationId: OP });
    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden', details: { reason: 'forbidden' } } });
    expect(stub.rpcCalls).toEqual([]);
  });

  it("an internal error answers core's words only, reported with the cause", async () => {
    wire({ data: null, error: { code: 'XX000', message: 'relation secret does not exist' } });
    const result = await setOrderCatalogVisibilityAction({ itemIds: [ITEM], visible: false, operationId: OP });
    expect(result).toEqual({ ok: false, error: { code: 'internal_error', message: ORDER_ITEMS_INTERNAL_COPY } });
    expect(reportError).toHaveBeenCalledTimes(1);
    const reported = (reportError.mock.calls[0] as unknown as [Error])[0];
    expect(reported.message).toContain('relation secret');
  });
});
