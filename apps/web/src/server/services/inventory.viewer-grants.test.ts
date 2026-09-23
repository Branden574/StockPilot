import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A viewer's category grants (the list's defensive category filter, on top of
 * RLS) are read ALONGSIDE the warehouse access, in one read, instead of two
 * reads in series after it (the membership row again, then the grants).
 */

const h = vi.hoisted(() => ({
  accessGate: null as null | Promise<void>,
}));

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => {
    if (h.accessGate) await h.accessGate;
    return { hasAllAccess: false, readableIds: ['wh-1'], writableIds: [], primaryWarehouseId: 'wh-1' };
  }),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));

import { InventoryService } from './inventory';
import { UserCategoriesService } from './user-categories';

type Answer = { data: unknown; error: unknown; count?: number };

function makeClient(answers: Record<string, Answer>) {
  const started: string[] = [];
  const filters: Array<[string, string, unknown]> = [];
  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === 'then') {
              return (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
                started.push(table);
                return Promise.resolve(answers[table] ?? { data: [], error: null, count: 0 }).then(
                  onFulfilled,
                  onRejected,
                );
              };
            }
            if (prop === 'in') {
              return (col: string, vals: unknown) => {
                filters.push([table, col, vals]);
                return builder;
              };
            }
            return () => builder;
          },
        },
      );
      return builder;
    },
  };
  return { client, started, filters };
}

function viewerSvc(client: unknown) {
  return new InventoryService({
    supabase: client,
    organizationId: 'org-1',
    userId: 'viewer-1',
    email: 'v@example.com',
    role: 'viewer',
    permissions: new Set(['items:read']),
  } as never);
}

beforeEach(() => {
  h.accessGate = null;
});

describe('UserCategoriesService.getGrantedCategoryIdsForViewer', () => {
  it('returns the grants, or null (unrestricted) when there are none', async () => {
    const withGrants = makeClient({
      user_category_assignments: { data: [{ category_id: 'c1' }, { category_id: 'c2' }], error: null },
    });
    await expect(
      new UserCategoriesService({ supabase: withGrants.client, organizationId: 'org-1' } as never)
        .getGrantedCategoryIdsForViewer('viewer-1'),
    ).resolves.toEqual(new Set(['c1', 'c2']));
    const none = makeClient({ user_category_assignments: { data: [], error: null } });
    await expect(
      new UserCategoriesService({ supabase: none.client, organizationId: 'org-1' } as never)
        .getGrantedCategoryIdsForViewer('viewer-1'),
    ).resolves.toBeNull();
  });

  it('a failed read throws: never "no grants", which would mean unrestricted', async () => {
    const failed = makeClient({
      user_category_assignments: { data: null, error: { message: 'timeout' } },
    });
    await expect(
      new UserCategoriesService({ supabase: failed.client, organizationId: 'org-1' } as never)
        .getGrantedCategoryIdsForViewer('viewer-1'),
    ).rejects.toThrow('timeout');
  });
});

describe('InventoryService.list for a viewer', () => {
  it('reads the grants while the warehouse access is still open, with no membership re-read', async () => {
    let openAccess!: () => void;
    h.accessGate = new Promise<void>((resolve) => {
      openAccess = resolve;
    });
    const { client, started, filters } = makeClient({
      user_category_assignments: { data: [{ category_id: 'c1' }], error: null },
    });
    const listing = viewerSvc(client).list({});
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toContain('user_category_assignments');
    expect(started).not.toContain('inventory_items');

    openAccess();
    await listing;
    expect(started).not.toContain('organization_members');
    expect(filters).toContainEqual(['inventory_items', 'category_id', ['c1']]);
  });

  it('a failed grants read leaves visibility to RLS (no filter), as before', async () => {
    const { client, filters } = makeClient({
      user_category_assignments: { data: null, error: { message: 'timeout' } },
    });
    await viewerSvc(client).list({});
    expect(filters.some(([, col]) => col === 'category_id')).toBe(false);
  });

  it('other roles make no grants read at all', async () => {
    const { client, started } = makeClient({});
    const svc = new InventoryService({
      supabase: client,
      organizationId: 'org-1',
      userId: 'staff-1',
      email: 's@example.com',
      role: 'staff',
      permissions: new Set(['items:read']),
    } as never);
    await svc.list({});
    expect(started).not.toContain('user_category_assignments');
  });
});
