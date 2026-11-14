import { revalidatePath, revalidateTag } from 'next/cache';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError } from '@/server/services/context';
import { UserCategoriesService } from '@/server/services/user-categories';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/server/services/user-categories', () => ({ UserCategoriesService: vi.fn() }));

/**
 * Security invariant: POST /api/v1/members/[id]/category-access grants or
 * revokes ONE category for ONE member, through
 * UserCategoriesService.setMemberCategoryGrant and nothing else.
 *
 * The body names one category and whether it is granted. It never carries a
 * list: the member's other grants are not read from the request and are not
 * rewritten. The route builds its context with withApiContext (cookie or
 * Bearer), so the service runs as the caller, in the caller's organization.
 */

const MEMBER = '5a1b2c3d-0000-4000-8000-00000000000a';
const CATEGORY = '7c1e2a90-0000-4000-8000-00000000000b';
const OTHER_CATEGORY = '7c1e2a90-0000-4000-8000-00000000000c';

function ctx() {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager' as const,
    supabase: makeSupabaseStub({}).client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<never>(),
  };
}

function request(opts: { id?: string; body?: unknown; raw?: string } = {}) {
  const id = opts.id ?? MEMBER;
  return {
    req: new Request(`https://test.local/api/v1/members/${id}/category-access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: opts.raw ?? JSON.stringify(opts.body ?? { categoryId: CATEGORY, granted: true }),
    }) as unknown as Parameters<typeof POST>[0],
    params: { params: Promise.resolve({ id }) },
  };
}

function mockService(
  impl: () => Promise<unknown> = async () => ({ changed: true, categoryIds: [CATEGORY] }),
) {
  const setMemberCategoryGrant = vi.fn(impl);
  vi.mocked(UserCategoriesService).mockImplementation(function () {
    return { setMemberCategoryGrant } as unknown as InstanceType<typeof UserCategoriesService>;
  });
  return setMemberCategoryGrant;
}

describe('POST /api/v1/members/[id]/category-access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withApiContext).mockResolvedValue(ctx());
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  it('answers 401 without a context, and makes no service', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);
    const call = mockService();
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(UserCategoriesService).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it('hands withApiContext the request it was given', async () => {
    mockService();
    const { req, params } = request();
    await POST(req, params);
    expect(withApiContext).toHaveBeenCalledWith(req);
  });

  it('answers 400 for a member id that is not a uuid, before the service', async () => {
    const call = mockService();
    const { req, params } = request({ id: 'not-a-member-id' });
    const res = await POST(req, params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'validation_error',
      message: 'That member id is not valid.',
    });
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    ['a body that is not JSON', { raw: '{not json' }],
    ['no category', { body: { granted: true } }],
    ['a category id that is not a uuid', { body: { categoryId: 'shoes', granted: true } }],
    ['no granted flag', { body: { categoryId: CATEGORY } }],
    [
      'a granted flag that is not true or false',
      { body: { categoryId: CATEGORY, granted: 'yes' } },
    ],
    ['a list of categories in place of one', { body: { categoryIds: [CATEGORY, OTHER_CATEGORY] } }],
    [
      'a list of categories beside the one',
      { body: { categoryId: CATEGORY, granted: true, categoryIds: [OTHER_CATEGORY] } },
    ],
  ])('answers 400 for %s, before the service', async (_label, opts) => {
    const call = mockService();
    const { req, params } = request(opts);
    const res = await POST(req, params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
    expect(call).not.toHaveBeenCalled();
  });

  it('a grant calls the service once, with the route context, the member id, the category and true', async () => {
    const context = ctx();
    vi.mocked(withApiContext).mockResolvedValue(context);
    const call = mockService(async () => ({ changed: true, categoryIds: [CATEGORY] }));
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      changed: true,
      granted: true,
      categoryIds: [CATEGORY],
    });
    expect(UserCategoriesService).toHaveBeenCalledTimes(1);
    expect(vi.mocked(UserCategoriesService).mock.calls[0]![0]).toBe(context);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(MEMBER, CATEGORY, true);
    expect(checkRateLimit).toHaveBeenCalledWith('member-category-access:u-1', 120, 60_000);
  });

  it('a revoke calls the service once with false, and answers the grants that remain', async () => {
    const call = mockService(async () => ({ changed: true, categoryIds: [OTHER_CATEGORY] }));
    const { req, params } = request({ body: { categoryId: CATEGORY, granted: false } });
    const res = await POST(req, params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      changed: true,
      granted: false,
      categoryIds: [OTHER_CATEGORY],
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(MEMBER, CATEGORY, false);
  });

  it('accepts upper-case ids and hands the service the lower-case ones', async () => {
    const call = mockService();
    const { req, params } = request({
      id: MEMBER.toUpperCase(),
      body: { categoryId: CATEGORY.toUpperCase(), granted: true },
    });
    const res = await POST(req, params);
    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledWith(MEMBER, CATEGORY, true);
  });

  it('a change refreshes the pages and the order catalog that follow category access', async () => {
    mockService(async () => ({ changed: true, categoryIds: [CATEGORY] }));
    const { req, params } = request();
    await POST(req, params);
    expect(revalidateTag).toHaveBeenCalledWith('orders-new-v2-catalog', 'max');
    expect(
      vi
        .mocked(revalidatePath)
        .mock.calls.map((c) => c[0])
        .sort(),
    ).toEqual(['/dashboard/books', '/dashboard/inventory', '/dashboard/team']);
  });

  it('a request that changed nothing answers 200 with changed false and refreshes nothing', async () => {
    mockService(async () => ({ changed: false, categoryIds: [CATEGORY] }));
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      changed: false,
      granted: true,
      categoryIds: [CATEGORY],
    });
    expect(revalidateTag).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('a refresh that fails is reported, and the saved change still answers 200', async () => {
    const failed = new Error('the cache did not answer');
    vi.mocked(revalidateTag).mockImplementationOnce(() => {
      throw failed;
    });
    mockService(async () => ({ changed: true, categoryIds: [CATEGORY] }));
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(200);
    expect(reportError).toHaveBeenCalledWith(failed, {
      tag: 'api.v1.members.category_access.revalidate',
      organizationId: 'org-1',
    });
  });

  it.each([
    ['forbidden', 403, 'Missing permission: members:assign_categories'],
    ['not_found', 404, 'Member not found'],
    ['conflict', 409, 'That category access changed meanwhile. Reload and try again.'],
  ] as const)('a %s from the service is %i with its words', async (code, status, message) => {
    mockService(async () => {
      throw new ServiceError(code, message);
    });
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code, message });
    expect(reportError).not.toHaveBeenCalled();
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('the authenticator refusal keeps its reason for the caller to act on', async () => {
    mockService(async () => {
      throw new ServiceError(
        'forbidden',
        'Re-authenticate with MFA before performing this action.',
        {
          reason: 'aal2_required',
        },
      );
    });
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: 'Re-authenticate with MFA before performing this action.',
      details: { reason: 'aal2_required' },
    });
  });

  it("a write the database refused answers the service's fixed sentence, never the database's text, and is reported", async () => {
    const refused = new ServiceError(
      'internal_error',
      'insert or update on table "user_category_assignments" violates foreign key constraint',
    );
    mockService(async () => {
      throw refused;
    });
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: 'internal_error',
      message: 'An internal error occurred. Please try again.',
    });
    expect(text).not.toContain('user_category_assignments');
    expect(reportError).toHaveBeenCalledWith(refused, {
      tag: 'api.v1.members.category_access',
      organizationId: 'org-1',
    });
  });

  it('an unexpected error answers the fixed sentence, never its own text, and is reported', async () => {
    const err = new Error('relation "user_category_assignments" does not exist');
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
      tag: 'api.v1.members.category_access',
      organizationId: 'org-1',
    });
  });

  it('answers 429 with Retry-After when the account is over its limit, before the service', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      count: 121,
      resetAt: Date.now() + 30_000,
    });
    const call = mockService();
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await res.json()).error).toBe('rate_limited');
    expect(call).not.toHaveBeenCalled();
  });
});
