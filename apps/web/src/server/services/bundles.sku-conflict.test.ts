import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A bundle SKU is unique per organization (bundles_org_sku_unique). A duplicate
 * used to reach the form as "An internal error occurred" because the 23505 was
 * passed through as internal_error. It must say the SKU is taken.
 */

vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { BUNDLE_SKU_TAKEN, BundlesService } from './bundles';

const DUP = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "bundles_org_sku_unique"',
};

function service(results: Parameters<typeof makeSupabaseStub>[0]) {
  const stub = makeSupabaseStub(results);
  return new BundlesService(makeServiceContext(stub.client, { role: 'manager' }));
}

beforeEach(() => vi.clearAllMocks());

describe('bundle SKU already taken', () => {
  it('create: a duplicate SKU is a conflict with a sentence, not an internal error', async () => {
    const svc = service({ 'bundles.insert': { data: null, error: DUP } });
    await expect(
      svc.create({
        name: 'New Hire Bundle',
        sku: 'NHB',
        components: [{ itemId: 'i-1', quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'conflict', message: BUNDLE_SKU_TAKEN });
  });

  it('update: a duplicate SKU is the same conflict', async () => {
    const svc = service({ 'bundles.update': { data: null, error: DUP } });
    await expect(svc.update('b-1', { sku: 'NHB' })).rejects.toMatchObject({
      code: 'conflict',
      message: BUNDLE_SKU_TAKEN,
    });
  });

  it('any other failure stays an internal error (no false "SKU taken")', async () => {
    const svc = service({
      'bundles.insert': {
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "bundles_pkey"',
        },
      },
    });
    await expect(
      svc.create({ name: 'X', sku: null, components: [{ itemId: 'i-1', quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });
});
