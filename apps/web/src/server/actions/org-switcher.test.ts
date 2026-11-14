import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// The action asks for the member's context (requireOrgContext), which sends a
// session that still owes its authenticator code to /signin/mfa
// (lib/auth/session.step-up.test.ts). Here it answers, or redirects as the
// real one does.
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-1',
    email: 'u@example.test',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: 'org-1',
    organizationId: 'org-1',
    organizationName: 'Org One',
    role: 'staff',
  })),
}));

const stubHolder: { stub: ReturnType<typeof makeSupabaseStub> | null } = {
  stub: null,
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => stubHolder.stub!.client),
}));

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requireOrgContext } from '@/lib/auth/session';

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

  it('a membership read that fails: internal_error (try again), never forbidden, and nothing switched', async () => {
    stubHolder.stub = makeSupabaseStub({
      'organization_members.select': {
        data: null,
        error: { code: '57014', message: 'canceling statement due to statement timeout' },
      },
      'user_profiles.update': { data: null, error: null },
    });
    const result = await switchOrganizationAction({ organizationId: VALID_ORG_ID });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('internal_error');
      expect(result.error.message).not.toMatch(/statement|timeout/);
    }
    expect(stubHolder.stub.fromCalls).not.toContain('user_profiles');
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

  it('a session the context sends to the authenticator code page switches nothing, and the redirect gets out', async () => {
    stubHolder.stub = makeSupabaseStub({
      'organization_members.select': {
        data: [{ organization_id: VALID_ORG_ID }],
        error: null,
      },
      'user_profiles.update': { data: null, error: null },
    });
    vi.mocked(requireOrgContext).mockImplementationOnce(async () => redirect('/signin/mfa'));

    await expect(switchOrganizationAction({ organizationId: VALID_ORG_ID })).rejects.toMatchObject({
      digest: expect.stringContaining('/signin/mfa'),
    });
    expect(stubHolder.stub.fromCalls).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
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
