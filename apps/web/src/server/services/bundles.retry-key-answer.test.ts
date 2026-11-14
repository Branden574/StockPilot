import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A retry key is honoured only for the request it was stored for.
 *
 * distribute_bundle answers a key it has seen (0347) with the distribution id
 * its stored row names. When the caller sent a key, distribute() reads that
 * distribution in this organization and uses the answer only when it hands out
 * this kit, from this warehouse, in this quantity, by this person: what a
 * genuine retry of the same request gets back. Any other answer is the
 * existing conflict (409 on /api/v1/bundles/[id]/distribute), with no audit
 * row. A read that fails is an internal error, so the phone keeps the key and
 * sends the same request again. (The inventory list is invalidated as soon as
 * the function answers, before the read: a first send has already drawn the
 * components, and a list read again costs nothing when it has not.)
 */

vi.mock('./context', () => ({
  ServiceError: class extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
  assertPermission: vi.fn(),
  assertModuleEnabled: vi.fn(),
}));
const { audit, invalidate } = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  invalidate: vi.fn(),
}));
vi.mock('./audit', () => ({ audit }));
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: invalidate }));
vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn(async () => undefined) }));

import { makeSupabaseStub, servedLikePostgrest, type QueryResult } from '@/test/supabase-mock';

import { BundlesService } from './bundles';

const KEY = '7f1d3c2a-0000-4000-8000-0000000000aa';
const CONFLICT =
  'This distribution was already submitted with different details. Start a new distribution.';

/** The distribution a first send of the request below records (made-up values). */
const own = {
  id: 'dist-1',
  organization_id: 'org-1',
  bundle_id: 'b-1',
  warehouse_id: 'wh-1',
  quantity: 2,
  distributed_by: 'u-1',
};

function serviceWith(answer: string | null, distributions: QueryResult | Array<Record<string, unknown>>) {
  const rpc = vi.fn(async () => ({ data: answer, error: null }));
  const reads = makeSupabaseStub({
    // The kit is read in the organization before the function (S39).
    'bundles.select': { data: { id: 'b-1' }, error: null },
    'bundle_distributions.select': Array.isArray(distributions)
      ? servedLikePostgrest(distributions)
      : distributions,
  });
  const ctx = {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager',
    supabase: { rpc, from: reads.client.from },
  } as unknown as ConstructorParameters<typeof BundlesService>[0];
  return { svc: new BundlesService(ctx), rpc, reads };
}

const request = { quantity: 2, warehouseId: 'wh-1', idempotencyKey: KEY };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BundlesService.distribute: the answer to a retry key', () => {
  it('returns the distribution this request recorded (a genuine retry)', async () => {
    const { svc, reads } = serviceWith('dist-1', [own]);
    await expect(svc.distribute('b-1', request)).resolves.toEqual({ distributionId: 'dist-1' });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'bundle.distributed', entityId: 'dist-1' }),
      expect.anything(),
    );
    // Read in this organization, by the id the function answered.
    const chain = reads.chainsAll.get('bundle_distributions.select')?.[0] ?? [];
    const args = reads.chainArgsAll.get('bundle_distributions.select')?.[0] ?? [];
    const eqs = chain.flatMap((m, i) => (m === 'eq' ? [args[i]] : []));
    expect(eqs).toContainEqual(['organization_id', 'org-1']);
    expect(eqs).toContainEqual(['id', 'dist-1']);
  });

  it('reads nothing more when no key was sent (the web page: every send is new)', async () => {
    const { svc, reads } = serviceWith('dist-1', []);
    await expect(svc.distribute('b-1', { quantity: 2, warehouseId: 'wh-1' })).resolves.toEqual({
      distributionId: 'dist-1',
    });
    expect(reads.fromCalls).not.toContain('bundle_distributions');
  });

  const others: Array<[string, Array<Record<string, unknown>>]> = [
    ['a distribution of another kit', [{ ...own, bundle_id: 'b-9' }]],
    ['a distribution from another warehouse', [{ ...own, warehouse_id: 'wh-9' }]],
    ['a distribution of another quantity', [{ ...own, quantity: 5 }]],
    ['a distribution another person made', [{ ...own, distributed_by: 'u-9' }]],
    ['a distribution of another organization', [{ ...own, organization_id: 'org-9' }]],
    ['no distribution', []],
  ];

  it.each(others)('answers the existing conflict when the answer is %s', async (_label, rows) => {
    const { svc } = serviceWith('dist-1', rows);
    await expect(svc.distribute('b-1', request)).rejects.toMatchObject({
      code: 'conflict',
      message: CONFLICT,
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuses a quantity with more than four decimal places before anything is drawn, on every try', async () => {
    const { svc, rpc } = serviceWith('dist-1', [{ ...own, quantity: 2.1235 }]);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(svc.distribute('b-1', { ...request, quantity: 2.12345 })).rejects.toMatchObject({
        code: 'validation_error',
      });
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('compares the quantity at the four decimal places the column keeps', async () => {
    for (const stored of ['1.0001', 1.0001, '1.00010']) {
      const { svc } = serviceWith('dist-1', [{ ...own, quantity: stored }]);
      await expect(svc.distribute('b-1', { ...request, quantity: 1.0001 })).resolves.toEqual({
        distributionId: 'dist-1',
      });
    }
  });

  it('matches the kit and warehouse ids whatever their letter case', async () => {
    const { svc } = serviceWith('dist-1', [{ ...own, bundle_id: 'b-1', warehouse_id: 'wh-1' }]);
    await expect(svc.distribute('B-1', { ...request, warehouseId: 'WH-1' })).resolves.toEqual({
      distributionId: 'dist-1',
    });
  });

  it('answers an internal error, not a conflict, when the distribution cannot be read', async () => {
    const { svc } = serviceWith('dist-1', { data: null, error: { message: 'read failed' } });
    await expect(svc.distribute('b-1', request)).rejects.toMatchObject({ code: 'internal_error' });
    expect(audit).not.toHaveBeenCalled();
  });
});
