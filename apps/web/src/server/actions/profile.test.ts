import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

// a534b31e (2026-07-10, "updateTag requires cacheComponents — use
// revalidateTag everywhere") swapped setOrgLogoUrlAction's cache
// invalidation from updateTag('dashboard-org') to
// revalidateTag('dashboard-org', 'max'), but this mock kept stubbing the
// old export and never added the new one. Vitest's mock-module guard
// throws on the unstubbed call, which the action's catch-all turned into
// a silent internal_error (test saw `result.ok === false`).
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

// Force a stable Supabase URL so the avatar prefix validation is
// deterministic across local + CI environments.
vi.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_SUPABASE_URL: 'https://supa.example.com' },
}));

const sessionState = {
  role: 'admin' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
};

/**
 * SP-129 — the org-less user. Every auth helper in lib/auth/session.ts answers
 * an account with no accepted membership by `redirect('/onboarding')`, and Next
 * implements redirect() by THROWING an error whose `digest` names the
 * destination. These knobs let a test put the module under exactly that
 * condition instead of the permanently-org-1 world the original mocks
 * described (which is why the org-less branch was never exercised).
 */
const { authState, mfaState, redirectError } = vi.hoisted(() => ({
  mfaState: {
    /** Org policy leg (withContext). Default: nothing required. */
    orgPolicyRequires: false,
    satisfied: true,
    enrolled: false,
    /** Session leg (supabase.auth.mfa.*), which is all an org-less user has. */
    totp: [] as Array<{ status: string }>,
    currentLevel: 'aal1' as 'aal1' | 'aal2',
  },
  authState: {
    /** No accepted membership: getSessionMemberships() -> [] and every
     *  org-resolving helper redirects to /onboarding. */
    orgLess: false,
    /** Signed out: requireSession() redirects to /signin. */
    signedOut: false,
  },
  redirectError: (path: string): Error & { digest: string } => {
    const e = new Error('NEXT_REDIRECT') as Error & { digest: string };
    // Byte-shape of a real next/navigation redirect throw:
    // `NEXT_REDIRECT;<replace|push>;<destination>;<status>;`
    e.digest = `NEXT_REDIRECT;replace;${path};307;`;
    return e;
  },
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => {
    if (authState.signedOut) throw redirectError('/signin');
    return {
      userId: 'user-1',
      email: 'u@e.com',
      fullName: null,
      avatarUrl: null,
      defaultOrganizationId: authState.orgLess ? null : 'org-1',
    };
  }),
  requireOrgContext: vi.fn(async () => {
    if (authState.signedOut) throw redirectError('/signin');
    if (authState.orgLess) throw redirectError('/onboarding');
    return {
      userId: 'user-1',
      email: 'u@e.com',
      fullName: null,
      avatarUrl: null,
      defaultOrganizationId: 'org-1',
      organizationId: 'org-1',
      organizationName: 'Test',
      role: sessionState.role,
    };
  }),
  getSessionMemberships: vi.fn(async () =>
    authState.orgLess
      ? []
      : [{ organizationId: 'org-1', role: sessionState.role, name: 'Test', logoUrl: null }],
  ),
}));

const stubHolder: { stub: ReturnType<typeof makeSupabaseStub> | null } = {
  stub: null,
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => stubHolder.stub!.client),
}));

/**
 * MED-23 — setOrgLogoUrlAction reads the LEADING BYTES of the object the
 * submitted URL names (fetchObjectPrefix — a range read; the helper's own
 * suite proves the range/streaming mechanics) and sniffs them before the URL
 * becomes the org's logo, deleting the object if the bytes are not an image
 * the org-logos bucket accepts. So the admin-client mock needs a storage leg
 * for the delete, and the bytes the prefix read serves have to be settable per
 * test. `logoStorage.body` is what the prefix read returns (null = the object
 * does not exist); the prefix/remove spies are asserted directly.
 */
const { logoStorage, fetchObjectPrefixMock, adminAuth, revokeAllSessionsForUserMock, reportErrorMock } =
  vi.hoisted(() => ({
    logoStorage: {
      body: null as Uint8Array | null,
      remove: vi.fn(),
    },
    fetchObjectPrefixMock: vi.fn(),
    /** SP-008 — the auth delete is the step that can fail on its own (a dead
     *  service-role key 401s here while every user-authed read stays up, the
     *  2026-07-21 incident). Hoisted so a test can make it fail. */
    adminAuth: {
      deleteUser: vi.fn(async (_userId: string) => ({
        error: null as { message: string } | null,
      })),
    },
    revokeAllSessionsForUserMock: vi.fn(async () => ({ ok: true, sessionIds: [] as string[] })),
    reportErrorMock: vi.fn(async () => undefined),
  }));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    auth: {
      admin: {
        deleteUser: adminAuth.deleteUser,
      },
    },
    storage: {
      from: vi.fn(() => ({
        remove: logoStorage.remove,
      })),
    },
  })),
}));

vi.mock('@/lib/storage-object-prefix', () => ({
  fetchObjectPrefix: fetchObjectPrefixMock,
}));

vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));

vi.mock('@/server/services/platform/sessions', () => ({
  revokeAllSessionsForUser: revokeAllSessionsForUserMock,
}));

// Only reportError is stubbed — isNextControlFlowError is REAL, because the
// redirect-rethrow assertions below depend on its actual digest matching.
vi.mock('@/lib/error-reporter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/error-reporter')>(
    '@/lib/error-reporter',
  );
  return { ...actual, reportError: reportErrorMock };
});

vi.mock('@/server/services/context', async () => {
  const actual = await vi.importActual<typeof import('@/server/services/context')>(
    '@/server/services/context',
  );
  return {
    ...actual,
    withContext: vi.fn(async () => {
      // The real withContext() calls requireOrgContext(), which redirects an
      // org-less session to /onboarding — i.e. it THROWS. Modelling that is the
      // whole point of SP-129.
      if (authState.signedOut) throw redirectError('/signin');
      if (authState.orgLess) throw redirectError('/onboarding');
      return {
        organizationId: 'org-1',
        userId: 'user-1',
        role: sessionState.role,
        supabase: stubHolder.stub!.client,
        mfaRequired: mfaState.orgPolicyRequires,
        mfaSatisfied: mfaState.satisfied,
        mfaEnrolled: mfaState.enrolled,
      };
    }),
  };
});

import { revalidatePath, revalidateTag } from 'next/cache';

import { audit } from '@/server/services/audit';

import {
  deleteOwnAccountAction,
  setAvatarUrlAction,
  setOrgLogoUrlAction,
  updateProfileNameAction,
} from './profile';

const AVATAR_PREFIX =
  'https://supa.example.com/storage/v1/object/public/user-avatars/user-1/';

// The auth/MFA knobs are module-level and mutable, so reset them before EVERY
// test (this runs ahead of each describe's own beforeEach) — a leaked
// `orgLess: true` would silently rewrite the world for the next file's worth
// of assertions.
beforeEach(() => {
  authState.orgLess = false;
  authState.signedOut = false;
  mfaState.orgPolicyRequires = false;
  mfaState.satisfied = true;
  mfaState.enrolled = false;
  mfaState.totp = [];
  mfaState.currentLevel = 'aal1';
  adminAuth.deleteUser.mockImplementation(async () => ({ error: null }));
  revokeAllSessionsForUserMock.mockImplementation(async () => ({ ok: true, sessionIds: [] }));
});

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

/** A real 26-byte PNG: the 8-byte signature, IHDR length+tag, then 2x3
 *  dimensions. Every byte is a literal from the PNG spec — the point is to
 *  prove the sniff accepts a GENUINE image, so the refusals below cannot be
 *  credited to a guard that rejects everything. */
function pngBytes(): Uint8Array {
  const b = new Uint8Array(26);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(b.buffer).setUint32(16, 2);
  new DataView(b.buffer).setUint32(20, 3);
  return b;
}

const LOGO_URL_BASE = 'https://supa.example.com/storage/v1/object/public/org-logos/org-1/';

describe('setOrgLogoUrlAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'admin';
    logoStorage.body = pngBytes();
    fetchObjectPrefixMock.mockImplementation(async () =>
      logoStorage.body
        ? { prefix: logoStorage.body, totalSize: logoStorage.body.byteLength }
        : null,
    );
    logoStorage.remove.mockImplementation(async () => ({ data: null, error: null }));
    stubHolder.stub = makeSupabaseStub({
      'organizations.select': {
        data: [{ logo_url: 'https://old/logo.png' }],
        error: null,
      },
      // update now does .select('id').maybeSingle() + a row-hit check, so the
      // stub must return the updated row.
      'organizations.update': { data: { id: 'org-1' }, error: null },
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
      url: 'https://supa.example.com/storage/v1/object/public/org-logos/org-1/logo.png',
    });
    expect(result.ok).toBe(true);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'organization.updated' }),
    );
    expect(revalidateTag).toHaveBeenCalledWith('dashboard-org', 'max');
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard', 'layout');
  });

  it('MED-23 — a body whose BYTES are not an image is refused, the object is DELETED, and no logo is persisted', async () => {
    // org-logos is a PUBLIC bucket. Its allowed_mime_types pin (0046) only
    // inspects the Content-Type header the browser attached to its PUT, which
    // is client-controlled — so an HTML document or an SVG carrying script
    // uploads cleanly by declaring image/png and then lives at a permanent,
    // unauthenticated URL on the Supabase origin. This action is what would
    // publish that URL into every page header, PDF and export.
    logoStorage.body = new TextEncoder().encode('<svg onload="alert(1)"></svg>');
    const result = await setOrgLogoUrlAction({ url: `${LOGO_URL_BASE}logo-1.png` });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    // Verify-or-DELETE: the unverified object must not survive at its public URL.
    expect(logoStorage.remove).toHaveBeenCalledWith(['org-1/logo-1.png']);
    expect(audit).not.toHaveBeenCalled();
  });

  it('MED-23 — a URL naming an object that was never uploaded is refused without persisting', async () => {
    logoStorage.body = null; // download fails
    const result = await setOrgLogoUrlAction({ url: `${LOGO_URL_BASE}logo-missing.png` });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    // Nothing was uploaded, so there is nothing to remove.
    expect(logoStorage.remove).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('MED-23 — a genuine PNG is accepted and the object is NOT deleted (the guard is not simply refusing everything)', async () => {
    logoStorage.body = pngBytes();
    const result = await setOrgLogoUrlAction({ url: `${LOGO_URL_BASE}logo-2.png` });
    expect(result.ok).toBe(true);
    expect(fetchObjectPrefixMock).toHaveBeenCalledWith(expect.anything(), 'org-1/logo-2.png');
    expect(logoStorage.remove).not.toHaveBeenCalled();
  });

  it.each([
    'logo-1.png/../../item-images/victim-org/victim-item/cover.jpg',
    '%2e%2e/%2e%2e/maintenance-photos/victim/photo.jpg',
    '%252e%252e/item-images/victim/x.jpg',
    'sub/folder/logo.png',
    'logo 1.png',
  ])('HI-8 — the derived object path %s is shape-refused BEFORE any service-role storage call', async (tail) => {
    // The org-prefix check on the URL is a PREFIX check, and a prefix check says
    // nothing about the rest of the string: `<org>/../../<bucket>/...` starts
    // with the expected prefix and still escapes the bucket once storage-js
    // interpolates it into a fetch() URL. The derived path is therefore
    // shape-validated before the admin download is attempted.
    const result = await setOrgLogoUrlAction({ url: `${LOGO_URL_BASE}${tail}` });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(fetchObjectPrefixMock).not.toHaveBeenCalled();
    expect(logoStorage.remove).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('clearing the logo (url: null) needs no object to exist and touches storage not at all', async () => {
    const result = await setOrgLogoUrlAction({ url: null });
    expect(result.ok).toBe(true);
    expect(fetchObjectPrefixMock).not.toHaveBeenCalled();
    expect(logoStorage.remove).not.toHaveBeenCalled();
  });

  it('rejects a logo URL outside the org’s own storage folder (SSRF guard)', async () => {
    // logo_url is fetched server-side by the PDF renderers, so an arbitrary host
    // is an SSRF sink — it must be rejected before persisting.
    const result = await setOrgLogoUrlAction({ url: 'https://evil.example.com/x.png' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(audit).not.toHaveBeenCalled();
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
    // The session MFA legs (all an org-less user has — there is no org policy
    // to consult) are driven from mfaState.
    stubHolder.stub.client.auth.mfa.listFactors.mockImplementation(async () => ({
      data: { all: mfaState.totp, totp: mfaState.totp },
      error: null,
    }));
    stubHolder.stub.client.auth.mfa.getAuthenticatorAssuranceLevel.mockImplementation(
      async () => ({ data: { currentLevel: mfaState.currentLevel }, error: null }),
    );
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

  it('does not revoke sessions on the happy path', async () => {
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result.ok).toBe(true);
    expect(revokeAllSessionsForUserMock).not.toHaveBeenCalled();
  });

  /**
   * SP-129 — a user with NO accepted membership (abandoned /onboarding, or
   * removed from their only org by TeamService.removeMember, which deletes the
   * membership and leaves the auth user + profile intact) must still be able to
   * delete their own account: App Store 5.1.1(v) and GDPR both require it.
   *
   * The gate used to be `withContext()`, which calls requireOrgContext(), which
   * answers an org-less session with `redirect('/onboarding')` — a THROW. The
   * catch-all then reported it as internal_error 'NEXT_REDIRECT' (recurring
   * pattern #23) and the account could never be deleted.
   */
  describe('without an org (SP-129)', () => {
    beforeEach(() => {
      authState.orgLess = true;
    });

    it('deletes the account instead of dying on the org gate', async () => {
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(true);
      const args = stubHolder.stub!.chainArgs.get('user_profiles.update');
      expect((args?.[0]?.[0] as { deleted_at?: string }).deleted_at).toBeDefined();
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'user.deactivated' }),
      );
      expect(adminAuth.deleteUser).toHaveBeenCalledWith('user-1');
    });

    it('still enforces an ENROLLED factor (HI-6): aal1 is refused with aal2_required', async () => {
      // Losing the org must not lose the enrollment escalation — a verified
      // factor has to be satisfied whatever (or whether) an org policy says.
      mfaState.totp = [{ status: 'verified' }];
      mfaState.currentLevel = 'aal1';
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('forbidden');
        expect((result.error.details as { reason?: string } | undefined)?.reason).toBe(
          'aal2_required',
        );
      }
      expect(adminAuth.deleteUser).not.toHaveBeenCalled();
    });

    it('lets an enrolled user through once the session is at aal2', async () => {
      mfaState.totp = [{ status: 'verified' }];
      mfaState.currentLevel = 'aal2';
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(true);
    });

    it('fails CLOSED when the factor list cannot be read', async () => {
      // Mirrors resolveMfaState in services/context.ts: an unreadable MFA state
      // must never be treated as "no MFA required" on a destructive action.
      stubHolder.stub!.client.auth.mfa.listFactors.mockImplementation(async () => {
        throw new Error('network');
      });
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('forbidden');
      expect(adminAuth.deleteUser).not.toHaveBeenCalled();
    });
  });

  it('keeps the org MFA policy for a member WHO HAS an org', async () => {
    // Behaviour pin: the org-less path must not become a way around the org's
    // own mfa_policy. A member still goes through withContext().
    mfaState.orgPolicyRequires = true;
    mfaState.satisfied = false;
    mfaState.enrolled = true;
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect((result.error.details as { reason?: string } | undefined)?.reason).toBe(
        'aal2_required',
      );
    }
    expect(adminAuth.deleteUser).not.toHaveBeenCalled();
  });

  it('rethrows a redirect instead of reporting it as internal_error', async () => {
    // Recurring pattern #23: a page-only auth helper answers a signed-out
    // session by THROWING NEXT_REDIRECT. Swallowing it into the catch-all
    // turned "you are signed out" into "internal error: NEXT_REDIRECT".
    authState.signedOut = true;
    await expect(deleteOwnAccountAction({ confirm: 'DELETE' })).rejects.toMatchObject({
      digest: 'NEXT_REDIRECT;replace;/signin;307;',
    });
  });

  /**
   * SP-008 — `admin.auth.admin.deleteUser` failing used to be logged and
   * reported as SUCCESS, on the premise that "the profile tombstone already
   * prevents login". That premise is false: no identity funnel reads
   * user_profiles.deleted_at (loadSessionAndContext selects disabled_at,
   * ACCOUNT_STATUS_COLUMNS is 'disabled_at', 0310's is_org_member checks
   * disabled_at). So the user was told their account was gone while the auth
   * user, memberships and sessions all stayed live.
   */
  describe('when the auth delete fails (SP-008)', () => {
    beforeEach(() => {
      adminAuth.deleteUser.mockImplementation(async () => ({
        error: { message: 'Invalid API key' },
      }));
    });

    it('reports the failure instead of a false success', async () => {
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('internal_error');
        // Never the raw admin error text — but not a fake success either.
        expect(result.error.message).not.toContain('Invalid API key');
      }
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it('revokes the live sessions and reports the error', async () => {
      await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(revokeAllSessionsForUserMock).toHaveBeenCalledWith('user-1');
      expect(reportErrorMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tag: 'account.delete.auth_delete_failed' }),
      );
    });

    it('still fails the delete when the session revoke also fails', async () => {
      // A dead service-role key breaks BOTH admin calls — the revoke is
      // best-effort, so it must not turn the refusal into a throw or a success.
      revokeAllSessionsForUserMock.mockImplementation(async () => {
        throw new Error('service role dead');
      });
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('internal_error');
    });
  });
});
