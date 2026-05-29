import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(),
}));

vi.mock('@/server/services/cycle-counts', () => ({
  CycleCountsService: vi.fn(),
}));

function buildCtx() {
  const stub = makeSupabaseStub({});
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager' as const,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    // Grandfathered org: the cycle_counts module is on so the gate is a
    // no-op (the service is mocked in this suite, but keep the fixture
    // truthful to a live org's enablement).
    enabledModules: new Set<ModuleId>(['cycle_counts']),
  };
}

function buildRequest(body: unknown) {
  return new Request('https://test.local/api/v1/cycle-counts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

describe('POST /api/v1/cycle-counts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(buildRequest({ scope: 'selection', itemIds: ['11111111-1111-1111-1111-111111111111'] }));
    expect(res.status).toBe(401);
  });

  it('creates a selection count and returns 201 with the result', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const start = vi.fn(async () => ({ id: 'cc-1', lineCount: 2, skipped: 0 }));
    vi.mocked(CycleCountsService).mockImplementationOnce(
      () => ({ start }) as unknown as InstanceType<typeof CycleCountsService>,
    );

    const res = await POST(
      buildRequest({
        scope: 'selection',
        itemIds: [
          '11111111-1111-1111-1111-111111111111',
          '22222222-2222-2222-2222-222222222222',
        ],
      }),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'cc-1', lineCount: 2, skipped: 0 });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'selection', warehouseId: null }),
    );
  });

  it('returns 400 when a selection has no itemIds', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await POST(buildRequest({ scope: 'selection', itemIds: [] }));
    expect(res.status).toBe(400);
  });

  it('maps a validation ServiceError to 400', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const start = vi.fn(async () => {
      throw new ServiceError('validation_error', 'None active');
    });
    vi.mocked(CycleCountsService).mockImplementationOnce(
      () => ({ start }) as unknown as InstanceType<typeof CycleCountsService>,
    );

    const res = await POST(
      buildRequest({ scope: 'selection', itemIds: ['33333333-3333-3333-3333-333333333333'] }),
    );
    expect(res.status).toBe(400);
  });
});
