import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

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

vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));

import { revalidatePath } from 'next/cache';

import { audit } from '@/server/services/audit';

import {
  setAvatarUrlAction,
  setOrgLogoUrlAction,
  updateProfileNameAction,
} from './profile';

describe('updateProfileNameAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'admin';
    stubHolder.stub = makeSupabaseStub({
      'user_profiles.update': { data: null, error: null },
    });
  });

  it('rejects an empty fullName as validation_error', async () => {
    const result = await updateProfileNameAction({ fullName: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
  });

  it('accepts a valid name and revalidates', async () => {
    const result = await updateProfileNameAction({ fullName: '  Branden  ' });
    expect(result.ok).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard', 'layout');
    // Trimmed by zod's .trim()
    const args = stubHolder.stub!.chainArgs.get('user_profiles.update');
    expect(args?.[0]?.[0]).toEqual({ full_name: 'Branden' });
  });

  it('accepts null to clear the name', async () => {
    const result = await updateProfileNameAction({ fullName: null });
    expect(result.ok).toBe(true);
  });
});

describe('setAvatarUrlAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'admin';
    stubHolder.stub = makeSupabaseStub({
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

  it('persists a valid URL', async () => {
    const result = await setAvatarUrlAction({
      url: 'https://example.com/a.png',
    });
    expect(result.ok).toBe(true);
    const args = stubHolder.stub!.chainArgs.get('user_profiles.update');
    expect(args?.[0]?.[0]).toEqual({
      avatar_url: 'https://example.com/a.png',
    });
  });

  it('rejects a non-URL string as validation_error', async () => {
    const result = await setAvatarUrlAction({ url: 'not a url' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
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

  it('persists for admin and writes an audit entry', async () => {
    const result = await setOrgLogoUrlAction({
      url: 'https://example.com/logo.png',
    });
    expect(result.ok).toBe(true);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard', 'layout');
  });
});
