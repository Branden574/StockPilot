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

function buildRequest(id = IMPORT_ID) {
  return new Request(`https://test.local/api/v1/po-imports/${id}/cancel`, {
    method: 'POST',
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

const FOUND = { header: { id: IMPORT_ID, status: 'parsed' }, lines: [] };

describe('POST /api/v1/po-imports/[id]/cancel', () => {
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
    const res = await POST(buildRequest(), buildParams());
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

    const res = await POST(buildRequest(), buildParams());

    expect(res.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith('po-imports:write:u-1', 60, 60_000);
    expect(PoImportsService).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-uuid import id', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await POST(buildRequest('not-a-uuid'), buildParams('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(PoImportsService).not.toHaveBeenCalled();
  });

  it('returns 404 for a foreign-org / unknown id (org-scoped get) WITHOUT calling cancel', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const cancel = vi.fn();
    mockService({
      get: vi.fn(async () => {
        throw new ServiceError('not_found', 'PO import not found');
      }),
      cancel,
    });

    const res = await POST(buildRequest(), buildParams());

    expect(res.status).toBe(404);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('maps a service forbidden (missing purchase_orders:manage) to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockService({
      get: vi.fn(async () => FOUND),
      cancel: vi.fn(async () => {
        throw new ServiceError('forbidden', 'Missing permission: purchase_orders:manage');
      }),
    });

    const res = await POST(buildRequest(), buildParams());
    expect(res.status).toBe(403);
  });

  it('maps a service conflict (already approved/canceled) to 409', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockService({
      get: vi.fn(async () => FOUND),
      cancel: vi.fn(async () => {
        throw new ServiceError('conflict', 'Import not found or already finalized.');
      }),
    });

    const res = await POST(buildRequest(), buildParams());
    expect(res.status).toBe(409);
  });

  it('cancels via the service and returns { ok: true }', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const get = vi.fn(async () => FOUND);
    const cancel = vi.fn(async () => undefined);
    mockService({ get, cancel });

    const res = await POST(buildRequest(), buildParams());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(PoImportsService).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', userId: 'u-1' }),
    );
    expect(get).toHaveBeenCalledWith(IMPORT_ID);
    expect(cancel).toHaveBeenCalledWith(IMPORT_ID);
  });
});
