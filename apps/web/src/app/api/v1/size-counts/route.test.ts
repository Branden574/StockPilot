import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY, type ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ForbiddenError } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError } from '@/server/services/context';
import { SizeCountsService } from '@/server/services/size-counts';

import { POST, sizeCountError } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/server/services/size-counts', () => ({ SizeCountsService: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

function buildCtx(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin' as const,
    supabase: {} as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
    ...overrides,
  };
}

function buildRequest(body: unknown = {}) {
  return new Request('https://test.local/api/v1/size-counts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const createSession = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withApiContext).mockResolvedValue(buildCtx() as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    resetAt: Date.now() + 1000,
  } as never);
  createSession.mockResolvedValue({ id: 'sess-1' });
  vi.mocked(SizeCountsService).mockImplementation(function () {
    return { createSession } as unknown as SizeCountsService;
  });
});

/**
 * S13: raw Postgres/PostgREST text must never reach an API caller — the mobile
 * outbox stores the message in last_error and the crash reporter ships it.
 */
describe('sizeCountError — S13, no raw DB text in the 500 body', () => {
  const rlsText = 'new row violates row-level security policy for table "size_count_sessions"';

  it('does not echo a raw RLS error thrown by the service', async () => {
    createSession.mockRejectedValue(new Error(rlsText));
    const res = await POST(buildRequest({ mode: 'rapid_pass' }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string; message?: string };
    expect(body.error).toBe('internal_error');
    expect(JSON.stringify(body)).not.toContain('size_count_sessions');
    expect(JSON.stringify(body)).not.toContain('row-level security');
  });

  it('does not echo a deploy-before-migrate column error', () => {
    const res = sizeCountError(new Error('column size_count_sessions.foo does not exist'));
    expect(res.status).toBe(500);
    return res.json().then((body: unknown) => {
      expect(JSON.stringify(body)).not.toContain('does not exist');
    });
  });

  it('reports the swallowed detail server-side so the leak is not just deleted', async () => {
    createSession.mockRejectedValue(new Error(rlsText));
    await POST(buildRequest({}));
    // The route's tag, at the reporter's default level (error).
    expect(vi.mocked(reportError)).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'size-counts.api',
    });
  });

  it('answers the body an internal_error ServiceError answers, so the two cannot be told apart', async () => {
    const unexpected = await sizeCountError(new Error(rlsText)).json();
    const sanitized = await sizeCountError(new ServiceError('internal_error', rlsText)).json();
    expect(unexpected).toEqual({
      error: 'internal_error',
      message: 'An internal error occurred. Please try again.',
    });
    expect(sanitized).toEqual(unexpected);
  });

  it('still returns a human sentence so the phone does not render "internal_error"', () => {
    return sizeCountError(new Error(rlsText))
      .json()
      .then((body: { message?: string }) => {
        expect(typeof body.message).toBe('string');
        expect((body.message ?? '').length).toBeGreaterThan(10);
      });
  });
});

describe('sizeCountError — app-authored ServiceError text is still verbatim', () => {
  it.each([
    ['forbidden', 403],
    ['not_found', 404],
    ['conflict', 409],
    ['validation_error', 400],
    ['module_disabled', 403],
  ] as const)('maps %s to %i and keeps its message', async (code, status) => {
    const res = sizeCountError(new ServiceError(code, 'Pick a purchase order first.'));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code, message: 'Pick a purchase order first.' });
  });

  it('keeps an internal_error ServiceError generic (the constructor already sanitized it)', async () => {
    const res = sizeCountError(new ServiceError('internal_error', 'permission denied for table x'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { message?: string };
    expect(JSON.stringify(body)).not.toContain('permission denied');
  });
});

/**
 * B73: assertWarehouseAccess refuses with a ForbiddenError, which is not a
 * ServiceError. It is a refusal, not a failure: never a reported 500.
 * warehouse-refusal.test.ts drives the same answers through the real routes.
 */
describe('sizeCountError — a warehouse refusal is not an internal error (B73)', () => {
  const words = 'User does not have write access to warehouse X.';

  it('answers a refusal with a 403 and its own words, and does not report it', async () => {
    const res = sizeCountError(new ForbiddenError(words));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', message: words });
    expect(vi.mocked(reportError)).not.toHaveBeenCalled();
  });

  it('answers access that could not be read with a 503 to retry, reported as a warning', async () => {
    const e = new ForbiddenError(words, { accessUnreadable: true });
    const res = sizeCountError(e);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(await res.json()).toEqual({
      error: 'check_failed',
      message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
    });
    expect(vi.mocked(reportError)).toHaveBeenCalledWith(e, {
      tag: 'size-counts.api',
      level: 'warning',
    });
  });
});
