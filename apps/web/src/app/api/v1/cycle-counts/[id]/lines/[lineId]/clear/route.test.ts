import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
 * POST /api/v1/cycle-counts/[id]/lines/[lineId]/clear: the phone count
 * screen's emptied box (B4a). Before it the phone could not clear a saved
 * count, so an emptied box kept the old count and Post applied it.
 *
 *   - it clears through CycleCountsService.clearCount, the call the web count
 *     screen's emptied box makes (clearCycleCountLineAction), with the
 *     request's own context, and reads no body;
 *   - it shares the record route's per-person rate limit;
 *   - a refusal is a 4xx carrying its code (the phone's drain treats that as
 *     final), anything else a 5xx (sent again), through the shared mapping.
 */

const CC = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-10-24T18:00:00.000Z');

function ctx() {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'staff' as const,
    supabase: makeSupabaseStub({}).client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['cycle_counts']),
  };
}

function request(ids: { id?: string; lineId?: string } = {}) {
  const id = ids.id ?? CC;
  const lineId = ids.lineId ?? LINE;
  return {
    req: new Request(`https://test.local/api/v1/cycle-counts/${id}/lines/${lineId}/clear`, {
      method: 'POST',
    }) as unknown as Parameters<typeof POST>[0],
    params: { params: Promise.resolve({ id, lineId }) },
  };
}

function mockClear(impl: (input: unknown) => Promise<void> = async () => {}) {
  const clearCount = vi.fn(impl);
  vi.mocked(CycleCountsService).mockImplementation(function () {
    return { clearCount } as unknown as InstanceType<typeof CycleCountsService>;
  });
  return clearCount;
}

describe('POST /api/v1/cycle-counts/[id]/lines/[lineId]/clear', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.mocked(withApiContext).mockResolvedValue(ctx());
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: NOW + 60_000,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the line through the service the web count screen uses, with no body', async () => {
    const clearCount = mockClear();
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(clearCount).toHaveBeenCalledTimes(1);
    expect(clearCount).toHaveBeenCalledWith({ cycleCountId: CC, lineId: LINE });
    // Built from this request's context: the caller's organization and account.
    expect(CycleCountsService).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', userId: 'u-1' }),
    );
  });

  it('answers 401 without a signed-in caller and clears nothing', async () => {
    const clearCount = mockClear();
    vi.mocked(withApiContext).mockResolvedValue(null);
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(401);
    expect(clearCount).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it.each([
    ['a count id that is not a uuid', { id: 'not-a-uuid' }],
    ['a line id that is not a uuid', { lineId: `${LINE}x` }],
  ])('%s is a 400, before the rate limit and the service', async (_label, ids) => {
    const clearCount = mockClear();
    const { req, params } = request(ids);
    const res = await POST(req, params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_id' });
    expect(clearCount).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("shares the record route's per-person budget, and a 429 says when to try again", async () => {
    const clearCount = mockClear();
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      count: 121,
      resetAt: NOW + 30_000,
    });
    const { req, params } = request();
    const res = await POST(req, params);
    expect(checkRateLimit).toHaveBeenCalledWith('cycle-count-record:u-1', 120, 60_000);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(clearCount).not.toHaveBeenCalled();
  });

  // The phone's drain (drain-failure.ts) parks a 400, 403, 409 or a 404 with
  // a code as final, and sends a 5xx again.
  it.each([
    ['forbidden', 403],
    ['module_disabled', 403],
    ['not_found', 404],
    ['validation_error', 400],
    ['conflict', 409],
    ['internal_error', 500],
  ] as const)('a %s refusal answers %i with its code', async (code, status) => {
    mockClear(async () => {
      throw new ServiceError(code, 'Line not found or no longer editable (relation "cycle_count_lines")');
    });
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(status);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe(code);
    if (code === 'internal_error') {
      // The raw database text never reaches the phone (S13).
      expect(body.message).not.toContain('cycle_count_lines');
    }
  });

  it('a throw that is not a ServiceError is a 500 (sent again)', async () => {
    mockClear(async () => {
      throw new Error('socket hang up');
    });
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('internal_error');
  });

  // S16: this branch used to answer the error's own text, and reported nothing.
  it('an unexpected error answers the fixed sentence, never its own text, and is reported', async () => {
    const err = new Error('relation "cycle_count_lines" does not exist');
    mockClear(async () => {
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
    expect(text).not.toContain('cycle_count_lines');
    expect(reportError).toHaveBeenCalledWith(err, {
      tag: 'api.v1.cycle_counts.clear',
      organizationId: 'org-1',
    });
  });

  // assertSessionAccess refuses with a ForbiddenError (not a ServiceError):
  // it was a 500, which the phone's drain sends again for ever.
  it('a warehouse refusal is 403 with its words, which the phone treats as final', async () => {
    mockClear(async () => {
      throw new ForbiddenError('You cannot modify a count that includes items with no warehouse.');
    });
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: 'You cannot modify a count that includes items with no warehouse.',
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a warehouse access check that could not be read is a 503 the phone sends again', async () => {
    mockClear(async () => {
      throw new ForbiddenError('User does not have write access to warehouse w-1.', {
        accessUnreadable: true,
      });
    });
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(await res.json()).toEqual({
      error: 'check_failed',
      message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
    });
  });
});
