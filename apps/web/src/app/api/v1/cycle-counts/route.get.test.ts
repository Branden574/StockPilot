import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { GET } from './route';

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(),
}));

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

vi.mock('@/server/services/cycle-counts', () => ({
  CycleCountsService: vi.fn(),
}));

function buildCtx() {
  const stub = makeSupabaseStub({});
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'staff' as const,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['cycle_counts']),
  };
}

function get(query = '') {
  return new Request(`https://test.local/api/v1/cycle-counts${query}`, {
    method: 'GET',
  }) as unknown as Parameters<typeof GET>[0];
}

const PAGE = {
  items: [{ id: 'cc-1', countNumber: 42 }],
  page: 2,
  pageSize: 25,
  total: 137,
  totalPages: 6,
  hasPrevious: true,
  hasNext: true,
};

function mockListPage(impl: (...args: unknown[]) => unknown = async () => PAGE) {
  const listPage = vi.fn(impl);
  vi.mocked(CycleCountsService).mockImplementationOnce(function () {
    return { listPage } as unknown as InstanceType<typeof CycleCountsService>;
  });
  return listPage;
}

describe('GET /api/v1/cycle-counts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 without an auth context and never reaches the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await GET(get());
    expect(res.status).toBe(401);
    expect(CycleCountsService).not.toHaveBeenCalled();
  });

  it('returns the page contract, the organization it belongs to, and no-store', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const listPage = mockListPage();
    const res = await GET(get('?q=CC-000042&page=2&status=completed'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.json();
    expect(body).toMatchObject({ organizationId: 'org-1', ...PAGE });
    expect(listPage).toHaveBeenCalledWith(
      {
        q: 'CC-000042',
        page: '2',
        status: 'completed',
        warehouseId: null,
        assignedTo: null,
        unassigned: false,
      },
      { includeSummary: false },
    );
  });

  it('treats an unknown status as all statuses', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const listPage = mockListPage();
    await GET(get('?status=posted'));
    expect(listPage.mock.calls[0]![0]).toMatchObject({ status: null });
  });

  it('maps assigned=me to the caller, assigned=unassigned to the flag', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    let listPage = mockListPage();
    await GET(get('?assigned=me'));
    expect(listPage.mock.calls[0]![0]).toMatchObject({ assignedTo: 'u-1', unassigned: false });

    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    listPage = mockListPage();
    await GET(get('?assigned=unassigned'));
    expect(listPage.mock.calls[0]![0]).toMatchObject({ assignedTo: null, unassigned: true });

    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    listPage = mockListPage();
    await GET(get('?assigned=22222222-2222-2222-2222-222222222222'));
    expect(listPage.mock.calls[0]![0]).toMatchObject({
      assignedTo: '22222222-2222-2222-2222-222222222222',
    });
  });

  it('asks for the summary only with summary=1', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const listPage = mockListPage(async () => ({ ...PAGE, summary: { inProgress: 3, startedToday: 1 } }));
    const res = await GET(get('?summary=1'));
    expect(listPage.mock.calls[0]![1]).toEqual({ includeSummary: true });
    expect((await res.json()).summary).toEqual({ inProgress: 3, startedToday: 1 });
  });

  it.each([
    ['?q=' + 'x'.repeat(201)],
    ['?assigned=someone'],
    ['?warehouseId=not-a-uuid'],
    ['?summary=yes'],
    ['?page=' + '9'.repeat(20)],
  ])('rejects %s with 400 before the service', async (query) => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await GET(get(query));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
    expect(CycleCountsService).not.toHaveBeenCalled();
  });

  it('maps service refusals to their status codes', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockListPage(async () => {
      throw new ServiceError('forbidden', 'You do not have access to cycle counts.');
    });
    expect((await GET(get())).status).toBe(403);

    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockListPage(async () => {
      throw new ServiceError('module_disabled', 'off');
    });
    expect((await GET(get())).status).toBe(403);

    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockListPage(async () => {
      throw new ServiceError('internal_error', 'Could not check which warehouses you can see. Try again.');
    });
    expect((await GET(get())).status).toBe(500);
  });

  it('an unexpected throw is a 500 with no detail', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockListPage(async () => {
      throw new Error('socket hang up at 10.0.0.1');
    });
    const res = await GET(get());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
  });
});
