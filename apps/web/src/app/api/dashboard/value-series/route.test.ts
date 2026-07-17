import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError } from '@/server/services/context';
import {
  getDashboardValueComparison,
  type ValueComparison,
} from '@/server/services/movements';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { GET } from './route';

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(),
}));

vi.mock('@/server/services/movements', async (importOriginal) => {
  // Keep the real type exports but stub the loader so we control its result
  // per test (same pattern as movements/export.csv's suite).
  const actual = await importOriginal<typeof import('@/server/services/movements')>();
  return { ...actual, getDashboardValueComparison: vi.fn() };
});

// Mock the throttle. The real checkRateLimit hits the admin client, which has
// no DB in the test env. The allow-result is (re)set in beforeEach because the
// vitest config resets mock implementations between tests.
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
}));

function buildCtx(role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer') {
  const stub = makeSupabaseStub({});
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
  };
}

function buildRequest(query = ''): Parameters<typeof GET>[0] {
  return new Request(
    `https://test.local/api/dashboard/value-series${query}`,
  ) as unknown as Parameters<typeof GET>[0];
}

const SAMPLE: ValueComparison = {
  mode: 'previous',
  days: 30,
  basis: 'cost',
  series: [
    { label: 'Previous period', data: [1, 2, 3] },
    { label: 'Current period', data: [4, 5, 6] },
  ],
};

function stubLoader(result: ValueComparison = SAMPLE) {
  const fn = vi.mocked(getDashboardValueComparison);
  fn.mockResolvedValueOnce(result);
  return fn;
}

describe('GET /api/dashboard/value-series', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, resetAt: 0 });
  });

  it('401s without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await GET(buildRequest('?mode=previous&days=30&basis=cost'));
    expect(res.status).toBe(401);
  });

  it('403s for a role below manager+ — loader never invoked', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('staff'));
    const loader = stubLoader();
    const res = await GET(buildRequest('?mode=previous&days=30&basis=cost'));
    expect(res.status).toBe(403);
    expect(loader).not.toHaveBeenCalled();
  });

  it('returns 200 JSON for a manager and passes parsed params through', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    const loader = stubLoader();

    const res = await GET(
      buildRequest(
        '?mode=previous&days=90&basis=retail&warehouseId=11111111-1111-1111-1111-111111111111',
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ValueComparison;
    expect(body.series).toHaveLength(2);
    expect(loader).toHaveBeenCalledWith({
      ctx: expect.objectContaining({ organizationId: 'org-1' }),
      warehouseId: '11111111-1111-1111-1111-111111111111',
      days: 90,
      basis: 'retail',
      mode: 'previous',
    });
  });

  it.each(['locations', 'retail_vs_cost'] as const)(
    'returns 200 for mode=%s',
    async (mode) => {
      vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('owner'));
      stubLoader({ ...SAMPLE, mode });
      const res = await GET(buildRequest(`?mode=${mode}&days=30&basis=cost`));
      expect(res.status).toBe(200);
    },
  );

  it('400s on an invalid days value', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    const loader = stubLoader();
    const res = await GET(buildRequest('?mode=previous&days=45&basis=cost'));
    expect(res.status).toBe(400);
    expect(loader).not.toHaveBeenCalled();
  });

  it('400s on an invalid basis', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    stubLoader();
    const res = await GET(buildRequest('?mode=previous&days=30&basis=margin'));
    expect(res.status).toBe(400);
  });

  it('400s on a missing/unknown mode', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    stubLoader();
    const res = await GET(buildRequest('?days=30&basis=cost'));
    expect(res.status).toBe(400);
  });

  it('400s on a non-uuid warehouseId', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    const loader = stubLoader();
    const res = await GET(buildRequest('?mode=locations&days=30&basis=cost&warehouseId=not-a-uuid'));
    expect(res.status).toBe(400);
    expect(loader).not.toHaveBeenCalled();
  });

  it('defaults basis to cost when omitted', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    const loader = stubLoader();
    const res = await GET(buildRequest('?mode=previous&days=30'));
    expect(res.status).toBe(200);
    expect(loader).toHaveBeenCalledWith(expect.objectContaining({ basis: 'cost' }));
  });

  it('maps a ServiceError to its status code', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    vi.mocked(getDashboardValueComparison).mockRejectedValueOnce(
      new ServiceError('internal_error', 'boom'),
    );
    const res = await GET(buildRequest('?mode=previous&days=30&basis=cost'));
    expect(res.status).toBe(500);
  });
});
