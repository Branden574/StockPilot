import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));

// Force a stable Supabase URL so the avatar prefix validation is
// deterministic across local + CI environments.
vi.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_SUPABASE_URL: 'https://supa.example.com' },
}));

const sessionState = {
  role: 'admin' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
};

vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    userId: 'user-1',
    email: 'u@e.com',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: 'org-1',
  })),
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-1',
    email: 'u@e.com',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: 'org-1',
    organizationId: 'org-1',
    organizationName: 'Test',
    role: sessionState.role,
  })),
}));

const stubHolder: { stub: ReturnType<typeof makeSupabaseStub> | null } = {
  stub: null,
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => stubHolder.stub!.client),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    auth: {
      admin: {
        deleteUser: vi.fn(async () => ({ error: null })),
      },
    },
  })),
}));

vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));

vi.mock('@/server/services/context', async () => {
  const actual = await vi.importActual<typeof import('@/server/services/context')>(
    '@/server/services/context',
  );
  return {
    ...actual,
    withContext: vi.fn(async () => ({
      organizationId: 'org-1',
      userId: 'user-1',
      role: sessionState.role,
      supabase: stubHolder.stub!.client,
      mfaRequired: false,
      mfaSatisfied: true,
    })),
  };
});

import { revalidatePath } from 'next/cache';

import { audit } from '@/server/services/audit';

import {
  deleteOwnAccountAction,
  setAvatarUrlAction,
  setOrgLogoUrlAction,
  updateProfileNameAction,
} from './profile';

const AVATAR_PREFIX =
  'https://supa.example.com/storage/v1/object/public/user-avatars/user-1/';

describe('updateProfileNameAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'admin';
    stubHolder.stub = makeSupabaseStub({
      'user_profiles.select': { data: [{ full_name: 'Old' }], error: null },
      'user_profiles.update': { data: null, error: null },
    });
  });

  it('rejects an empty fullName as validation_error', async () => {
    const result = await updateProfileNameAction({ fullName: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
  });

  it('accepts a valid name, audits, and revalidates', async () => {
    const result = await updateProfileNameAction({ fullName: '  Branden  ' });
    expect(result.ok).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard', 'layout');
    const args = stubHolder.stub!.chainArgs.get('user_profiles.update');
    expect(args?.[0]?.[0]).toEqual({ full_name: 'Branden' });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'user.profile.updated' }),
    );
  });

  it('accepts null to clear the name', async () => {
    const result = await updateProfileNameAction({ fullName: null });
    expect(result.ok).toBe(true);
  });

  it('strips bidi-override and control chars before saving', async () => {
    const result = await updateProfileNameAction({
      fullName: 'Bran‮den',
    });
    expect(result.ok).toBe(true);
    const args = stubHolder.stub!.chainArgs.get('user_profiles.update');
    expect(args?.[0]?.[0]).toEqual({ full_name: 'Branden' });
  });
});

describe('setAvatarUrlAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'admin';
    stubHolder.stub = makeSupabaseStub({
      'user_profiles.select': {
        data: [{ avatar_url: `${AVATAR_PREFIX}old.webp` }],
        error: null,
      },
      'user_profiles.update': { data: null, error: null },
    });
  });

  it('persists null to clear the avatar', async () => {
    const result = await setAvatarUrlAction({ url: null });
    expect(result.ok).toBe(true);
    const args = stubHolder.stub!.chainArgs.get('user_profiles.update');
    expect(args?.[0]?.[0]).toEqual({ avatar_url: null });
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard', 'layout');
  });

  it('persists a valid in-bucket URL stripped of cache-buster', async () => {
    const result = await setAvatarUrlAction({
      url: `${AVATAR_PREFIX}new.webp?t=12345`,
    });
    expect(result.ok).toBe(true);
    const args = stubHolder.stub!.chainArgs.get('user_profiles.update');
    expect(args?.[0]?.[0]).toEqual({
      avatar_url: `${AVATAR_PREFIX}new.webp`,
    });
  });

  it('rejects an out-of-bucket URL', async () => {
    const result = await setAvatarUrlAction({
      url: 'https://example.com/a.png',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
  });

  it('rejects a non-URL string as validation_error', async () => {
    const result = await setAvatarUrlAction({ url: 'not a url' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
  });

  it('audits user.profile.updated on success', async () => {
    await setAvatarUrlAction({ url: `${AVATAR_PREFIX}new.webp` });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'user.profile.updated' }),
    );
  });
});

describe('setOrgLogoUrlAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'admin';
    stubHolder.stub = makeSupabaseStub({
      'organizations.select': {
        data: [{ logo_url: 'https://old/logo.png' }],
        error: null,
      },
      'organizations.update': { data: null, error: null },
    });
  });

  it('forbids non-admin roles', async () => {
    sessionState.role = 'staff';
    const result = await setOrgLogoUrlAction({
      url: 'https://example.com/logo.png',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(audit).not.toHaveBeenCalled();
  });

  it('persists for admin and writes an organization.updated audit entry', async () => {
    const result = await setOrgLogoUrlAction({
      url: 'https://example.com/logo.png',
    });
    expect(result.ok).toBe(true);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'organization.updated' }),
    );
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard', 'layout');
  });
});

describe('deleteOwnAccountAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'admin';
    stubHolder.stub = makeSupabaseStub({
      'organization_members.select': { data: [], error: null },
      'user_profiles.update': { data: null, error: null },
    });
  });

  it('rejects without the typed DELETE confirmation', async () => {
    const result = await deleteOwnAccountAction({ confirm: 'delete' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
  });

  it('soft-deletes the profile when the user owns nothing co-occupied', async () => {
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result.ok).toBe(true);
    const args = stubHolder.stub!.chainArgs.get('user_profiles.update');
    expect((args?.[0]?.[0] as { deleted_at?: string }).deleted_at).toBeDefined();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'user.deactivated' }),
    );
  });

  it('refuses when the user owns an org with other members', async () => {
    stubHolder.stub = makeSupabaseStub({
      'organization_members.select': {
        data: [
          { organization_id: 'org-1' }, // owned org
          { organization_id: 'org-1' }, // other member when re-queried
        ],
        error: null,
      },
      'user_profiles.update': { data: null, error: null },
    });
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
  });
});
