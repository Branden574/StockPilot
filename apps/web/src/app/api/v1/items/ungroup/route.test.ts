// POST /api/v1/items/ungroup: the phone's Make this its own item (Ungroup,
// split_item_sku, migration 0399), over the same service as the web action.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUPING_ERROR_WORDS, type ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError } from '@/server/services/context';
import { ItemGroupingService } from '@/server/services/item-grouping';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/server/services/item-grouping', () => ({ ItemGroupingService: vi.fn() }));
vi.mock('@/server/services/context', () => ({
  ServiceError: class ServiceError extends Error {
    constructor(
      public code: string,
      message: string,
      public details?: Record<string, unknown>,
    ) {
      super(message);
    }
  },
  serviceErrorStatus: (code: string) =>
    ({
      unauthenticated: 401,
      forbidden: 403,
      not_found: 404,
      validation_error: 400,
      conflict: 409,
    })[code] ?? 500,
}));

const ORG = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';

function ctx() {
  return {
    organizationId: ORG,
    userId: ME,
    role: 'staff' as const,
    supabase: {} as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
  };
}

function req(body: unknown) {
  return new Request('https://test.local/api/v1/items/ungroup', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

function serviceAnswering(splitSku: (...a: unknown[]) => unknown) {
  vi.mocked(ItemGroupingService).mockImplementation(function () {
    return { splitSku } as unknown as InstanceType<typeof ItemGroupingService>;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    resetAt: Date.now() + 60_000,
  });
});

describe('POST /api/v1/items/ungroup', () => {
  it('401 with plain words when signed out', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(req({}));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'unauthenticated',
      message: GROUPING_ERROR_WORDS.unauthenticated,
    });
  });

  it('429 with retry-after past the per-user limit (30 a minute, shared with the web action)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 31,
      resetAt: Date.now() + 20_000,
    });
    const res = await POST(req({}));
    expect(checkRateLimit).toHaveBeenCalledWith(`item-grouping:${ME}`, 30, 60_000);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect((await res.json()).message).toBe(GROUPING_ERROR_WORDS.rateLimited);
  });

  it('passes the body to the service as the app surface and answers its result', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const splitSku = vi.fn(async () => ({
      organizationId: ORG,
      replay: false,
      items: [
        { id: 'a', beforeSku: 'S', afterSku: 'SP-ABCDE-1234567', kept: false, anchorItemId: null },
      ],
    }));
    serviceAnswering(splitSku);
    const res = await POST(req({ any: 'body' }));
    expect(splitSku).toHaveBeenCalledWith({ any: 'body' }, 'app');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      organizationId: ORG,
      result: {
        replay: false,
        items: [
          {
            id: 'a',
            beforeSku: 'S',
            afterSku: 'SP-ABCDE-1234567',
            kept: false,
            anchorItemId: null,
          },
        ],
      },
    });
  });

  it('an unreadable body reaches the service as null (it refuses it as validation_error)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const splitSku = vi.fn(async () => {
      throw new ServiceError('validation_error', GROUPING_ERROR_WORDS.invalid, {
        reason: 'invalid',
        field: 'body',
      });
    });
    serviceAnswering(splitSku);
    const res = await POST(req('{not json'));
    expect(splitSku).toHaveBeenCalledWith(null, 'app');
    expect(res.status).toBe(400);
  });

  it.each([
    ['not_shared', 'conflict', 409],
    ['item_changed', 'conflict', 409],
    ['item_not_found', 'not_found', 404],
    ['item_not_writable', 'forbidden', 403],
    ['busy', 'conflict', 503],
  ])('answers the refusal %s with its status and details', async (reason, code, status) => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    serviceAnswering(async () => {
      throw new ServiceError(code as never, 'words', { reason, itemIds: ['a'] });
    });
    const res = await POST(req({}));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({
      error: code,
      message: 'words',
      details: { reason, itemIds: ['a'] },
    });
  });

  it.each([
    ['aal2_required', 'Re-authenticate with MFA before performing this action.'],
    [
      'mfa_required',
      'Multi-factor authentication required. Enroll in MFA before performing this action.',
    ],
    ['permission', GROUPING_ERROR_WORDS.permission],
  ])(
    'the gate refusal %s is a 403 that keeps its reason (the phone steps up on aal2_required)',
    async (reason, message) => {
      vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
      serviceAnswering(async () => {
        throw new ServiceError('forbidden', message, { reason });
      });
      const res = await POST(req({}));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden', message, details: { reason } });
    },
  );

  it('an internal error answers 500 with no detail', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    serviceAnswering(async () => {
      throw new Error('boom');
    });
    const res = await POST(req({}));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'internal_error',
      message: GROUPING_ERROR_WORDS.internal,
    });
  });
});
