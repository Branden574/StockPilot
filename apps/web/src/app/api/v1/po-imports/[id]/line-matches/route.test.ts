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
vi.mock('@/server/services/po-imports', () => ({ PoImportsService: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

const IMPORT_ID = '11111111-1111-1111-1111-111111111111';
const LINE_ID = '22222222-2222-2222-2222-222222222222';

const MATCHES = {
  [LINE_ID]: [
    {
      id: 'item-1',
      name: 'Widget',
      sku: 'SKU-1',
      barcode: 'V1',
      quantityOnHand: 3,
      matchType: 'barcode',
    },
  ],
};

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
  return new Request(`https://test.local/api/v1/po-imports/${id}/line-matches`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
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

describe('POST /api/v1/po-imports/[id]/line-matches', () => {
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
    const res = await POST(buildRequest({ lineIds: [LINE_ID] }), buildParams());
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

    const res = await POST(buildRequest({ lineIds: [LINE_ID] }), buildParams());

    expect(res.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith('po-imports:write:u-1', 60, 60_000);
    expect(PoImportsService).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-uuid import id', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await POST(
      buildRequest({ lineIds: [LINE_ID] }, 'not-a-uuid'),
      buildParams('not-a-uuid'),
    );
    expect(res.status).toBe(400);
    expect(PoImportsService).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed lineIds (non-uuid entries)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await POST(buildRequest({ lineIds: ['nope'] }), buildParams());
    expect(res.status).toBe(400);
    expect(PoImportsService).not.toHaveBeenCalled();
  });

  it('maps a service forbidden (missing purchase_orders:manage) to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockService({
      findDuplicatesForLines: vi.fn(async () => {
        throw new ServiceError('forbidden', 'Missing permission: purchase_orders:manage');
      }),
    });

    const res = await POST(buildRequest({ lineIds: [LINE_ID] }), buildParams());
    expect(res.status).toBe(403);
  });

  it('maps a service not_found (foreign-org / unknown id) to 404', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockService({
      findDuplicatesForLines: vi.fn(async () => {
        throw new ServiceError('not_found', 'PO import not found');
      }),
    });

    const res = await POST(buildRequest({ lineIds: [LINE_ID] }), buildParams());
    expect(res.status).toBe(404);
  });

  it('returns { ok, matches } verbatim and passes path id + lineIds to the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const findDuplicatesForLines = vi.fn(async () => ({ matches: MATCHES }));
    mockService({ findDuplicatesForLines });

    const res = await POST(buildRequest({ lineIds: [LINE_ID] }), buildParams());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, matches: MATCHES });
    expect(PoImportsService).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', userId: 'u-1' }),
    );
    expect(findDuplicatesForLines).toHaveBeenCalledWith({
      poImportId: IMPORT_ID,
      lineIds: [LINE_ID],
    });
  });

  it('treats a missing body as "all lines" (lineIds undefined)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const findDuplicatesForLines = vi.fn(async () => ({ matches: {} }));
    mockService({ findDuplicatesForLines });

    const res = await POST(buildRequest(), buildParams());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, matches: {} });
    expect(findDuplicatesForLines).toHaveBeenCalledWith({
      poImportId: IMPORT_ID,
      lineIds: undefined,
    });
  });
});
