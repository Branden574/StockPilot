import { beforeEach, describe, expect, it, vi } from 'vitest';

import { callArgs, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

/**
 * B23: a saved view whose owner deleted their account.
 *
 * Today saved_views.user_id cascades from user_profiles, so a deletion takes
 * every view the person saved, shared ones included, from the whole team. The
 * database half (in the PR body, for the next database batch) keeps a SHARED
 * view with no owner (user_id null) and deletes the private ones. This app
 * half is safe before that change ships, because nothing is null until then:
 *   - list() carries a null owner as null, and says who may delete each view
 *     (`canRemove`): its owner, or an organization admin or owner for a shared
 *     view whose owner deleted their account (nobody else could ever remove
 *     it);
 *   - remove() and setSharing() prove a row changed (recurring pattern 2): a
 *     delete or update that RLS filtered to 0 rows used to report success, so
 *     the chip said "deleted" while the view stayed.
 */

vi.mock('@/server/services/context', () => ({
  withContext: vi.fn(),
  ServiceError: class ServiceError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => {
    throw new Error('requireOrgContext must not be reached');
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    throw new Error('the cookie client must not be used when a ctx client is supplied');
  }),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getWarehousesForRequest: vi.fn(async () => []),
  readWarehousesForRequest: vi.fn(async () => []),
}));

import type { ServiceContext } from './context';

import { SavedViewsService } from './saved-views';

const ME = 'u-me';
const OTHER = 'u-other';
const ORG = 'org-1';

function view(id: string, userId: string | null, isShared: boolean) {
  return {
    id,
    name: id,
    scope: 'inventory',
    state: {},
    sort_order: 0,
    created_at: '2026-09-01T00:00:00Z',
    is_shared: isShared,
    user_id: userId,
  };
}

const ROWS = [
  view('v-own', ME, false),
  view('v-own-shared', ME, true),
  view('v-teammate-shared', OTHER, true),
  view('v-orphan-shared', null, true),
];

function svcFor(role: string, results: Parameters<typeof makeSupabaseStub>[0]) {
  const stub = makeSupabaseStub({
    'warehouses.select': { data: [], error: null },
    'user_warehouse_assignments.select': { data: [], error: null },
    'organization_members.select': { data: [{ all_warehouses: true }], error: null },
    ...results,
  });
  const ctx = {
    organizationId: ORG,
    userId: ME,
    role,
    supabase: stub.client,
  } as unknown as ServiceContext;
  return { svc: new SavedViewsService(ctx), stub };
}

function eqs(call: MockCall): Array<[unknown, unknown]> {
  return call.methods
    .map((m, i) => [m, call.args[i]] as const)
    .filter(([m]) => m === 'eq')
    .map(([, a]) => [a?.[0], a?.[1]]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SavedViewsService.list: a shared view whose owner deleted their account', () => {
  it.each(['owner', 'admin', 'manager', 'staff', 'viewer'])(
    '%s: the orphaned shared view is kept, with no owner',
    async (role) => {
      const { svc } = svcFor(role, { 'saved_views.select': { data: ROWS, error: null } });
      const views = await svc.list('inventory');
      expect(views.map((v) => v.id)).toEqual(ROWS.map((r) => r.id));
      const orphan = views.find((v) => v.id === 'v-orphan-shared');
      expect(orphan?.ownerId).toBeNull();
      expect(orphan?.isShared).toBe(true);
    },
  );

  it('only an admin or owner may remove the orphaned view; the owner always their own; nobody a teammate’s', async () => {
    const canRemove: Record<string, Record<string, boolean>> = {};
    for (const role of ['owner', 'admin', 'manager', 'staff', 'viewer']) {
      const { svc } = svcFor(role, { 'saved_views.select': { data: ROWS, error: null } });
      const views = await svc.list('inventory');
      canRemove[role] = Object.fromEntries(views.map((v) => [v.id, v.canRemove]));
    }
    expect(canRemove).toEqual({
      owner: {
        'v-own': true,
        'v-own-shared': true,
        'v-teammate-shared': false,
        'v-orphan-shared': true,
      },
      admin: {
        'v-own': true,
        'v-own-shared': true,
        'v-teammate-shared': false,
        'v-orphan-shared': true,
      },
      manager: {
        'v-own': true,
        'v-own-shared': true,
        'v-teammate-shared': false,
        'v-orphan-shared': false,
      },
      staff: {
        'v-own': true,
        'v-own-shared': true,
        'v-teammate-shared': false,
        'v-orphan-shared': false,
      },
      viewer: {
        'v-own': true,
        'v-own-shared': true,
        'v-teammate-shared': false,
        'v-orphan-shared': false,
      },
    });
  });
});

describe('SavedViewsService.remove: proves the view was deleted', () => {
  it('deletes the caller’s own view in this organization and returns when a row went', async () => {
    const calls: MockCall[] = [];
    const { svc } = svcFor('staff', {
      'saved_views.delete': (call) => {
        calls.push(call);
        return { data: [{ id: 'v-own' }], error: null };
      },
    });
    await expect(svc.remove('v-own')).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(eqs(calls[0]!)).toEqual(
      expect.arrayContaining([
        ['id', 'v-own'],
        ['user_id', ME],
        ['organization_id', ORG],
      ]),
    );
    expect(callArgs(calls[0]!, 'select')?.[0]).toBe('id');
  });

  it('a delete that removed nothing is not a success for a member (mutation: drop the row proof)', async () => {
    const calls: MockCall[] = [];
    const { svc } = svcFor('manager', {
      'saved_views.delete': (call) => {
        calls.push(call);
        return { data: [], error: null };
      },
    });
    await expect(svc.remove('v-teammate-shared')).rejects.toMatchObject({ code: 'not_found' });
    // A manager is never offered the orphan path.
    expect(calls).toHaveLength(1);
  });

  it('an admin removes a shared view whose owner deleted their account, in this organization only', async () => {
    const calls: MockCall[] = [];
    const { svc } = svcFor('admin', {
      'saved_views.delete': (call) => {
        calls.push(call);
        // Not theirs; the orphan delete finds it.
        return calls.length === 1
          ? { data: [], error: null }
          : { data: [{ id: 'v-orphan-shared' }], error: null };
      },
    });
    await expect(svc.remove('v-orphan-shared')).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    const orphan = calls[1]!;
    expect(eqs(orphan)).toEqual(
      expect.arrayContaining([
        ['id', 'v-orphan-shared'],
        ['organization_id', ORG],
        ['is_shared', true],
      ]),
    );
    expect(callArgs(orphan, 'is')).toEqual(['user_id', null]);
    expect(eqs(orphan).some(([c]) => c === 'user_id')).toBe(false);
    expect(callArgs(orphan, 'select')?.[0]).toBe('id');
  });

  it('an admin still cannot remove a teammate’s view: both deletes removed nothing', async () => {
    const { svc } = svcFor('admin', {
      'saved_views.delete': { data: [], error: null },
    });
    await expect(svc.remove('v-teammate-shared')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a failed delete is an internal error', async () => {
    const { svc } = svcFor('staff', {
      'saved_views.delete': { data: null, error: { message: 'boom' } },
    });
    await expect(svc.remove('v-own')).rejects.toMatchObject({ code: 'internal_error' });
  });
});

describe('SavedViewsService.setSharing: proves the view changed', () => {
  it('updates the caller’s own view and returns when a row changed', async () => {
    const calls: MockCall[] = [];
    const { svc } = svcFor('staff', {
      'saved_views.update': (call) => {
        calls.push(call);
        return { data: [{ id: 'v-own' }], error: null };
      },
    });
    await expect(svc.setSharing('v-own', true)).resolves.toBeUndefined();
    expect(eqs(calls[0]!)).toEqual(
      expect.arrayContaining([
        ['id', 'v-own'],
        ['user_id', ME],
        ['organization_id', ORG],
      ]),
    );
    expect(callArgs(calls[0]!, 'select')?.[0]).toBe('id');
  });

  it('an update that changed nothing is not a success (mutation: drop the row proof)', async () => {
    const { svc } = svcFor('admin', {
      'saved_views.update': { data: [], error: null },
    });
    await expect(svc.setSharing('v-teammate-shared', false)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
