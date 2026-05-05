import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    userId: 'user-1',
    email: 'u@e.com',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: 'org-1',
  })),
}));

const stubHolder: { stub: ReturnType<typeof makeSupabaseStub> | null } = {
  stub: null,
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => stubHolder.stub!.client),
}));

import { revalidatePath } from 'next/cache';

import { switchOrganizationAction } from './org-switcher';

const VALID_ORG_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('switchOrganizationAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubHolder.stub = null;
  });

  it('rejects invalid uuid as validation_error', async () => {
    stubHolder.stub = makeSupabaseStub();
    const result = await switchOrganizationAction({ organizationId: 'not-uuid' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
  });

  it('returns forbidden when membership lookup yields no row', async () => {
    stubHolder.stub = makeSupabaseStub({
      'organization_members.select': { data: null, error: null },
    });
    const result = await switchOrganizationAction({ organizationId: VALID_ORG_ID });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('updates default org and revalidates dashboard layout on success', async () => {
    stubHolder.stub = makeSupabaseStub({
      'organization_members.select': {
        data: [{ organization_id: VALID_ORG_ID }],
        error: null,
      },
      'user_profiles.update': { data: null, error: null },
    });

    const result = await switchOrganizationAction({ organizationId: VALID_ORG_ID });
    expect(result.ok).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard', 'layout');

    // user_profiles.update was actually issued
    expect(stubHolder.stub.fromCalls).toContain('user_profiles');
  });

  it('returns internal_error when the update fails', async () => {
    stubHolder.stub = makeSupabaseStub({
      'organization_members.select': {
        data: [{ organization_id: VALID_ORG_ID }],
        error: null,
      },
      'user_profiles.update': { data: null, error: { message: 'db down' } },
    });

    const result = await switchOrganizationAction({ organizationId: VALID_ORG_ID });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('internal_error');
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
