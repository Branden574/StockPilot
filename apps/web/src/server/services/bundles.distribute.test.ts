import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * distribute() and the 0347 idempotency key. What these pin:
 *   * the key the caller supplies reaches the RPC as p_idempotency_key, and a
 *     caller that sends none passes null (the web modal's historical path);
 *   * the RPC's idempotency_conflict is surfaced as a 'conflict' ServiceError
 *     (the route maps that to 409) — never as internal_error, and never as a
 *     silent success.
 * The RPC itself is proven by supabase/tests/0347_distribute_bundle_idempotency.test.sql.
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
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn(async () => undefined) }));

import { BundlesService } from './bundles';
import { ServiceError } from './context';

const rpc = vi.fn();
const ctx = {
  organizationId: 'org-1',
  userId: 'u-1',
  role: 'manager',
  supabase: { rpc },
} as unknown as ConstructorParameters<typeof BundlesService>[0];

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: 'dist-1', error: null });
});

describe('BundlesService.distribute — idempotency key (0347)', () => {
  it('passes the caller key to the RPC as p_idempotency_key', async () => {
    const svc = new BundlesService(ctx);
    const out = await svc.distribute('b-1', {
      quantity: 2,
      warehouseId: 'wh-1',
      idempotencyKey: '7f1d3c2a-0000-4000-8000-000000000001',
    });
    expect(out).toEqual({ distributionId: 'dist-1' });
    expect(rpc).toHaveBeenCalledWith(
      'distribute_bundle',
      expect.objectContaining({
        p_bundle_id: 'b-1',
        p_quantity: 2,
        p_warehouse_id: 'wh-1',
        p_idempotency_key: '7f1d3c2a-0000-4000-8000-000000000001',
      }),
    );
  });

  it('sends null when no key is given — the web modal path is unchanged', async () => {
    const svc = new BundlesService(ctx);
    await svc.distribute('b-1', { quantity: 1, warehouseId: 'wh-1' });
    expect(rpc).toHaveBeenCalledWith(
      'distribute_bundle',
      expect.objectContaining({ p_idempotency_key: null }),
    );
  });

  it('maps idempotency_conflict to a conflict error, not internal_error', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'idempotency_conflict' } });
    const svc = new BundlesService(ctx);
    await expect(
      svc.distribute('b-1', { quantity: 3, warehouseId: 'wh-1', idempotencyKey: 'k' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      svc.distribute('b-1', { quantity: 3, warehouseId: 'wh-1', idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});
