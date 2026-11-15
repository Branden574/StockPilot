import { describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

/**
 * A saved view shared with the organization is shown to every member, so
 * sharing one (saving it shared, or turning sharing on or off), deleting one's
 * own shared view, and an admin's delete of a shared view whose owner deleted
 * their account give the
 * authenticator answer first: under a policy that requires an authenticator, a
 * session that has not satisfied it is refused with mfa_required and nothing is
 * written. A person's own private view stays theirs to save and delete.
 */

vi.mock('@/lib/dashboard/request-cache', () => ({
  getWarehousesForRequest: vi.fn(async () => []),
  readWarehousesForRequest: vi.fn(async () => []),
}));

import type { ServiceContext } from './context';

import { SavedViewsService } from './saved-views';

const VIEW_ROW = {
  id: 'v-1',
  name: 'Low stock',
  scope: 'inventory',
  state: {},
  sort_order: 0,
  created_at: '2026-09-01T00:00:00Z',
  is_shared: false,
  user_id: 'user-test',
};

const UNSATISFIED = { mfaRequired: true, mfaSatisfied: false } as const;
const SATISFIED = { mfaRequired: true, mfaSatisfied: true } as const;

function svcFor(
  session: { mfaRequired: boolean; mfaSatisfied: boolean },
  role: 'admin' | 'staff' = 'admin',
  deletes: Array<{ id: string }[]> = [[{ id: 'v-1' }]],
) {
  const inserts: MockCall[] = [];
  const updates: MockCall[] = [];
  const deleteCalls: MockCall[] = [];
  const stub = makeSupabaseStub({
    'saved_views.insert': (call) => {
      inserts.push(call);
      const row = call.args[0]?.[0] as { is_shared?: boolean } | undefined;
      return { data: { ...VIEW_ROW, is_shared: row?.is_shared }, error: null };
    },
    'saved_views.update': (call) => {
      updates.push(call);
      return { data: [{ id: 'v-1' }], error: null };
    },
    'saved_views.delete': (call) => {
      deleteCalls.push(call);
      return { data: deletes[deleteCalls.length - 1] ?? [], error: null };
    },
  });
  const ctx = makeServiceContext(stub.client, { role, ...session }) as unknown as ServiceContext;
  return { svc: new SavedViewsService(ctx), stub, inserts, updates, deleteCalls };
}

const INPUT = { scope: 'inventory' as const, name: 'Low stock', state: {} };

describe('SavedViewsService: changes every member sees give the authenticator answer first', () => {
  it('saving a shared view, session not satisfied: refused with mfa_required, nothing written', async () => {
    const { svc, stub } = svcFor(UNSATISFIED);
    await expect(svc.create({ ...INPUT, isShared: true })).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'mfa_required' },
    });
    await expect(svc.createShared(INPUT)).rejects.toMatchObject({
      details: { reason: 'mfa_required' },
    });
    expect(stub.fromCalls).toEqual([]);
  });

  it('saving a shared view, session satisfied: saved shared', async () => {
    const { svc, inserts } = svcFor(SATISFIED);
    const view = await svc.create({ ...INPUT, isShared: true });
    expect(view.isShared).toBe(true);
    expect(inserts).toHaveLength(1);
  });

  it('saving a private view, session not satisfied: saved, not shared', async () => {
    const { svc, inserts } = svcFor(UNSATISFIED, 'staff');
    const view = await svc.create(INPUT);
    expect(view.isShared).toBe(false);
    expect(inserts).toHaveLength(1);
  });

  it.each([true, false])(
    'turning sharing %s, session not satisfied: refused with mfa_required, nothing written',
    async (isShared) => {
      const { svc, stub } = svcFor(UNSATISFIED, 'staff');
      await expect(svc.setSharing('v-1', isShared)).rejects.toMatchObject({
        code: 'forbidden',
        details: { reason: 'mfa_required' },
      });
      expect(stub.fromCalls).toEqual([]);
    },
  );

  it('turning sharing on, session satisfied: the row changes', async () => {
    const { svc, updates } = svcFor(SATISFIED, 'staff');
    await expect(svc.setSharing('v-1', true)).resolves.toBeUndefined();
    expect(updates).toHaveLength(1);
  });

  it('an admin deletes an ownerless shared view, session not satisfied: refused after the own private view try, no second delete', async () => {
    const { svc, deleteCalls } = svcFor(UNSATISFIED, 'admin', [[]]);
    await expect(svc.remove('v-orphan')).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'mfa_required' },
    });
    // Only the delete scoped to the caller's own private views ran, and it matched nothing.
    expect(deleteCalls).toHaveLength(1);
    await expect(svc.removeOwnerless('v-orphan')).rejects.toMatchObject({
      details: { reason: 'mfa_required' },
    });
    expect(deleteCalls).toHaveLength(1);
  });

  it('an admin deletes an ownerless shared view, session satisfied: deleted', async () => {
    const { svc, deleteCalls } = svcFor(SATISFIED, 'admin', [[], [], [{ id: 'v-orphan' }]]);
    await expect(svc.remove('v-orphan')).resolves.toBeUndefined();
    expect(deleteCalls).toHaveLength(3);
  });

  it("deleting one's own private view, session not satisfied: deleted", async () => {
    const { svc, deleteCalls } = svcFor(UNSATISFIED, 'staff');
    await expect(svc.remove('v-1')).resolves.toBeUndefined();
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]!.args[deleteCalls[0]!.methods.lastIndexOf('eq')]).toEqual([
      'is_shared',
      false,
    ]);
  });

  it("deleting one's own shared view, session not satisfied: refused with mfa_required, the shared view stays", async () => {
    const { svc, deleteCalls } = svcFor(UNSATISFIED, 'staff', [[]]);
    await expect(svc.remove('v-own-shared')).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'mfa_required' },
    });
    // The private-view delete matched nothing; no delete of a shared view ran.
    expect(deleteCalls).toHaveLength(1);
    await expect(svc.removeOwnShared('v-own-shared')).rejects.toMatchObject({
      details: { reason: 'mfa_required' },
    });
    expect(deleteCalls).toHaveLength(1);
  });

  it("deleting one's own shared view, session satisfied: deleted", async () => {
    const { svc, deleteCalls } = svcFor(SATISFIED, 'staff', [[], [{ id: 'v-own-shared' }]]);
    await expect(svc.remove('v-own-shared')).resolves.toBeUndefined();
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls[1]!.args[deleteCalls[1]!.methods.lastIndexOf('eq')]).toEqual([
      'is_shared',
      true,
    ]);
  });

  it('a member who is not an admin: removeOwnerless deletes nothing', async () => {
    const { svc, deleteCalls } = svcFor(SATISFIED, 'staff');
    await expect(svc.removeOwnerless('v-orphan')).resolves.toBe(false);
    expect(deleteCalls).toEqual([]);
  });
});
