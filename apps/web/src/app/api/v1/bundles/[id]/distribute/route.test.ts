import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { BundlesService } from '@/server/services/bundles';
import { ServiceError } from '@/server/services/context';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/server/services/bundles', () => ({ BundlesService: vi.fn() }));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));

const BUNDLE = '2f0b8f7e-1111-4222-8333-444455556666';
const WH = '3a1c9e8d-1111-4222-8333-444455556666';
const KEY = '7f1d3c2a-0000-4000-8000-000000000001';

function buildCtx() {
  const stub = makeSupabaseStub({});
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager' as const,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['bundles']),
  };
}

function request(body: unknown) {
  return new Request(`https://test.local/api/v1/bundles/${BUNDLE}/distribute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}
const params = { params: Promise.resolve({ id: BUNDLE }) };

describe('POST /api/v1/bundles/[id]/distribute — idempotency key (0347)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('threads idempotencyKey through to the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const distribute = vi.fn(async () => ({ distributionId: 'dist-1' }));
    vi.mocked(BundlesService).mockImplementationOnce(
      () => ({ distribute }) as unknown as InstanceType<typeof BundlesService>,
    );
    const res = await POST(request({ quantity: 2, warehouseId: WH, idempotencyKey: KEY }), params);
    expect(res.status).toBe(200);
    expect(distribute).toHaveBeenCalledWith(
      BUNDLE,
      expect.objectContaining({ quantity: 2, warehouseId: WH, idempotencyKey: KEY }),
    );
  });

  it('passes null when the body has no key (web-compatible)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const distribute = vi.fn(async () => ({ distributionId: 'dist-1' }));
    vi.mocked(BundlesService).mockImplementationOnce(
      () => ({ distribute }) as unknown as InstanceType<typeof BundlesService>,
    );
    await POST(request({ quantity: 1, warehouseId: WH }), params);
    expect(distribute).toHaveBeenCalledWith(BUNDLE, expect.objectContaining({ idempotencyKey: null }));
  });

  it('rejects a non-UUID key with 400 before touching the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await POST(request({ quantity: 1, warehouseId: WH, idempotencyKey: 'nope' }), params);
    expect(res.status).toBe(400);
    expect(BundlesService).not.toHaveBeenCalled();
  });

  it('surfaces a service conflict as 409', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const distribute = vi.fn(async () => {
      throw new ServiceError('conflict', 'already submitted with different details');
    });
    vi.mocked(BundlesService).mockImplementationOnce(
      () => ({ distribute }) as unknown as InstanceType<typeof BundlesService>,
    );
    const res = await POST(request({ quantity: 1, warehouseId: WH, idempotencyKey: KEY }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'conflict' });
  });
});
