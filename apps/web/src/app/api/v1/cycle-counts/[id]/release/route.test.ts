import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY, type ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ForbiddenError } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/server/services/cycle-counts', () => ({ CycleCountsService: vi.fn() }));

/**
 * POST /api/v1/cycle-counts/[id]/release: Release of a count the assignee cannot finish (S16).
 * A refusal keeps its code and words; anything else used to answer the
 * error's own text and report nothing.
 */

const CC = '11111111-1111-4111-8111-111111111111';

function ctx() {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager' as const,
    supabase: makeSupabaseStub({}).client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['cycle_counts']),
  };
}

function request() {
  return {
    req: new Request(`https://test.local/api/v1/cycle-counts/${CC}/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Out sick today' }),
    }) as unknown as Parameters<typeof POST>[0],
    params: { params: Promise.resolve({ id: CC }) },
  };
}

function mockService(impl: () => Promise<unknown>) {
  const release = vi.fn(impl);
  vi.mocked(CycleCountsService).mockImplementation(function () {
    return { release } as unknown as InstanceType<typeof CycleCountsService>;
  });
  return release;
}

describe('POST /api/v1/cycle-counts/[id]/release', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withApiContext).mockResolvedValue(ctx());
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  it('answers the row on success', async () => {
    const call = mockService(async () => ({ id: CC }));
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cycleCount: { id: CC } });
    expect(call).toHaveBeenCalledTimes(1);
    expect(checkRateLimit).toHaveBeenCalledWith('cycle-count-release:u-1', 30, 60_000);
  });

  it('a refusal keeps its code and its words', async () => {
    mockService(async () => {
      throw new ServiceError('conflict', 'This cycle count is closed.');
    });
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict', message: 'This cycle count is closed.' });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('an unexpected error answers the fixed sentence, never its own text, and is reported', async () => {
    const err = new Error('function release_cycle_count(uuid, text) does not exist');
    mockService(async () => {
      throw err;
    });
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: 'internal_error',
      message: 'Something went wrong. Please try again.',
    });
    expect(text).not.toContain('does not exist');
    expect(reportError).toHaveBeenCalledWith(err, {
      tag: 'api.v1.cycle_counts.release',
      organizationId: 'org-1',
    });
  });

  it('a warehouse refusal is 403 with its words; an unreadable access check is a 503', async () => {
    mockService(async () => {
      throw new ForbiddenError('User does not have write access to warehouse w-1.');
    });
    const a = request();
    const refused = await POST(a.req, a.params);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: 'forbidden',
      message: 'User does not have write access to warehouse w-1.',
    });

    mockService(async () => {
      throw new ForbiddenError('User does not have write access to warehouse w-1.', {
        accessUnreadable: true,
      });
    });
    const b = request();
    const unread = await POST(b.req, b.params);
    expect(unread.status).toBe(503);
    expect(unread.headers.get('Retry-After')).toBe('5');
    expect(await unread.json()).toEqual({
      error: 'check_failed',
      message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
    });
  });
});
