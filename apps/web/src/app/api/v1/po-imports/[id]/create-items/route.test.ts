import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { revalidateInventoryList } from '@/server/loaders/inventory-list';
import { ServiceError } from '@/server/services/context';
import { PoImportsService } from '@/server/services/po-imports';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/server/services/po-imports', () => ({ PoImportsService: vi.fn() }));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

const IMPORT_ID = '11111111-1111-1111-1111-111111111111';
const LINE_ID = '22222222-2222-2222-2222-222222222222';
const VENDOR_ID = '33333333-3333-3333-3333-333333333333';
const WAREHOUSE_ID = '44444444-4444-4444-4444-444444444444';
const ITEM_ID = '55555555-5555-5555-5555-555555555555';

function buildCtx() {
  const stub = makeSupabaseStub({});
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager' as const,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['po_imports']),
  };
}

function buildRequest(body?: unknown, id = IMPORT_ID) {
  return new Request(`https://test.local/api/v1/po-imports/${id}/create-items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as Parameters<typeof POST>[0];
}

function buildParams(id = IMPORT_ID) {
  return { params: Promise.resolve({ id }) };
}

function mockService(methods: Record<string, unknown>) {
  vi.mocked(PoImportsService).mockImplementationOnce(
    () => methods as unknown as InstanceType<typeof PoImportsService>,
  );
}

const goodBody = {
  lineIds: [LINE_ID],
  vendorId: VENDOR_ID,
  warehouseId: WAREHOUSE_ID,
};

describe('POST /api/v1/po-imports/[id]/create-items', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  it('returns 401 without an auth context and never touches the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(buildRequest(goodBody), buildParams());
    expect(res.status).toBe(401);
    expect(PoImportsService).not.toHaveBeenCalled();
  });

  it('returns 429 when rate-limited on the shared write-family key', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 61,
      resetAt: Date.now() + 30_000,
    });

    const res = await POST(buildRequest(goodBody), buildParams());

    expect(res.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith('po-imports:write:u-1', 60, 60_000);
    expect(PoImportsService).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-uuid import id', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await POST(buildRequest(goodBody, 'not-a-uuid'), buildParams('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(PoImportsService).not.toHaveBeenCalled();
  });

  it('returns 400 when vendorId is missing / lineIds is empty', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await POST(
      buildRequest({ lineIds: [], warehouseId: WAREHOUSE_ID }),
      buildParams(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
    expect(PoImportsService).not.toHaveBeenCalled();
  });

  it('maps a service forbidden (missing purchase_orders:manage) to 403 without revalidating', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockService({
      createItemsFromLines: vi.fn(async () => {
        throw new ServiceError('forbidden', 'Missing permission: purchase_orders:manage');
      }),
    });

    const res = await POST(buildRequest(goodBody), buildParams());
    expect(res.status).toBe(403);
    expect(revalidateInventoryList).not.toHaveBeenCalled();
  });

  it('maps a service not_found (foreign-org / unknown id) to 404 without revalidating', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockService({
      createItemsFromLines: vi.fn(async () => {
        throw new ServiceError('not_found', 'PO import not found');
      }),
    });

    const res = await POST(buildRequest(goodBody), buildParams());
    expect(res.status).toBe(404);
    expect(revalidateInventoryList).not.toHaveBeenCalled();
  });

  it('creates via the service with path id + body fields, revalidates, returns counts verbatim', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const createItemsFromLines = vi.fn(async () => ({
      created: 2,
      mapped: 1,
      linked: 1,
      skipped: 0,
    }));
    mockService({ createItemsFromLines });

    const res = await POST(
      buildRequest({
        ...goodBody,
        itemType: 'book',
        decisions: { [LINE_ID]: { mode: 'use_existing', itemId: ITEM_ID } },
      }),
      buildParams(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, created: 2, mapped: 1, linked: 1, skipped: 0 });
    // Service constructed from the Bearer API ctx (NOT forCurrentUser).
    expect(PoImportsService).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', userId: 'u-1' }),
    );
    expect(createItemsFromLines).toHaveBeenCalledWith({
      poImportId: IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      itemType: 'book',
      decisions: { [LINE_ID]: { mode: 'use_existing', itemId: ITEM_ID } },
    });
    // New items must not linger out of the cached Items/Books list.
    expect(revalidateInventoryList).toHaveBeenCalledWith('org-1');
  });
});
