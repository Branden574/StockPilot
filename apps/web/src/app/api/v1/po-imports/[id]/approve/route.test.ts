import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError } from '@/server/services/context';
import { PoImportsService } from '@/server/services/po-imports';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
// The route must reuse the service (never re-implement approve) — mock the
// class and assert construction + method args, mirroring cycle-counts' suite.
vi.mock('@/server/services/po-imports', () => ({ PoImportsService: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

const IMPORT_ID = '11111111-1111-1111-1111-111111111111';
const LINE_ID = '22222222-2222-2222-2222-222222222222';
const VENDOR_ID = '33333333-3333-3333-3333-333333333333';
const WAREHOUSE_ID = '44444444-4444-4444-4444-444444444444';
const ITEM_ID = '55555555-5555-5555-5555-555555555555';
const LOCATION_ID = '66666666-6666-6666-6666-666666666666';

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
  return new Request(`https://test.local/api/v1/po-imports/${id}/approve`, {
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

const goodBody = { warehouseId: WAREHOUSE_ID, vendorId: VENDOR_ID, locationId: LOCATION_ID };

describe('POST /api/v1/po-imports/[id]/approve', () => {
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

  it('returns 429 when rate-limited (60/min per user on the write-family key)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 61,
      resetAt: Date.now() + 30_000,
    });

    const res = await POST(buildRequest(goodBody), buildParams());

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(checkRateLimit).toHaveBeenCalledWith('po-imports:write:u-1', 60, 60_000);
    expect(PoImportsService).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-uuid import id', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await POST(buildRequest(goodBody, 'not-a-uuid'), buildParams('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(PoImportsService).not.toHaveBeenCalled();
  });

  it('returns 400 when locationId is missing (required — no auto-picked location)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await POST(
      buildRequest({ warehouseId: WAREHOUSE_ID, vendorId: VENDOR_ID }),
      buildParams(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
    expect(PoImportsService).not.toHaveBeenCalled();
  });

  it('maps a service forbidden (missing purchase_orders:manage) to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockService({
      approve: vi.fn(async () => {
        throw new ServiceError('forbidden', 'Missing permission: purchase_orders:manage');
      }),
    });

    const res = await POST(buildRequest(goodBody), buildParams());
    expect(res.status).toBe(403);
  });

  it('maps a service not_found (foreign-org / unknown id) to 404', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockService({
      approve: vi.fn(async () => {
        throw new ServiceError('not_found', 'PO import not found');
      }),
    });

    const res = await POST(buildRequest(goodBody), buildParams());
    expect(res.status).toBe(404);
  });

  it('maps a service conflict (already approved/canceled) to 409', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockService({
      approve: vi.fn(async () => {
        throw new ServiceError('conflict', "Cannot approve import in status 'approved'");
      }),
    });

    const res = await POST(buildRequest(goodBody), buildParams());
    expect(res.status).toBe(409);
  });

  it('approves via the service with path id + body fields and returns { ok, poId }', async () => {
    const ctx = buildCtx();
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx);
    const approve = vi.fn(async () => ({ poId: 'po-1' }));
    mockService({ approve });

    const res = await POST(
      buildRequest({
        ...goodBody,
        lineOverrides: [{ lineId: LINE_ID, itemId: ITEM_ID, skip: false }],
      }),
      buildParams(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, poId: 'po-1' });
    // Service constructed from the Bearer API ctx (NOT forCurrentUser —
    // that path is cookie-session-bound and dead on the Bearer surface).
    expect(PoImportsService).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', userId: 'u-1' }),
    );
    expect(approve).toHaveBeenCalledWith({
      poImportId: IMPORT_ID,
      warehouseId: WAREHOUSE_ID,
      vendorId: VENDOR_ID,
      locationId: LOCATION_ID,
      lineOverrides: [{ lineId: LINE_ID, itemId: ITEM_ID, skip: false }],
    });
  });

  it('defaults lineOverrides to [] (same zod as the web action)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const approve = vi.fn(async () => ({ poId: 'po-2' }));
    mockService({ approve });

    const res = await POST(buildRequest(goodBody), buildParams());

    expect(res.status).toBe(200);
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ poImportId: IMPORT_ID, lineOverrides: [] }),
    );
  });
});
