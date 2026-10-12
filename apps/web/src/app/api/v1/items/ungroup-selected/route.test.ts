// POST /api/v1/items/ungroup-selected and POST /api/v1/items/ungroup-selected/
// preview: the phone's Ungroup for any ticked records (owner 2026-10-12), over
// the same service as the web actions (UngroupSelectedService). Bearer or
// cookie; online only (the phone never queues them).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUPING_ERROR_WORDS, UNGROUP_COPY, type ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError } from '@/server/services/context';
import { UngroupSelectedService } from '@/server/services/ungroup-selected';

import { POST as PREVIEW } from './preview/route';
import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/server/services/ungroup-selected', () => ({ UngroupSelectedService: vi.fn() }));
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
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

function req(url: string, body: unknown) {
  return new Request(`https://test.local${url}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

function serviceAnswering(methods: Record<string, (...a: unknown[]) => unknown>) {
  vi.mocked(UngroupSelectedService).mockImplementation(function () {
    return methods as unknown as InstanceType<typeof UngroupSelectedService>;
  });
}

const PART = {
  kind: 'unlink',
  status: 'partial',
  changedItemIds: [A],
  notChangedItemIds: ['b'],
  message: GROUPING_ERROR_WORDS.notWritable,
  reason: 'forbidden',
  retryable: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withApiContext).mockResolvedValue(ctx() as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    resetAt: Date.now() + 60_000,
  } as never);
});

describe('POST /api/v1/items/ungroup-selected', () => {
  it('401 with plain words when signed out, before the rate limit', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const r = await POST(req('/api/v1/items/ungroup-selected', {}));
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({
      error: 'unauthenticated',
      message: GROUPING_ERROR_WORDS.unauthenticated,
    });
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('applies as the app surface in the grouping bucket and answers every step, even one that applied in part (200)', async () => {
    const apply = vi.fn(async () => ({
      organizationId: ORG,
      outcome: { complete: false, parts: [PART] },
    }));
    serviceAnswering({ apply });
    const r = await POST(req('/api/v1/items/ungroup-selected', { some: 'body' }));
    expect(checkRateLimit).toHaveBeenCalledWith(`item-grouping:${ME}`, 30, 60_000);
    expect(apply).toHaveBeenCalledWith({ some: 'body' }, 'app');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      organizationId: ORG,
      result: { complete: false, parts: [PART] },
    });
  });

  it('429 with retry-after when rate limited, without calling the service', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 31,
      resetAt: Date.now() + 30_000,
    } as never);
    const apply = vi.fn();
    serviceAnswering({ apply });
    const r = await POST(req('/api/v1/items/ungroup-selected', {}));
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBeTruthy();
    expect(apply).not.toHaveBeenCalled();
  });

  it('maps a refusal before any write by reason: 403 family permission, 409 family changed, 404 gone, 400 the body', async () => {
    const cases: Array<[ServiceError, number]> = [
      [
        new ServiceError('forbidden', UNGROUP_COPY.familyPermission, {
          reason: 'family_permission',
        }),
        403,
      ],
      [
        new ServiceError('conflict', UNGROUP_COPY.familyChanged, {
          reason: 'family_changed',
          itemIds: [A],
        }),
        409,
      ],
      [
        new ServiceError('not_found', GROUPING_ERROR_WORDS.notFound, { reason: 'item_not_found' }),
        404,
      ],
      [
        new ServiceError('validation_error', GROUPING_ERROR_WORDS.invalid, {
          reason: 'invalid',
          field: 'body',
        }),
        400,
      ],
      [new ServiceError('forbidden', 'MFA', { reason: 'aal2_required' }), 403],
    ];
    for (const [e, status] of cases) {
      serviceAnswering({ apply: vi.fn(async () => Promise.reject(e)) });
      const r = await POST(req('/api/v1/items/ungroup-selected', {}));
      expect(r.status, String(e.details?.reason)).toBe(status);
      expect(await r.json()).toEqual({ error: e.code, message: e.message, details: e.details });
    }
  });

  it('500 with the generic sentence for anything else (no internals)', async () => {
    serviceAnswering({
      apply: vi.fn(async () => Promise.reject(new Error('relation "x" missing'))),
    });
    const r = await POST(req('/api/v1/items/ungroup-selected', {}));
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({
      error: 'internal_error',
      message: GROUPING_ERROR_WORDS.internal,
    });
  });
});

describe('POST /api/v1/items/ungroup-selected/preview', () => {
  it('answers the review for the ids in the preview bucket, with the organization and the account', async () => {
    const preview = vi.fn(async () => ({
      review: { records: [] },
      candidates: [],
      canUnlinkFamilies: false,
      previewKey: 'k',
    }));
    serviceAnswering({ preview });
    const r = await PREVIEW(req('/api/v1/items/ungroup-selected/preview', { itemIds: [A] }));
    expect(checkRateLimit).toHaveBeenCalledWith(`item-grouping-preview:${ME}`, 60, 60_000);
    expect(preview).toHaveBeenCalledWith([A]);
    expect(await r.json()).toEqual({
      organizationId: ORG,
      actorUserId: ME,
      review: { records: [] },
      candidates: [],
      canUnlinkFamilies: false,
      previewKey: 'k',
    });
  });

  it('400 for a body without an id list, before the service', async () => {
    const preview = vi.fn();
    serviceAnswering({ preview });
    for (const body of [{}, { itemIds: 'x' }, { itemIds: [1] }, 'not json']) {
      const r = await PREVIEW(req('/api/v1/items/ungroup-selected/preview', body));
      expect(r.status).toBe(400);
    }
    expect(preview).not.toHaveBeenCalled();
  });

  it('401 when signed out; 403 keeps the permission refusal; 500 says nothing internal', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    expect(
      (await PREVIEW(req('/api/v1/items/ungroup-selected/preview', { itemIds: [A] }))).status,
    ).toBe(401);
    serviceAnswering({
      preview: vi.fn(async () =>
        Promise.reject(
          new ServiceError('forbidden', GROUPING_ERROR_WORDS.permission, { reason: 'permission' }),
        ),
      ),
    });
    const r = await PREVIEW(req('/api/v1/items/ungroup-selected/preview', { itemIds: [A] }));
    expect(r.status).toBe(403);
    serviceAnswering({ preview: vi.fn(async () => Promise.reject(new Error('boom'))) });
    const r2 = await PREVIEW(req('/api/v1/items/ungroup-selected/preview', { itemIds: [A] }));
    expect(r2.status).toBe(500);
    expect(await r2.json()).toEqual({
      error: 'internal_error',
      message: GROUPING_ERROR_WORDS.internal,
    });
  });
});
