import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
  assertPermission: vi.fn(),
}));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
}));

import { UserCategoriesService } from './user-categories';

function makeCtx(opts: {
  /** organization_id returned by the organization_members.maybeSingle() */
  targetUserOrgId?: string;
  /** role returned by organization_members for the target user */
  targetUserRole?: string;
  /** category_ids currently in user_category_assignments for the target user */
  existingAssignments?: string[];
  /** simulate an RPC failure */
  rpcError?: { code: string; message: string };
}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const supabase = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (opts.rpcError) return { data: null, error: opts.rpcError };
      return { data: null, error: null };
    }),
    from(table: string) {
      if (table === 'user_category_assignments') {
        // The service now reads assignments with two .eq() filters
        // (user_id + organization_id). Mock that chain shape.
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                then: (
                  cb: (v: { data: Array<{ category_id: string }>; error: null }) => void,
                ) =>
                  cb({
                    data: (opts.existingAssignments ?? []).map((c) => ({ category_id: c })),
                    error: null,
                  }),
              }),
            }),
          }),
        };
      }
      if (table === 'organization_members') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: opts.targetUserOrgId
                    ? {
                        organization_id: opts.targetUserOrgId,
                        role: opts.targetUserRole ?? 'viewer',
                      }
                    : null,
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown;
  return {
    ctx: {
      supabase,
      organizationId: 'org-1',
      userId: 'caller-1',
      role: 'admin',
    } as unknown as ConstructorParameters<typeof UserCategoriesService>[0],
    rpcCalls,
  };
}

describe('UserCategoriesService.setUserCategoryAccess', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls set_user_category_access RPC with granted categories', async () => {
    const { ctx, rpcCalls } = makeCtx({
      targetUserOrgId: 'org-1',
      existingAssignments: [],
    });
    const svc = new UserCategoriesService(ctx);
    await svc.setUserCategoryAccess('user-2', ['cat-a', 'cat-b']);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.name).toBe('set_user_category_access');
    expect(rpcCalls[0]!.args.p_user_id).toBe('user-2');
    expect(rpcCalls[0]!.args.p_org_id).toBe('org-1');
    expect((rpcCalls[0]!.args.p_category_ids as string[]).sort()).toEqual([
      'cat-a',
      'cat-b',
    ]);
  });

  it('rejects when target user is not in the calling user’s organization', async () => {
    const { ctx, rpcCalls } = makeCtx({ targetUserOrgId: undefined });
    const svc = new UserCategoriesService(ctx);
    await expect(
      svc.setUserCategoryAccess('user-2', ['cat-a']),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(rpcCalls).toHaveLength(0); // never reached the RPC
  });

  it('passes empty array to RPC when called with empty grants (clears)', async () => {
    const { ctx, rpcCalls } = makeCtx({
      targetUserOrgId: 'org-1',
      existingAssignments: ['cat-a', 'cat-b'],
    });
    const svc = new UserCategoriesService(ctx);
    await svc.setUserCategoryAccess('user-2', []);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.args.p_category_ids).toEqual([]);
  });

  it('no-op short-circuits when new set equals existing set', async () => {
    const { ctx, rpcCalls } = makeCtx({
      targetUserOrgId: 'org-1',
      existingAssignments: ['cat-a', 'cat-b'],
    });
    const svc = new UserCategoriesService(ctx);
    await svc.setUserCategoryAccess('user-2', ['cat-b', 'cat-a']); // same set, different order
    expect(rpcCalls).toHaveLength(0);
  });

  it('maps RPC P0002 to ServiceError(not_found)', async () => {
    const { ctx } = makeCtx({
      targetUserOrgId: 'org-1',
      rpcError: { code: 'P0002', message: 'not_found' },
    });
    const svc = new UserCategoriesService(ctx);
    await expect(
      svc.setUserCategoryAccess('user-2', ['cat-a']),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('maps RPC 42501 to ServiceError(forbidden)', async () => {
    const { ctx } = makeCtx({
      targetUserOrgId: 'org-1',
      rpcError: { code: '42501', message: 'forbidden' },
    });
    const svc = new UserCategoriesService(ctx);
    await expect(
      svc.setUserCategoryAccess('user-2', ['cat-a']),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('UserCategoriesService.getAccessibleCategoryIds', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null for manager (unrestricted)', async () => {
    const { ctx } = makeCtx({ targetUserOrgId: 'org-1', targetUserRole: 'manager' });
    const svc = new UserCategoriesService(ctx);
    const result = await svc.getAccessibleCategoryIds('user-2');
    expect(result).toBeNull();
  });

  it('returns null for viewer with no assignments (unrestricted default)', async () => {
    const { ctx } = makeCtx({
      targetUserOrgId: 'org-1',
      targetUserRole: 'viewer',
      existingAssignments: [],
    });
    const svc = new UserCategoriesService(ctx);
    const result = await svc.getAccessibleCategoryIds('user-2');
    expect(result).toBeNull();
  });

  it('returns the set for viewer with assignments', async () => {
    const { ctx } = makeCtx({
      targetUserOrgId: 'org-1',
      targetUserRole: 'viewer',
      existingAssignments: ['cat-a', 'cat-b'],
    });
    const svc = new UserCategoriesService(ctx);
    const result = await svc.getAccessibleCategoryIds('user-2');
    expect(result).toBeInstanceOf(Set);
    expect([...(result as Set<string>)].sort()).toEqual(['cat-a', 'cat-b']);
  });
});
