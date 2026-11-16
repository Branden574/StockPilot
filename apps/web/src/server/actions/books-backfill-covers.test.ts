import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type Role } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * backfillBookCoversAction adds cover photos to the organization's books: it
 * asks for items:create, after the authenticator answer, before it reads or
 * writes anything.
 */

const h = vi.hoisted(() => ({
  ctx: null as unknown,
}));

vi.mock('@/server/services/context', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/context')>();
  return { ...real, withContext: vi.fn(async () => h.ctx) };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryListForCurrentOrg: vi.fn(async () => {}),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import { backfillBookCoversAction } from './books-backfill-covers';

function contextFor(role: Role, mfa: { mfaRequired: boolean; mfaSatisfied: boolean }) {
  const stub = makeSupabaseStub({ 'inventory_items.select': { data: [], error: null } });
  h.ctx = makeServiceContext(stub.client, {
    role,
    enabledModules: new Set(DEFAULT_MODULE_IDS),
    ...mfa,
  });
  return stub;
}

beforeEach(() => vi.clearAllMocks());

describe('backfillBookCoversAction', () => {
  it('required and not satisfied: mfa_required, nothing read or written', async () => {
    const stub = contextFor('manager', { mfaRequired: true, mfaSatisfied: false });
    const res = await backfillBookCoversAction();
    expect(res).toMatchObject({
      ok: false,
      error: { code: 'forbidden', details: { reason: 'mfa_required' } },
    });
    expect(stub.fromCalls).toEqual([]);
    expect(stub.client.storage.from).not.toHaveBeenCalled();
  });

  it('a member without items:create is refused, nothing read or written', async () => {
    const stub = contextFor('viewer', { mfaRequired: false, mfaSatisfied: true });
    const res = await backfillBookCoversAction();
    expect(res).toMatchObject({
      ok: false,
      error: { code: 'forbidden', message: 'Missing permission: items:create' },
    });
    expect(stub.fromCalls).toEqual([]);
  });

  it('a member with items:create whose session satisfies the policy runs it', async () => {
    const stub = contextFor('manager', { mfaRequired: true, mfaSatisfied: true });
    const res = await backfillBookCoversAction();
    expect(res).toEqual({
      ok: true,
      data: { rehosted: 0, alreadyHadPrimary: 0, noUrlOnRow: 0, failed: 0, scanned: 0 },
    });
    expect(stub.fromCalls).toContain('inventory_items');
  });
});
