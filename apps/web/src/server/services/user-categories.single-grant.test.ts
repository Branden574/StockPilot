import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type QueryResult,
} from '@/test/supabase-mock';

/**
 * Security invariant: UserCategoriesService.setMemberCategoryGrant changes ONE
 * category grant of ONE member of the caller's organization.
 *
 *   - It asks members:assign_categories and the manager role before any read.
 *   - The member is named by the membership id and read in the caller's
 *     organization; a category to grant is read there too.
 *   - A grant is one inserted row and a revoke is one deleted row, keyed by
 *     the organization, the member's account and the category. The member's
 *     other grants are never read from the caller and never rewritten: the
 *     whole-set function (set_user_category_access) is not called.
 *   - A change writes one user.category_access.updated audit row, with the
 *     caller's context. A request that changes nothing writes none.
 */

const h = vi.hoisted(() => ({ audit: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock('./audit', () => ({ audit: (...a: unknown[]) => h.audit(...a) }));

import { UserCategoriesService } from './user-categories';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const CALLER = '22222222-2222-4222-8222-222222222222';
const TARGET_USER = '33333333-3333-4333-8333-333333333333';
const MEMBER = '44444444-4444-4444-8444-444444444444';
const OTHER_MEMBER = '44444444-4444-4444-8444-44444444444f';
const CAT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CAT_B = 'aaaaaaaa-0000-4000-8000-000000000002';
const FOREIGN_CAT = 'aaaaaaaa-0000-4000-8000-00000000000f';

interface World {
  /** The member's grants as the database holds them after the write. */
  grantsAfter?: string[];
  insert?: QueryResult;
  remove?: QueryResult;
  grantsRead?: QueryResult;
}

function world(w: World = {}) {
  return makeSupabaseStub({
    // Answered like PostgREST: the service's own filters decide what is found.
    'organization_members.select': servedLikePostgrest([
      { id: MEMBER, organization_id: ORG, user_id: TARGET_USER },
      { id: OTHER_MEMBER, organization_id: OTHER_ORG, user_id: TARGET_USER },
    ]),
    'categories.select': servedLikePostgrest([
      { id: CAT_A, organization_id: ORG },
      { id: CAT_B, organization_id: ORG },
      { id: FOREIGN_CAT, organization_id: OTHER_ORG },
    ]),
    'user_category_assignments.select':
      w.grantsRead ??
      servedLikePostgrest(
        (w.grantsAfter ?? []).map((category_id) => ({
          category_id,
          user_id: TARGET_USER,
          organization_id: ORG,
        })),
      ),
    'user_category_assignments.insert': w.insert ?? { data: null, error: null },
    'user_category_assignments.delete': w.remove ?? { data: [{ id: 'row-1' }], error: null },
  });
}

function service(
  stub: ReturnType<typeof makeSupabaseStub>,
  over: Parameters<typeof makeServiceContext>[1] = {},
) {
  const ctx = makeServiceContext(stub.client, {
    role: 'manager',
    organizationId: ORG,
    userId: CALLER,
    ...over,
  });
  return { ctx, svc: new UserCategoriesService(ctx as never) };
}

const inserts = (stub: ReturnType<typeof makeSupabaseStub>) =>
  stub.chainArgsAll.get('user_category_assignments.insert') ?? [];
const deletes = (stub: ReturnType<typeof makeSupabaseStub>) =>
  stub.chainArgsAll.get('user_category_assignments.delete') ?? [];

/** The `.eq(column, value)` filters of one recorded chain, as an object. */
function eqFilters(stub: ReturnType<typeof makeSupabaseStub>, key: string, index = 0) {
  const methods = stub.chainsAll.get(key)?.[index] ?? [];
  const args = stub.chainArgsAll.get(key)?.[index] ?? [];
  const out: Record<string, unknown> = {};
  methods.forEach((m, i) => {
    if (m === 'eq') out[args[i]![0] as string] = args[i]![1];
  });
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('UserCategoriesService.setMemberCategoryGrant', () => {
  it('a grant inserts one row for the organization, the account and the category, and nothing else', async () => {
    const stub = world({ grantsAfter: [CAT_A, CAT_B] });
    const { svc } = service(stub);

    const result = await svc.setMemberCategoryGrant(MEMBER, CAT_B, true);

    expect(result).toEqual({ changed: true, categoryIds: [CAT_A, CAT_B] });
    expect(inserts(stub)).toHaveLength(1);
    expect(inserts(stub)[0]![0]).toEqual([
      {
        organization_id: ORG,
        user_id: TARGET_USER,
        category_id: CAT_B,
        assigned_by: CALLER,
      },
    ]);
    expect(deletes(stub)).toHaveLength(0);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a revoke deletes the one row for the organization, the account and the category, and nothing else', async () => {
    const stub = world({ grantsAfter: [CAT_A] });
    const { svc } = service(stub);

    const result = await svc.setMemberCategoryGrant(MEMBER, CAT_B, false);

    expect(result).toEqual({ changed: true, categoryIds: [CAT_A] });
    expect(deletes(stub)).toHaveLength(1);
    expect(eqFilters(stub, 'user_category_assignments.delete')).toEqual({
      organization_id: ORG,
      user_id: TARGET_USER,
      category_id: CAT_B,
    });
    expect(inserts(stub)).toHaveLength(0);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a grant writes one audit row naming the one category, with the count after it', async () => {
    const stub = world({ grantsAfter: [CAT_A, CAT_B] });
    const { ctx, svc } = service(stub);

    await svc.setMemberCategoryGrant(MEMBER, CAT_B, true);

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(
      {
        event: 'user.category_access.updated',
        entityType: 'user_profile',
        entityId: TARGET_USER,
        extra: { category_count: 2, granted_ids: [CAT_B], revoked_ids: [] },
      },
      ctx,
    );
  });

  it('a revoke writes one audit row naming the one category, with the count after it', async () => {
    const stub = world({ grantsAfter: [] });
    const { ctx, svc } = service(stub);

    await svc.setMemberCategoryGrant(MEMBER, CAT_A, false);

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(
      {
        event: 'user.category_access.updated',
        entityType: 'user_profile',
        entityId: TARGET_USER,
        extra: { category_count: 0, granted_ids: [], revoked_ids: [CAT_A] },
      },
      ctx,
    );
  });

  it('a grant the member already has changes nothing and writes no audit row', async () => {
    const stub = world({
      grantsAfter: [CAT_A],
      insert: {
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      },
    });
    const { svc } = service(stub);

    const result = await svc.setMemberCategoryGrant(MEMBER, CAT_A, true);

    expect(result).toEqual({ changed: false, categoryIds: [CAT_A] });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('a revoke of a grant the member does not have changes nothing and writes no audit row', async () => {
    const stub = world({ grantsAfter: [CAT_A], remove: { data: [], error: null } });
    const { svc } = service(stub);

    const result = await svc.setMemberCategoryGrant(MEMBER, CAT_B, false);

    expect(result).toEqual({ changed: false, categoryIds: [CAT_A] });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('a grant refused as a duplicate that the member then does not hold is a conflict', async () => {
    const stub = world({
      grantsAfter: [],
      insert: {
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      },
    });
    const { svc } = service(stub);

    await expect(svc.setMemberCategoryGrant(MEMBER, CAT_A, true)).rejects.toMatchObject({
      code: 'conflict',
      message: 'That category access changed meanwhile. Reload and try again.',
    });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('reads the member in the caller’s organization: a membership of another organization is not found', async () => {
    const stub = world();
    const { svc } = service(stub);

    await expect(svc.setMemberCategoryGrant(OTHER_MEMBER, CAT_A, true)).rejects.toMatchObject({
      code: 'not_found',
      message: 'Member not found',
    });
    await expect(svc.setMemberCategoryGrant(OTHER_MEMBER, CAT_A, false)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(inserts(stub)).toHaveLength(0);
    expect(deletes(stub)).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('reads the category in the caller’s organization: another organization’s category is not found', async () => {
    const stub = world();
    const { svc } = service(stub);

    await expect(svc.setMemberCategoryGrant(MEMBER, FOREIGN_CAT, true)).rejects.toMatchObject({
      code: 'not_found',
      message: 'Category not found',
    });
    expect(inserts(stub)).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('refuses a caller without members:assign_categories before any read', async () => {
    const stub = world();
    const { svc } = service(stub, { role: 'staff' });

    await expect(svc.setMemberCategoryGrant(MEMBER, CAT_A, true)).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Missing permission: members:assign_categories',
    });
    expect(stub.fromCalls).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('refuses a caller below manager who was granted the permission, before any read', async () => {
    const stub = world();
    const { svc } = service(stub, {
      role: 'staff',
      permissions: new Set(['members:assign_categories']),
    });

    for (const granted of [true, false]) {
      await expect(svc.setMemberCategoryGrant(MEMBER, CAT_A, granted)).rejects.toMatchObject({
        code: 'forbidden',
        message: 'Manager role required to assign categories.',
      });
    }
    expect(stub.fromCalls).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('refuses while the authenticator code is owed, with the reason, before any read', async () => {
    const stub = world();
    const { svc } = service(stub, { mfaRequired: true, mfaSatisfied: false });

    await expect(svc.setMemberCategoryGrant(MEMBER, CAT_A, true)).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'mfa_required' },
    });
    expect(stub.fromCalls).toEqual([]);
  });

  it('an insert the database refuses for the role is forbidden, with no audit row', async () => {
    const stub = world({
      insert: {
        data: null,
        error: { code: '42501', message: 'new row violates row-level security policy' },
      },
    });
    const { svc } = service(stub);

    await expect(svc.setMemberCategoryGrant(MEMBER, CAT_A, true)).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Manager role required to assign categories.',
    });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('an insert whose member or category was removed meanwhile is not found, with no audit row', async () => {
    const stub = world({
      insert: {
        data: null,
        error: { code: '23503', message: 'violates foreign key constraint' },
      },
    });
    const { svc } = service(stub);

    await expect(svc.setMemberCategoryGrant(MEMBER, CAT_A, true)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each([
    [
      'grant',
      true,
      { insert: { data: null, error: { code: '57014', message: 'canceling statement' } } },
    ],
    [
      'revoke',
      false,
      { remove: { data: null, error: { code: '57014', message: 'canceling statement' } } },
    ],
  ] as const)(
    'a %s the database failed is an internal error, with no audit row',
    async (_l, granted, w) => {
      const stub = world(w);
      const { svc } = service(stub);

      await expect(svc.setMemberCategoryGrant(MEMBER, CAT_A, granted)).rejects.toMatchObject({
        code: 'internal_error',
      });
      expect(h.audit).not.toHaveBeenCalled();
    },
  );

  it('a saved change whose grants could not be read back is still audited, and answers no list', async () => {
    const stub = world({
      grantsRead: { data: null, error: { code: '57014', message: 'canceling statement' } },
    });
    const { svc } = service(stub);

    const result = await svc.setMemberCategoryGrant(MEMBER, CAT_A, true);

    expect(result).toEqual({ changed: true, categoryIds: null });
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect((h.audit.mock.calls[0]![0] as { extra: unknown }).extra).toEqual({
      category_count: null,
      granted_ids: [CAT_A],
      revoked_ids: [],
    });
  });
});
