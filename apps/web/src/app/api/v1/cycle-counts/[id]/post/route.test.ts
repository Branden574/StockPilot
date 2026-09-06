import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/server/services/cycle-counts', () => ({ CycleCountsService: vi.fn() }));

const ID = '11111111-1111-1111-1111-111111111111';

function buildCtx() {
  const stub = makeSupabaseStub({});
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager' as const,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['cycle_counts']),
  };
}

function buildRequest(id: string = ID) {
  return {
    req: new Request(`https://test.local/api/v1/cycle-counts/${id}/post`, {
      method: 'POST',
    }) as unknown as Parameters<typeof POST>[0],
    params: { params: Promise.resolve({ id }) },
  };
}

function mockPost(impl: () => Promise<unknown>) {
  const post = vi.fn(impl);
  vi.mocked(CycleCountsService).mockImplementation(
    () => ({ post }) as unknown as InstanceType<typeof CycleCountsService>,
  );
  return post;
}

describe('POST /api/v1/cycle-counts/[id]/post', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  it('returns 401 without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const { req, params } = buildRequest();
    const res = await POST(req, params);
    expect(res.status).toBe(401);
  });

  it('rejects a non-uuid id before touching the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const post = mockPost(async () => ({ id: ID }));
    const { req, params } = buildRequest('not-a-uuid');
    const res = await POST(req, params);
    expect(res.status).toBe(400);
    expect(post).not.toHaveBeenCalled();
  });

  it('posts through the service (module gate + audit + webhook) and returns the row', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const post = mockPost(async () => ({ id: ID, status: 'completed' }));
    const { req, params } = buildRequest();
    const res = await POST(req, params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      cycleCount: { id: ID, status: 'completed' },
    });
    expect(post).toHaveBeenCalledWith(ID);
  });

  it('passes a mapped refusal message through with a 400', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockPost(async () => {
      throw new ServiceError(
        'validation_error',
        'A line was counted before its stock changed and cannot be posted safely. Clear and recount that line, then post again.',
      );
    });
    const { req, params } = buildRequest();
    const res = await POST(req, params);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.message).toContain('Clear and recount that line');
  });

  it('maps forbidden to 403 and a disabled module to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockPost(async () => {
      throw new ServiceError('forbidden', 'You do not have permission to post this cycle count.');
    });
    const first = buildRequest();
    expect((await POST(first.req, first.params)).status).toBe(403);

    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockPost(async () => {
      throw new ServiceError('module_disabled', 'Module not enabled for this organization: cycle_counts');
    });
    const second = buildRequest();
    expect((await POST(second.req, second.params)).status).toBe(403);
  });

  it('maps a closed count to 409', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockPost(async () => {
      throw new ServiceError('conflict', 'This cycle count is no longer open.');
    });
    const { req, params } = buildRequest();
    const res = await POST(req, params);
    expect(res.status).toBe(409);
  });

  it('rate limits per user', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 31,
      resetAt: Date.now() + 30_000,
    });
    const post = mockPost(async () => ({ id: ID }));
    const { req, params } = buildRequest();
    const res = await POST(req, params);
    expect(res.status).toBe(429);
    expect(post).not.toHaveBeenCalled();
    expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toBe('cycle-count-post:u-1');
  });
});
