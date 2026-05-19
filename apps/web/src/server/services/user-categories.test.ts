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
  /** simulate an insert failure */
  insertError?: { code: string; message: string };
}) {
  const inserted: Array<Record<string, unknown>> = [];
  let deleteCalled = false;
  const supabase = {
    from(table: string) {
      if (table === 'user_category_assignments') {
        return {
          select: () => ({
            eq: () => ({
              then: (cb: (v: { data: Array<{ category_id: string }>; error: null }) => void) =>
                cb({
                  data: (opts.existingAssignments ?? []).map((c) => ({ category_id: c })),
                  error: null,
                }),
            }),
          }),
          insert: (rows: Array<Record<string, unknown>>) => {
            if (opts.insertError) {
              return Promise.resolve({ data: null, error: opts.insertError });
            }
            inserted.push(...rows);
            return Promise.resolve({ data: rows, error: null });
          },
          delete: () => ({
            eq: () => {
              deleteCalled = true;
              return Promise.resolve({ error: null });
            },
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
    inserted,
    wasDeleted: () => deleteCalled,
  };
}

describe('UserCategoriesService.setUserCategoryAccess', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts assignment rows for granted categories', async () => {
    const { ctx, inserted } = makeCtx({
      targetUserOrgId: 'org-1',
      existingAssignments: [],
    });
    const svc = new UserCategoriesService(ctx);
    await svc.setUserCategoryAccess('user-2', ['cat-a', 'cat-b']);
    expect(inserted).toHaveLength(2);
    expect(inserted.map((r) => r.category_id).sort()).toEqual(['cat-a', 'cat-b']);
    expect(inserted.every((r) => r.user_id === 'user-2')).toBe(true);
    expect(inserted.every((r) => r.organization_id === 'org-1')).toBe(true);
  });

  it('rejects when target user is not in the calling user’s organization', async () => {
    const { ctx } = makeCtx({ targetUserOrgId: undefined });
    const svc = new UserCategoriesService(ctx);
    await expect(
      svc.setUserCategoryAccess('user-2', ['cat-a']),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('clears all assignments when called with empty array', async () => {
    const { ctx, inserted, wasDeleted } = makeCtx({
      targetUserOrgId: 'org-1',
      existingAssignments: ['cat-a', 'cat-b'],
    });
    const svc = new UserCategoriesService(ctx);
    await svc.setUserCategoryAccess('user-2', []);
    expect(inserted).toHaveLength(0);
    expect(wasDeleted()).toBe(true);
  });

  it('atomic-replace: deletes existing AND inserts new in same call', async () => {
    const { ctx, inserted, wasDeleted } = makeCtx({
      targetUserOrgId: 'org-1',
      existingAssignments: ['cat-old'],
    });
    const svc = new UserCategoriesService(ctx);
    await svc.setUserCategoryAccess('user-2', ['cat-new']);
    expect(wasDeleted()).toBe(true);
    expect(inserted).toHaveLength(1);
    expect((inserted[0] as { category_id: string }).category_id).toBe('cat-new');
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
