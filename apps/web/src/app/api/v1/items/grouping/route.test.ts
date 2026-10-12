// POST /api/v1/items/grouping and POST /api/v1/items/grouping/preview: the
// phone's Group selected, Remove from group and Rename (apply_item_grouping and
// item_grouping_preview, migration 0400), over the same service as the web
// actions. Bearer or cookie; online only (the phone never queues them).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUPING_ERROR_WORDS, type ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError } from '@/server/services/context';
import { ItemGroupingService } from '@/server/services/item-grouping';

import { POST as PREVIEW } from './preview/route';
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
  vi.mocked(ItemGroupingService).mockImplementation(function () {
    return methods as unknown as InstanceType<typeof ItemGroupingService>;
  });
}

const OUTCOME = {
  action: 'group',
  outcome: 'applied',
  replay: false,
  created: true,
  group: { id: 'g', name: 'Polo', version: 1, itemType: 'product', closed: false },
  changes: [{ itemId: A, fromGroupId: null, toGroupId: 'g' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    resetAt: Date.now() + 60_000,
  });
});

describe('POST /api/v1/items/grouping', () => {
  it('401 with plain words when signed out, before the rate limit', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(req('/api/v1/items/grouping', {}));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'unauthenticated',
      message: GROUPING_ERROR_WORDS.unauthenticated,
    });
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('applies as the app surface in the shared grouping bucket and answers the outcome', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const applyGrouping = vi.fn().mockResolvedValue({ organizationId: ORG, outcome: OUTCOME });
    serviceAnswering({ applyGrouping });
    const res = await POST(req('/api/v1/items/grouping', { some: 'body' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ organizationId: ORG, result: OUTCOME });
    expect(checkRateLimit).toHaveBeenCalledWith(`item-grouping:${ME}`, 30, 60_000);
    expect(applyGrouping).toHaveBeenCalledWith({ some: 'body' }, 'app');
  });

  it('429 with retry-after when rate limited, without calling the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 31,
      resetAt: Date.now() + 5000,
    });
    const applyGrouping = vi.fn();
    serviceAnswering({ applyGrouping });
    const res = await POST(req('/api/v1/items/grouping', {}));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(applyGrouping).not.toHaveBeenCalled();
  });

  it('maps refusals by reason: 409 conflicts, 404 a group gone, 403 rename, 503 busy (retryable), 400 the body', async () => {
    const cases: Array<[ServiceError, number]> = [
      [
        new ServiceError('conflict', GROUPING_ERROR_WORDS.membershipConflict, {
          reason: 'membership_conflict',
          itemIds: [A],
        }),
        409,
      ],
      [
        new ServiceError('not_found', GROUPING_ERROR_WORDS.groupNotFound, {
          reason: 'group_not_found',
        }),
        404,
      ],
      [
        new ServiceError('forbidden', GROUPING_ERROR_WORDS.renameNotPermitted, {
          reason: 'rename_not_permitted',
        }),
        403,
      ],
      [
        new ServiceError('conflict', GROUPING_ERROR_WORDS.busy, {
          reason: 'busy',
          retryable: true,
        }),
        503,
      ],
      [
        new ServiceError('validation_error', GROUPING_ERROR_WORDS.invalid, {
          reason: 'invalid',
          field: 'item_ids',
        }),
        400,
      ],
      [
        new ServiceError('forbidden', 'Re-authenticate with MFA before performing this action.', {
          reason: 'aal2_required',
        }),
        403,
      ],
    ];
    for (const [e, status] of cases) {
      vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
      serviceAnswering({ applyGrouping: vi.fn().mockRejectedValue(e) });
      const res = await POST(req('/api/v1/items/grouping', {}));
      expect(res.status).toBe(status);
      const json = await res.json();
      expect(json.message).toBe(e.message);
      expect(json.details).toEqual(e.details);
    }
  });

  it('500 with the generic sentence for anything else (no internals)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    serviceAnswering({
      applyGrouping: vi.fn().mockRejectedValue(new Error('pg: relation exploded at 10.0.0.1')),
    });
    const res = await POST(req('/api/v1/items/grouping', {}));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'internal_error',
      message: GROUPING_ERROR_WORDS.internal,
    });
  });
});

describe('POST /api/v1/items/grouping/preview', () => {
  it('answers the review for the ids and the target, in the preview bucket', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const previewGroup = vi.fn().mockResolvedValue({ records: [], previewKey: 'k' });
    serviceAnswering({ previewGroup });
    const res = await PREVIEW(
      req('/api/v1/items/grouping/preview', { itemIds: [A], groupId: 'g' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      organizationId: ORG,
      actorUserId: ME,
      review: { records: [], previewKey: 'k' },
    });
    expect(previewGroup).toHaveBeenCalledWith([A], 'g');
    expect(checkRateLimit).toHaveBeenCalledWith(`item-grouping-preview:${ME}`, 60, 60_000);
  });

  it('400 for a body without an id list, before the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const previewGroup = vi.fn();
    serviceAnswering({ previewGroup });
    for (const body of [
      {},
      { itemIds: 'a' },
      { itemIds: [1] },
      { itemIds: [A], groupId: 7 },
      'not json',
    ]) {
      vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
      const res = await PREVIEW(req('/api/v1/items/grouping/preview', body));
      expect(res.status).toBe(400);
    }
    expect(previewGroup).not.toHaveBeenCalled();
  });

  it('401 when signed out', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    expect((await PREVIEW(req('/api/v1/items/grouping/preview', { itemIds: [A] }))).status).toBe(
      401,
    );
  });
});
