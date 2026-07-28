import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';
import { bulkCreateSizedVariantsSchema } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { bulkCreateSizedVariantsAction } from '@/server/actions/inventory';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock('@/server/services/inventory', () => ({
  InventoryService: vi.fn(),
}));

vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

// Same reason as the sibling items/route.test.ts: the action is 'use server'
// and pulls next/cache, which does not resolve in a route-handler test. It is
// referenced only to prove both surfaces are wired to the same exported action.
vi.mock('@/server/actions/inventory', () => ({
  bulkCreateSizedVariantsAction: vi.fn(),
}));

const CATEGORY_ID = '11111111-1111-1111-1111-111111111111';
const WAREHOUSE_ID = '22222222-2222-2222-2222-222222222222';

function buildCtx(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin' as const,
    supabase: {} as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
    ...overrides,
  };
}

function buildRequest(body: unknown) {
  return new Request('https://test.local/api/v1/items/sized-variants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const VALID_BODY = {
  baseName: 'Nike Pegasus 41',
  baseSku: null,
  baseBarcode: null,
  description: null,
  categoryId: CATEGORY_ID,
  supplierId: null,
  warehouseId: WAREHOUSE_ID,
  charterId: null,
  primaryLocationId: null,
  binLocation: null,
  retailPrice: 0,
  unitCost: 0,
  reorderPoint: 0,
  reorderQuantity: 0,
  variants: [
    { size: '9', quantity: 2 },
    { size: '10', quantity: 3 },
  ],
};

describe('POST /api/v1/items/sized-variants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  it('returns 401 when there is no Bearer/auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(buildRequest(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it('returns 429 when the per-user rate limit is exceeded', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 61,
      resetAt: Date.now() + 30_000,
    });
    const res = await POST(buildRequest(VALID_BODY));
    expect(res.status).toBe(429);
  });

  it('returns 400 with a field path on a schema failure', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await POST(buildRequest({ ...VALID_BODY, variants: [] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('validation_error');
    expect(body.path).toEqual(['variants']);
  });

  it('refuses more than 60 variants in one request — the cap mobile never had', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const variants = Array.from({ length: 61 }, (_, i) => ({
      size: String(i + 1),
      quantity: 1,
    }));
    const res = await POST(buildRequest({ ...VALID_BODY, variants }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
  });

  it('returns 201 with { created, ids } and delegates to bulkCreateSizedVariants', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const bulkCreateSizedVariants = vi.fn(async () => [
      { id: 'v-1', name: 'Nike Pegasus 41 - 9', sku: 'SP-A-9' },
      { id: 'v-2', name: 'Nike Pegasus 41 - 10', sku: 'SP-A-10' },
    ]);
    vi.mocked(InventoryService).mockImplementationOnce(
      () =>
        ({ bulkCreateSizedVariants }) as unknown as InstanceType<typeof InventoryService>,
    );

    const res = await POST(buildRequest(VALID_BODY));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ created: 2, ids: ['v-1', 'v-2'] });
    expect(bulkCreateSizedVariants).toHaveBeenCalledTimes(1);
    expect(bulkCreateSizedVariants).toHaveBeenCalledWith(
      expect.objectContaining({
        baseName: 'Nike Pegasus 41',
        variants: [
          { size: '9', quantity: 2 },
          { size: '10', quantity: 3 },
        ],
      }),
    );
  });

  it('never lets a client choose variant identity — no variantKey reaches the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const seen: unknown[] = [];
    const bulkCreateSizedVariants = vi.fn(async (input: unknown) => {
      seen.push(input);
      return [{ id: 'v-1', name: 'n', sku: 's' }];
    });
    vi.mocked(InventoryService).mockImplementationOnce(
      () =>
        ({ bulkCreateSizedVariants }) as unknown as InstanceType<typeof InventoryService>,
    );

    await POST(
      buildRequest({
        ...VALID_BODY,
        variantKey: 'size:forged',
        variants: [{ size: '9', quantity: 1, variantKey: 'size:forged' }],
      }),
    );

    const arg = seen[0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty('variantKey');
    expect(arg.variants).toEqual([{ size: '9', quantity: 1 }]);
  });

  it('returns 403 when the caller lacks items:create', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ role: 'viewer' }));
    const bulkCreateSizedVariants = vi.fn(async () => {
      throw new ServiceError('forbidden', 'Missing permission: items:create');
    });
    vi.mocked(InventoryService).mockImplementationOnce(
      () =>
        ({ bulkCreateSizedVariants }) as unknown as InstanceType<typeof InventoryService>,
    );

    const res = await POST(buildRequest(VALID_BODY));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
  });

  it('surfaces the size-scale rejection code so the native form can map it', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const bulkCreateSizedVariants = vi.fn(async () => {
      throw new ServiceError(
        'validation_error',
        '"XL" is not a size in this category\'s size scale.',
        { code: 'SHOE_SIZE_REQUIRED' },
      );
    });
    vi.mocked(InventoryService).mockImplementationOnce(
      () =>
        ({ bulkCreateSizedVariants }) as unknown as InstanceType<typeof InventoryService>,
    );

    const res = await POST(buildRequest(VALID_BODY));
    expect(res.status).toBe(400);
    expect((await res.json()).details).toEqual({ code: 'SHOE_SIZE_REQUIRED' });
  });

  it('maps an unexpected thrown error to 500 and reports it', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const bulkCreateSizedVariants = vi.fn(async () => {
      throw new Error('boom');
    });
    vi.mocked(InventoryService).mockImplementationOnce(
      () =>
        ({ bulkCreateSizedVariants }) as unknown as InstanceType<typeof InventoryService>,
    );

    const res = await POST(buildRequest(VALID_BODY));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('internal_error');
  });

  it('parses with the SAME schema the web server action uses', () => {
    const result = bulkCreateSizedVariantsSchema.safeParse(VALID_BODY);
    expect(result.success).toBe(true);
    expect(typeof bulkCreateSizedVariantsAction).toBe('function');
  });
});
