import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';
import { verifiedSessionAuth } from '@/test/verified-session-stub';

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
    /** S50a: whose account the cookie session's reads answer for (the
     *  factor list and the verified claims); 'user-1' is the validated user. */
    sessionUserId: 'user-1',
  },
  authState: {
    /** No accepted membership: getSessionMemberships() -> [] and every
     *  org-resolving helper redirects to /onboarding. */
    orgLess: false,
    /** Signed out: requireSession() redirects to /signin. */
    signedOut: false,
    /** Reads of the person's memberships so far, by either session reader. */
    membershipReads: 0,
    /** The read (1st, 2nd) whose membership list cannot be read, or null. */
    membershipsUnreadableAt: null as number | null,
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
      email: 'u@example.test',
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
      email: 'u@example.test',
      fullName: null,
      avatarUrl: null,
      defaultOrganizationId: 'org-1',
      organizationId: 'org-1',
      organizationName: 'Test',
      role: sessionState.role,
    };
  }),
  // A list that cannot be read: readSessionMemberships() says so, and
  // getSessionMemberships() answers an empty list, as the session loader does.
  getSessionMemberships: vi.fn(async () => {
    authState.membershipReads += 1;
    if (authState.membershipReads === authState.membershipsUnreadableAt) return [];
    return authState.orgLess
      ? []
      : [{ organizationId: 'org-1', role: sessionState.role, name: 'Test', logoUrl: null }];
  }),
  readSessionMemberships: vi.fn(async () => {
    authState.membershipReads += 1;
    if (authState.membershipReads === authState.membershipsUnreadableAt) return { ok: false };
    return {
      ok: true,
      memberships: authState.orgLess
        ? []
        : [{ organizationId: 'org-1', role: sessionState.role, name: 'Test', logoUrl: null }],
    };
  }),
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
const {
  logoStorage,
  fetchObjectPrefixMock,
  adminAuth,
  adminRpc,
  checkRateLimitMock,
  insertAuditRowReportedMock,
  revokeAllSessionsForUserMock,
  reportErrorMock,
  cookieSignOut,
  platformAdmin,
  avatarStorage,
  adminTables,
} =
  vi.hoisted(() => ({
    /** The admin client's table reads (O-A3-2, O-A3-5: read before the delete). */
    adminTables: { from: null as null | ((table: string) => unknown) },
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
        error: null as { message: string; status?: number; code?: string; name?: string } | null,
      })),
      /** The platform-admin check's email read (S50a), and review R7: asked
       *  again after deleteUser answered an error. */
      getUserById: vi.fn(async (_userId: string) => ({
        data: { user: { id: 'user-1' } as { id: string; email?: string | null } | null },
        error: null as { message: string; status?: number; code?: string } | null,
      })),
      /** S50a: the last check's factor read, by the validated user's id. */
      listFactors: vi.fn(async (_args: { userId: string }) => ({
        data: {
          factors: mfaState.totp.map((f, i) => ({ id: `f${i + 1}`, factor_type: 'totp', ...f })),
        } as { factors: Array<{ id: string; factor_type: string; status: string }> } | null,
        error: null as { message: string } | null,
      })),
    },
    /** 0388 — account_deletion_check, the dry run the action asks first. */
    adminRpc: vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({
      data: { deletable: true } as unknown,
      error: null as { code?: string } | null,
    })),
    checkRateLimitMock: vi.fn(async () => ({ allowed: true, count: 1, resetAt: 0 })),
    /** The user.deactivated row, written only after the delete succeeded. */
    insertAuditRowReportedMock: vi.fn(async (_row: Record<string, unknown>) => true),
    revokeAllSessionsForUserMock: vi.fn(async () => ({ ok: true, sessionIds: [] as string[] })),
    reportErrorMock: vi.fn(async () => undefined),
    cookieSignOut: vi.fn(async (_opts?: { scope?: string }) => ({ error: null as unknown })),
    /** O-A3-7 (0393): the VERIFIED auth email and the allowlist check. */
    platformAdmin: {
      getVerifiedEmail: vi.fn(async (): Promise<string | null> => 'u@example.test'),
      isPlatformAdmin: vi.fn((_email: string | null | undefined) => false),
    },
    /** O-A3-9 (0393): user-avatars/<uid>/ is emptied after the delete. */
    avatarStorage: {
      list: vi.fn(async (_prefix: string, _opts?: { limit?: number }) => ({
        data: [] as Array<{ name: string }> | null,
        error: null as { message: string } | null,
      })),
      remove: vi.fn(async (_paths: string[]) => ({ data: [] as unknown, error: null as { message: string } | null })),
    },
  }));

vi.mock('@/lib/auth/platform-admin', () => ({
  getVerifiedEmail: platformAdmin.getVerifiedEmail,
  isPlatformAdmin: platformAdmin.isPlatformAdmin,
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    auth: {
      admin: {
        deleteUser: adminAuth.deleteUser,
        getUserById: adminAuth.getUserById,
        mfa: { listFactors: adminAuth.listFactors },
      },
    },
    rpc: adminRpc,
    from: (table: string) => {
      if (!adminTables.from) throw new Error('admin table read not expected in this test');
      return adminTables.from(table);
    },
    storage: {
      from: vi.fn((bucket: string) =>
        bucket === 'user-avatars'
          ? { list: avatarStorage.list, remove: avatarStorage.remove }
          : { remove: logoStorage.remove },
      ),
    },
  })),
}));

vi.mock('@/lib/storage-object-prefix', () => ({
  fetchObjectPrefix: fetchObjectPrefixMock,
}));

vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
  insertAuditRowReported: insertAuditRowReportedMock,
}));

vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: checkRateLimitMock }));

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
  ACCOUNT_DELETE_LAST_OWNER_COPY,
  ACCOUNT_DELETE_RETRY_COPY,
  ACCOUNT_DELETE_SIGNED_OUT_COPY,
} from '@/server/lib/account-deletion';

import { err } from '@stockpilot/core';

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
  authState.membershipReads = 0;
  authState.membershipsUnreadableAt = null;
  mfaState.orgPolicyRequires = false;
  mfaState.satisfied = true;
  mfaState.enrolled = false;
  mfaState.totp = [];
  mfaState.currentLevel = 'aal1';
  mfaState.sessionUserId = 'user-1';
  adminAuth.deleteUser.mockImplementation(async () => ({ error: null }));
  adminAuth.getUserById.mockImplementation(async () => ({ data: { user: { id: 'user-1' } }, error: null }));
  adminRpc.mockImplementation(async () => ({ data: { deletable: true }, error: null }));
  checkRateLimitMock.mockImplementation(async () => ({ allowed: true, count: 1, resetAt: 0 }));
  insertAuditRowReportedMock.mockImplementation(async () => true);
  revokeAllSessionsForUserMock.mockImplementation(async () => ({ ok: true, sessionIds: [] }));
  platformAdmin.getVerifiedEmail.mockImplementation(async () => 'u@example.test');
  platformAdmin.isPlatformAdmin.mockImplementation(() => false);
  avatarStorage.list.mockImplementation(async () => ({ data: [], error: null }));
  avatarStorage.remove.mockImplementation(async () => ({ data: [], error: null }));
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
    const result = await updateProfileNameAction({ fullName: '  Carsten  ' });
    expect(result.ok).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard', 'layout');
    const args = stubHolder.stub!.chainArgs.get('user_profiles.update');
    expect(args?.[0]?.[0]).toEqual({ full_name: 'Carsten' });
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
      fullName: 'Cars‮ten',
    });
    expect(result.ok).toBe(true);
    const args = stubHolder.stub!.chainArgs.get('user_profiles.update');
    expect(args?.[0]?.[0]).toEqual({ full_name: 'Carsten' });
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

  // S45: a logo prints on branded PDFs only when it decodes within the image
  // decoder's cap (lib/image-decode.ts, 50 million pixels for PNG, JPEG and
  // WebP), so a larger one is refused here, at upload, with its size. Only
  // the header is read: these fixtures are headers alone.
  describe('a logo too large to print (S45)', () => {
    function pngHeaderOf(width: number, height: number): Uint8Array {
      const b = pngBytes();
      new DataView(b.buffer).setUint32(16, width);
      new DataView(b.buffer).setUint32(20, height);
      return b;
    }
    function jpegHeaderOf(width: number, height: number): Uint8Array {
      return new Uint8Array([
        0xff,
        0xd8,
        0xff,
        0xc0,
        0x00,
        0x11,
        0x08,
        height >> 8,
        height & 0xff,
        width >> 8,
        width & 0xff,
        0x03,
        1,
        0x11,
        0,
        2,
        0x11,
        0,
        3,
        0x11,
        0,
      ]);
    }
    /** RIFF, WEBP, then a VP8X chunk stating the canvas size. */
    function webpHeaderOf(width: number, height: number): Uint8Array {
      const b = new Uint8Array(30);
      b.set(new TextEncoder().encode('RIFF'), 0);
      new DataView(b.buffer).setUint32(4, 22, true);
      b.set(new TextEncoder().encode('WEBPVP8X'), 8);
      new DataView(b.buffer).setUint32(16, 10, true);
      const view = new DataView(b.buffer);
      view.setUint16(24, (width - 1) & 0xffff, true);
      b[26] = (width - 1) >> 16;
      view.setUint16(27, (height - 1) & 0xffff, true);
      b[29] = (height - 1) >> 16;
      return b;
    }
    const avifHeader = new Uint8Array([
      0,
      0,
      0,
      0x1c,
      ...new TextEncoder().encode('ftypavif'),
      0,
      0,
      0,
      0,
      ...new TextEncoder().encode('avifmif1miaf'),
    ]);

    it.each([
      ['a PNG of 10000 by 5001', pngHeaderOf(10000, 5001), '10000 by 5001'],
      ['a JPEG of 8000 by 6251', jpegHeaderOf(8000, 6251), '8000 by 6251'],
      ['a WebP of 7072 by 7072', webpHeaderOf(7072, 7072), '7072 by 7072'],
    ])(
      '%s is refused with its size, the object is removed, nothing is saved',
      async (_l, body, size) => {
        logoStorage.body = body;
        const result = await setOrgLogoUrlAction({ url: `${LOGO_URL_BASE}logo-big.png` });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('validation_error');
          expect(result.error.message).toBe(
            `That logo is too large to print (${size} pixels). Save a copy of at most 50 million pixels, such as 7000 by 7000, and upload it again.`,
          );
        }
        expect(logoStorage.remove).toHaveBeenCalledWith(['org-1/logo-big.png']);
        expect(stubHolder.stub!.chainArgs.get('organizations.update')).toBeUndefined();
        expect(audit).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['a PNG of 7071 by 7071 (just under 50 million pixels)', pngHeaderOf(7071, 7071)],
      ['a wide PNG wordmark of 6000 by 1200', pngHeaderOf(6000, 1200)],
      ['a JPEG of 4000 by 3000', jpegHeaderOf(4000, 3000)],
      ['a WebP of 7000 by 7000', webpHeaderOf(7000, 7000)],
      ['an AVIF (its size is not read at upload)', avifHeader],
    ])('%s is accepted', async (_l, body) => {
      logoStorage.body = body;
      const result = await setOrgLogoUrlAction({ url: `${LOGO_URL_BASE}logo-ok.png` });
      expect(result.ok).toBe(true);
      expect(logoStorage.remove).not.toHaveBeenCalled();
      expect(audit).toHaveBeenCalledTimes(1);
    });
  });

  it('rejects a logo URL outside the org’s own storage folder (SSRF guard)', async () => {
    // logo_url is fetched server-side by the PDF renderers, so an arbitrary host
    // is an SSRF sink — it must be rejected before persisting.
    const result = await setOrgLogoUrlAction({ url: 'https://evil.example.com/x.png' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(audit).not.toHaveBeenCalled();
  });

  // S76: once the column holds the new value, the object the column held
  // before is removed, when (and only when) it is this organization's own
  // logo object in the logo bucket and not the object just saved.
  describe('the previous logo object (S76)', () => {
    function withPrevious(previous: string | null, update?: { data: unknown; error: { message: string } | null }) {
      stubHolder.stub = makeSupabaseStub({
        'organizations.select': { data: [{ logo_url: previous }], error: null },
        'organizations.update': update ?? { data: { id: 'org-1' }, error: null },
      });
    }

    it('Replace removes the previous object once the new logo is saved', async () => {
      withPrevious(`${LOGO_URL_BASE}logo-100.png`);
      const result = await setOrgLogoUrlAction({ url: `${LOGO_URL_BASE}logo-200.png?t=200` });
      expect(result.ok).toBe(true);
      expect(stubHolder.stub!.chainArgs.get('organizations.update')?.[0]?.[0]).toEqual({
        logo_url: `${LOGO_URL_BASE}logo-200.png`,
      });
      expect(logoStorage.remove).toHaveBeenCalledTimes(1);
      expect(logoStorage.remove).toHaveBeenCalledWith(['org-1/logo-100.png']);
      expect(audit).toHaveBeenCalledTimes(1);
    });

    it('Remove removes the previous object once the column is cleared', async () => {
      withPrevious(`${LOGO_URL_BASE}logo-100.webp`);
      const result = await setOrgLogoUrlAction({ url: null });
      expect(result.ok).toBe(true);
      expect(stubHolder.stub!.chainArgs.get('organizations.update')?.[0]?.[0]).toEqual({ logo_url: null });
      expect(logoStorage.remove).toHaveBeenCalledTimes(1);
      expect(logoStorage.remove).toHaveBeenCalledWith(['org-1/logo-100.webp']);
    });

    it('a previous value saved with a query string still names its object', async () => {
      withPrevious(`${LOGO_URL_BASE}logo-100.png?t=100`);
      const result = await setOrgLogoUrlAction({ url: null });
      expect(result.ok).toBe(true);
      expect(logoStorage.remove).toHaveBeenCalledWith(['org-1/logo-100.png']);
    });

    it.each([
      ['an empty value', ''],
      ['no value', null],
      ['a URL on another host', 'https://cdn.example.org/brand/logo.png'],
      ['the same path on another host', 'https://other.example.com/storage/v1/object/public/org-logos/org-1/logo-100.png'],
      ['another organization folder', 'https://supa.example.com/storage/v1/object/public/org-logos/org-2/logo-100.png'],
      ['another bucket', 'https://supa.example.com/storage/v1/object/public/user-avatars/org-1/logo-100.png'],
      ['the bucket root', 'https://supa.example.com/storage/v1/object/public/org-logos/logo-100.png'],
      ['a folder below the organization folder', `${LOGO_URL_BASE}sub/logo-100.png`],
      ['a path that steps out of the folder', `${LOGO_URL_BASE}../org-2/logo-100.png`],
      ['an encoded step out of the folder', `${LOGO_URL_BASE}%2e%2e/org-2/logo-100.png`],
      ['a signed link of the bucket', 'https://supa.example.com/storage/v1/object/sign/org-logos/org-1/logo-100.png'],
      ['a value that is not a link', 'org-1/logo-100.png'],
    ])('a previous value that is %s removes nothing, on Replace and on Remove', async (_l, previous) => {
      withPrevious(previous);
      const replaced = await setOrgLogoUrlAction({ url: `${LOGO_URL_BASE}logo-200.png` });
      expect(replaced.ok).toBe(true);
      withPrevious(previous);
      const removed = await setOrgLogoUrlAction({ url: null });
      expect(removed.ok).toBe(true);
      expect(logoStorage.remove).not.toHaveBeenCalled();
      expect(reportErrorMock).not.toHaveBeenCalled();
    });

    it('saving the object the column already names removes nothing', async () => {
      withPrevious(`${LOGO_URL_BASE}logo-200.png?t=1`);
      const result = await setOrgLogoUrlAction({ url: `${LOGO_URL_BASE}logo-200.png?t=2` });
      expect(result.ok).toBe(true);
      expect(logoStorage.remove).not.toHaveBeenCalled();
    });

    it('the object just saved is never in a removal', async () => {
      withPrevious(`${LOGO_URL_BASE}logo-100.png`);
      await setOrgLogoUrlAction({ url: `${LOGO_URL_BASE}logo-200.png` });
      for (const call of logoStorage.remove.mock.calls) {
        expect(call[0]).not.toContain('org-1/logo-200.png');
      }
      expect(logoStorage.remove).toHaveBeenCalledTimes(1);
    });

    it('a removal that answers an error is reported and the save stands', async () => {
      withPrevious(`${LOGO_URL_BASE}logo-100.png`);
      logoStorage.remove.mockImplementation(async () => ({ data: null, error: { message: 'storage unavailable' } }));
      const result = await setOrgLogoUrlAction({ url: `${LOGO_URL_BASE}logo-200.png` });
      expect(result.ok).toBe(true);
      expect(stubHolder.stub!.chainArgs.get('organizations.update')?.[0]?.[0]).toEqual({
        logo_url: `${LOGO_URL_BASE}logo-200.png`,
      });
      expect(audit).toHaveBeenCalledTimes(1);
      expect(revalidateTag).toHaveBeenCalledWith('dashboard-org', 'max');
      await vi.waitFor(() => expect(reportErrorMock).toHaveBeenCalledTimes(1));
      expect(reportErrorMock).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tag: 'org.logo.remove_previous' }),
      );
      // The report names no object path.
      expect(JSON.stringify(reportErrorMock.mock.calls)).not.toContain('logo-100');
    });

    it('a removal that throws is reported and the save stands', async () => {
      withPrevious(`${LOGO_URL_BASE}logo-100.png`);
      logoStorage.remove.mockImplementation(async () => {
        throw new Error('network down');
      });
      const result = await setOrgLogoUrlAction({ url: null });
      expect(result.ok).toBe(true);
      expect(audit).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(reportErrorMock).toHaveBeenCalled());
      expect(reportErrorMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tag: 'org.logo.remove_previous' }),
      );
      expect(JSON.stringify(reportErrorMock.mock.calls)).not.toContain('logo-100');
    });

    it('a save that answers an error removes nothing', async () => {
      withPrevious(`${LOGO_URL_BASE}logo-100.png`, { data: null, error: { message: 'write refused' } });
      const replaced = await setOrgLogoUrlAction({ url: `${LOGO_URL_BASE}logo-200.png` });
      expect(replaced.ok).toBe(false);
      withPrevious(`${LOGO_URL_BASE}logo-100.png`, { data: null, error: { message: 'write refused' } });
      const removed = await setOrgLogoUrlAction({ url: null });
      expect(removed.ok).toBe(false);
      expect(logoStorage.remove).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it('a save that matches no row removes nothing', async () => {
      withPrevious(`${LOGO_URL_BASE}logo-100.png`, { data: null, error: null });
      const result = await setOrgLogoUrlAction({ url: null });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('not_found');
      expect(logoStorage.remove).not.toHaveBeenCalled();
    });

    it('a refused upload removes only the refused upload, never the current logo', async () => {
      withPrevious(`${LOGO_URL_BASE}logo-100.png`);
      logoStorage.body = new TextEncoder().encode('not an image');
      const result = await setOrgLogoUrlAction({ url: `${LOGO_URL_BASE}logo-200.png` });
      expect(result.ok).toBe(false);
      expect(logoStorage.remove).toHaveBeenCalledTimes(1);
      expect(logoStorage.remove).toHaveBeenCalledWith(['org-1/logo-200.png']);
      expect(stubHolder.stub!.chainArgs.get('organizations.update')).toBeUndefined();
    });

    it('the answer and the audit row do not wait for the removal', async () => {
      withPrevious(`${LOGO_URL_BASE}logo-100.png`);
      let settleRemoval: (value: { data: null; error: null }) => void = () => {};
      logoStorage.remove.mockImplementation(
        () => new Promise((resolve) => { settleRemoval = resolve; }),
      );
      const outcome = await Promise.race([
        setOrgLogoUrlAction({ url: `${LOGO_URL_BASE}logo-200.png` }),
        new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), 200)),
      ]);
      expect(outcome).toEqual({ ok: true, data: undefined });
      expect(logoStorage.remove).toHaveBeenCalledWith(['org-1/logo-100.png']);
      expect(audit).toHaveBeenCalledTimes(1);
      settleRemoval({ data: null, error: null });
    });

    it('a removal that fails after the answer is reported', async () => {
      withPrevious(`${LOGO_URL_BASE}logo-100.png`);
      let failRemoval: (reason: Error) => void = () => {};
      logoStorage.remove.mockImplementation(
        () => new Promise((_resolve, reject) => { failRemoval = reject; }),
      );
      const outcome = await Promise.race([
        setOrgLogoUrlAction({ url: null }),
        new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), 200)),
      ]);
      expect(outcome).toEqual({ ok: true, data: undefined });
      expect(reportErrorMock).not.toHaveBeenCalled();
      failRemoval(new Error('connection reset'));
      await vi.waitFor(() =>
        expect(reportErrorMock).toHaveBeenCalledWith(
          expect.any(Error),
          expect.objectContaining({ tag: 'org.logo.remove_previous' }),
        ),
      );
      expect(JSON.stringify(reportErrorMock.mock.calls)).not.toContain('logo-100');
    });

    it.each([
      ['Replace', `${LOGO_URL_BASE}logo-200.png`],
      ['Remove', null],
    ])('%s expires the public catalog page cache of organization data at once', async (_l, url) => {
      // The previous object is removed after this save, so the public page
      // must not serve its cached copy (which names that object) even once:
      // { expire: 0 } makes the next load read fresh, where 'max' would serve
      // the cached copy once while it refreshes.
      withPrevious(`${LOGO_URL_BASE}logo-100.png`);
      const result = await setOrgLogoUrlAction({ url });
      expect(result.ok).toBe(true);
      const publicTagCalls = vi
        .mocked(revalidateTag)
        .mock.calls.filter(([tag]) => tag === 'public-org-by-token');
      expect(publicTagCalls).toEqual([['public-org-by-token', { expire: 0 }]]);
    });

    it('a staff member removes nothing', async () => {
      sessionState.role = 'staff';
      withPrevious(`${LOGO_URL_BASE}logo-100.png`);
      const result = await setOrgLogoUrlAction({ url: null });
      expect(result.ok).toBe(false);
      expect(logoStorage.remove).not.toHaveBeenCalled();
    });
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
    // to consult) are driven from mfaState: the factor list is GoTrue's user
    // (getUser), the level the verified session claims (S50a), each answering
    // for mfaState.sessionUserId.
    stubHolder.stub.client.auth.getUser.mockImplementation(async () => ({
      data: { user: { id: mfaState.sessionUserId, factors: mfaState.totp } },
      error: null,
    }));
    Object.assign(
      stubHolder.stub.client.auth,
      verifiedSessionAuth(() => ({ sub: mfaState.sessionUserId, aal: mfaState.currentLevel })),
    );
    // The browser's own session, ended after a successful delete (walk B9).
    (stubHolder.stub.client.auth as unknown as { signOut: typeof cookieSignOut }).signOut =
      cookieSignOut;
    cookieSignOut.mockImplementation(async () => ({ error: null }));
    // No API keys, webhooks, links or subscriptions unless a test says so.
    adminTables.from = makeSupabaseStub().client.from;
  });

  it('rejects without the typed DELETE confirmation', async () => {
    const result = await deleteOwnAccountAction({ confirm: 'delete' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
  });

  // Rewritten by 0388 (was "soft-deletes the profile", asserting the
  // deleted_at tombstone and an audit() row BEFORE the delete): the action now
  // asks account_deletion_check first, writes nothing before the delete, and
  // writes the user.deactivated row only after it succeeded.
  it('checks first, deletes, then writes one user.deactivated row (user_id null); no tombstone', async () => {
    const order: string[] = [];
    adminRpc.mockImplementationOnce(async () => {
      order.push('check');
      return { data: { deletable: true }, error: null };
    });
    adminAuth.deleteUser.mockImplementationOnce(async () => {
      order.push('deleteUser');
      return { error: null };
    });
    insertAuditRowReportedMock.mockImplementationOnce(async () => {
      order.push('audit');
      return true;
    });
    avatarStorage.list.mockImplementationOnce(async () => {
      order.push('avatars');
      return { data: [], error: null };
    });
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result.ok).toBe(true);
    // Re-pinned by 0393 (was ['check', 'deleteUser', 'audit']): the avatar
    // files are removed once the account is gone, before the audit row.
    expect(order).toEqual(['check', 'deleteUser', 'avatars', 'audit']);
    expect(adminRpc).toHaveBeenCalledWith('account_deletion_check', { p_user_id: 'user-1' });
    // This browser's session ends too: the access token in the cookie outlives
    // the account (the proxy verifies it locally), and without this the
    // browser stayed signed in with no membership and landed on Create your
    // workspace (walk B9). Local scope: the account is gone, nothing to revoke.
    expect(cookieSignOut).toHaveBeenCalledTimes(1);
    expect(cookieSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(cookieSignOut.mock.invocationCallOrder[0]).toBeGreaterThan(
      adminAuth.deleteUser.mock.invocationCallOrder[0]!,
    );
    expect(adminAuth.deleteUser).toHaveBeenCalledWith('user-1');
    expect(stubHolder.stub!.chains.get('user_profiles.update')).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
    expect(insertAuditRowReportedMock).toHaveBeenCalledTimes(1);
    expect(insertAuditRowReportedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: 'org-1',
        user_id: null,
        event: 'user.deactivated',
        metadata: expect.objectContaining({
          entity_type: 'user',
          entity_id: 'user-1',
          reason: 'self_deletion',
        }),
        // 0393: the log reads "Deleted user" for this row, not "System".
        deleted_users: { user_id: expect.any(String) },
      }),
    );
  });

  it('removes the avatar files under user-avatars/<uid>/ after the delete (O-A3-9)', async () => {
    avatarStorage.list.mockImplementationOnce(async () => ({
      data: [{ name: 'avatar.webp' }, { name: 'old.png' }],
      error: null,
    }));
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result.ok).toBe(true);
    expect(avatarStorage.list).toHaveBeenCalledWith('user-1', { limit: 1000 });
    expect(avatarStorage.remove).toHaveBeenCalledWith(['user-1/avatar.webp', 'user-1/old.png']);
    expect(avatarStorage.list.mock.invocationCallOrder[0]).toBeGreaterThan(
      adminAuth.deleteUser.mock.invocationCallOrder[0]!,
    );
  });

  it('a failed avatar removal never changes the answer (the account is gone): reported, audit row still written', async () => {
    avatarStorage.list.mockImplementationOnce(async () => ({ data: null, error: { message: 'storage down' } }));
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result.ok).toBe(true);
    expect(insertAuditRowReportedMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'account.delete.avatar_list', level: 'warning' }),
    );
  });

  // O-A3-7 (0393): the platform console's operator account is refused in-app
  // while its email is on the allowlist; asked FIRST, before any read. The
  // email is the validated user's own, read by its id with the service role
  // (S50a), never from the cookie session.
  it('refuses a platform admin first, by the VERIFIED auth email, and changes nothing', async () => {
    adminAuth.getUserById.mockImplementationOnce(async () => ({
      data: { user: { id: 'user-1', email: 'platform-admin@example.test' } },
      error: null,
    }));
    platformAdmin.isPlatformAdmin.mockImplementationOnce(() => true);
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.message).toBe(
        'This account is a StockPilot platform admin. Remove it from the platform admin list before deleting it. Nothing was changed.',
      );
      expect((result.error.details as { reason?: string } | undefined)?.reason).toBe('platform_admin');
    }
    // Never the profile email the person can edit (session.email 'u@example.test').
    expect(platformAdmin.isPlatformAdmin).toHaveBeenCalledWith('platform-admin@example.test');
    expect(stubHolder.stub!.fromCalls).not.toContain('organization_members');
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(adminRpc).not.toHaveBeenCalled();
    expect(adminAuth.deleteUser).not.toHaveBeenCalled();
    expect(insertAuditRowReportedMock).not.toHaveBeenCalled();
    expect(avatarStorage.list).not.toHaveBeenCalled();
    expect(adminAuth.getUserById).toHaveBeenCalledWith('user-1');
    expect(platformAdmin.getVerifiedEmail).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the verified email cannot be read: try again, nothing changed', async () => {
    adminAuth.getUserById.mockImplementationOnce(async () => ({
      data: { user: null },
      error: { message: 'upstream unavailable', status: 503 },
    }));
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('internal_error');
      expect(result.error.message).toBe(
        'Your account could not be deleted right now. Nothing was changed. Try again in a minute.',
      );
    }
    expect(platformAdmin.isPlatformAdmin).not.toHaveBeenCalled();
    expect(adminRpc).not.toHaveBeenCalled();
    expect(adminAuth.deleteUser).not.toHaveBeenCalled();
    // Reported as the phone route reports it.
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tag: 'account.delete.platform_admin_check',
        extra: { source: 'web' },
      }),
    );
  });

  it('an account already gone at the platform-admin check: this browser is signed out, nothing deleted or written here', async () => {
    adminAuth.getUserById.mockImplementationOnce(async () => ({
      data: { user: null },
      error: {
        name: 'AuthApiError',
        status: 404,
        code: 'user_not_found',
        message: 'User not found',
      },
    }));
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result.ok).toBe(true);
    expect(adminRpc).not.toHaveBeenCalled();
    expect(adminAuth.deleteUser).not.toHaveBeenCalled();
    expect(insertAuditRowReportedMock).not.toHaveBeenCalled();
    expect(cookieSignOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  /**
   * S50a: immediately before the delete, assertStepUpHeld checks once more
   * that the verified session is the validated user's and owes no step-up, so
   * nothing read between the gate and the delete can stand in for it.
   */
  describe('the last check before the delete (S50a)', () => {
    it('runs after the database check and before the delete', async () => {
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(true);
      expect(adminAuth.listFactors).toHaveBeenCalledWith({ userId: 'user-1' });
      expect(adminAuth.listFactors.mock.invocationCallOrder[0]).toBeGreaterThan(
        adminRpc.mock.invocationCallOrder[0]!,
      );
      expect(adminAuth.listFactors.mock.invocationCallOrder[0]).toBeLessThan(
        adminAuth.deleteUser.mock.invocationCallOrder[0]!,
      );
    });

    it("a verified session that is not the validated user's: sign in again, nothing deleted or written", async () => {
      mfaState.sessionUserId = 'user-2';
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'unauthenticated',
          message: 'Sign in again, then try again.',
          details: { reason: 'session_changed' },
        },
      });
      expect(adminAuth.deleteUser).not.toHaveBeenCalled();
      expect(insertAuditRowReportedMock).not.toHaveBeenCalled();
      expect(cookieSignOut).not.toHaveBeenCalled();
      expect(revokeAllSessionsForUserMock).not.toHaveBeenCalled();
    });

    it('an authenticator still owed at aal1: refused with aal2_required, nothing deleted', async () => {
      mfaState.totp = [{ status: 'verified' }];
      mfaState.currentLevel = 'aal1';
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'forbidden', details: { reason: 'aal2_required' } },
      });
      expect(adminAuth.deleteUser).not.toHaveBeenCalled();
    });

    it('factors that cannot be read: refused, nothing deleted', async () => {
      adminAuth.listFactors.mockImplementationOnce(async () => ({
        data: null,
        error: { message: 'service unavailable' },
      }));
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result).toMatchObject({ ok: false, error: { code: 'internal_error' } });
      expect(adminAuth.deleteUser).not.toHaveBeenCalled();
    });

    it('an authenticator at aal2: deleted', async () => {
      mfaState.totp = [{ status: 'verified' }];
      mfaState.currentLevel = 'aal2';
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(true);
      expect(adminAuth.deleteUser).toHaveBeenCalledWith('user-1');
    });
  });

  it('a failed local sign-out after the delete still answers ok (the account is gone) and is reported', async () => {
    cookieSignOut.mockImplementationOnce(async () => {
      throw new Error('cookie store unavailable');
    });
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result.ok).toBe(true);
    expect(adminAuth.deleteUser).toHaveBeenCalledTimes(1);
    expect(insertAuditRowReportedMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'account.delete.local_signout_failed' }),
    );
  });

  it('a refused or failed delete never ends the browser session through this path', async () => {
    adminRpc.mockImplementationOnce(async () => ({
      data: { deletable: false, reason: 'blocked', sqlstate: '23503' },
      error: null,
    }));
    await deleteOwnAccountAction({ confirm: 'DELETE' });
    adminAuth.deleteUser.mockImplementationOnce(async () => ({ error: { message: 'boom' } }));
    await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(cookieSignOut).not.toHaveBeenCalled();
  });

  // Re-pinned by 0393 (was "linked to records your organization keeps"):
  // 0393 converted every refusing business key, so an integrity refusal now
  // is a record the census missed: the support sentence, reported as a warning.
  it('an integrity refusal (a record 0393 did not release) is refused with the support sentence and nothing is written', async () => {
    adminRpc.mockImplementationOnce(async () => ({
      data: {
        deletable: false,
        reason: 'blocked',
        sqlstate: '23503',
        constraint: 'po_imports_uploaded_by_fkey',
        table: 'public.po_imports',
      },
      error: null,
    }));
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('conflict');
      expect(result.error.message).toBe(
        'Your account could not be deleted because it is linked to a record that could not be released. Nothing was changed. Contact StockPilot support.',
      );
      expect((result.error.details as { reason?: string } | undefined)?.reason).toBe('account_linked_records');
    }
    expect(adminAuth.deleteUser).not.toHaveBeenCalled();
    expect(stubHolder.stub!.chains.get('user_profiles.update')).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
    expect(insertAuditRowReportedMock).not.toHaveBeenCalled();
    expect(revokeAllSessionsForUserMock).not.toHaveBeenCalled();
    // Reported with the constraint and table names only.
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tag: 'account.delete.blocked',
        level: 'warning',
        extra: expect.objectContaining({ constraint: 'po_imports_uploaded_by_fkey', table: 'public.po_imports' }),
      }),
    );
    expect(avatarStorage.list).not.toHaveBeenCalled();
    const extra = (reportErrorMock.mock.calls[0] as unknown[] | undefined)?.[1] as
      | { extra?: Record<string, unknown> }
      | undefined;
    expect(JSON.stringify(extra?.extra ?? {})).not.toContain('user-1');
  });

  it.each([['55P03'], ['40P01']])(
    'a row lock or a deadlock in the check (%s) says try again and changes nothing',
    async (sqlstate) => {
      adminRpc.mockImplementationOnce(async () => ({
        data: { deletable: false, reason: 'blocked', sqlstate, constraint: null, table: null },
        error: null,
      }));
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('internal_error');
        expect(result.error.message).toBe(
          'Your account could not be deleted right now. Nothing was changed. Try again in a minute.',
        );
      }
      expect(adminAuth.deleteUser).not.toHaveBeenCalled();
      expect(insertAuditRowReportedMock).not.toHaveBeenCalled();
    },
  );

  it('a failed check fails CLOSED: nothing deleted, nothing written, the failure reported', async () => {
    adminRpc.mockImplementationOnce(async () => ({ data: null, error: { code: '57014' } }));
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('internal_error');
    expect(adminAuth.deleteUser).not.toHaveBeenCalled();
    expect(insertAuditRowReportedMock).not.toHaveBeenCalled();
    expect(stubHolder.stub!.chains.get('user_profiles.update')).toBeUndefined();
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'account.delete.check_failed' }),
    );
  });

  it('an unknown answer from the check fails closed too', async () => {
    adminRpc.mockImplementationOnce(async () => ({ data: { reason: 'no_user' }, error: null }));
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result.ok).toBe(false);
    expect(adminAuth.deleteUser).not.toHaveBeenCalled();
  });

  it('is rate limited before the check (5 per 10 minutes per user)', async () => {
    checkRateLimitMock.mockImplementationOnce(async () => ({ allowed: false, count: 5, resetAt: 0 }));
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('rate_limited');
    expect(checkRateLimitMock).toHaveBeenCalledWith('account-delete:user-1', 5, 600_000);
    expect(adminRpc).not.toHaveBeenCalled();
    expect(adminAuth.deleteUser).not.toHaveBeenCalled();
  });

  // Re-pinned by 0393 (was 'forbidden' with "Transfer ownership ... before
  // deleting your account"): the only owner of an organization that has other
  // members is told which organization and what to do, as a conflict.
  it('refuses the only owner of an org with other members, naming it, before the rate limit and the check', async () => {
    let n = 0;
    stubHolder.stub = makeSupabaseStub({
      'organization_members.select': () => {
        n += 1;
        return n === 1
          ? { data: [{ organization_id: 'org-1' }], error: null } // the owner's own row
          : { data: [{ organization_id: 'org-1', role: 'staff' }], error: null }; // another member
      },
      'organizations.select': { data: [{ id: 'org-1', name: 'Learn4Life' }], error: null },
      'user_profiles.update': { data: null, error: null },
    });
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('conflict');
      expect(result.error.message).toBe(
        'You are the only owner of Learn4Life. On the Team page, choose Transfer ownership on another member, or remove the other members, then delete your account. Nothing was changed.',
      );
      expect((result.error.details as { reason?: string } | undefined)?.reason).toBe('last_owner');
    }
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(adminRpc).not.toHaveBeenCalled();
    expect(adminAuth.deleteUser).not.toHaveBeenCalled();
    expect(insertAuditRowReportedMock).not.toHaveBeenCalled();
  });

  it('an owner whose organization has a second owner is not refused (the trigger agrees)', async () => {
    let n = 0;
    stubHolder.stub = makeSupabaseStub({
      'organization_members.select': () => {
        n += 1;
        return n === 1
          ? { data: [{ organization_id: 'org-1' }], error: null }
          : {
              data: [
                { organization_id: 'org-1', role: 'owner' },
                { organization_id: 'org-1', role: 'staff' },
              ],
              error: null,
            };
      },
      'user_profiles.update': { data: null, error: null },
    });
    (stubHolder.stub.client.auth as unknown as { signOut: typeof cookieSignOut }).signOut = cookieSignOut;
    // The last check before the delete reads the verified session (S50a).
    Object.assign(
      stubHolder.stub.client.auth,
      verifiedSessionAuth(() => ({ sub: mfaState.sessionUserId, aal: mfaState.currentLevel })),
    );
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result.ok).toBe(true);
    expect(adminAuth.deleteUser).toHaveBeenCalledWith('user-1');
  });

  // The account trigger is the backstop for a member who joins between the
  // app's read and the delete (0393): the generic sentence, nothing changed.
  it('the check answering last owner (a member joined in between) refuses with the generic sentence', async () => {
    adminRpc.mockImplementationOnce(async () => ({
      data: {
        deletable: false,
        reason: 'blocked',
        sqlstate: 'P0001',
        constraint: 'organization_last_owner',
        table: 'public.organization_members',
      },
      error: null,
    }));
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('conflict');
      expect(result.error.message).toBe(
        'You are the only owner of an organization that has other members. On the Team page, choose Transfer ownership on another member, or remove the other members, then delete your account. Nothing was changed.',
      );
      expect((result.error.details as { reason?: string } | undefined)?.reason).toBe('last_owner');
    }
    expect(adminAuth.deleteUser).not.toHaveBeenCalled();
    expect(insertAuditRowReportedMock).not.toHaveBeenCalled();
    expect(avatarStorage.list).not.toHaveBeenCalled();
    expect(cookieSignOut).not.toHaveBeenCalled();
  });

  // Fails CLOSED: a failed owned-orgs or other-members read used to read as
  // "owns nothing" / "no other members" and the account was deleted out from
  // under an org that still had people in it.
  it.each([
    ['owned-orgs', 1],
    ['other-members', 2],
  ])('a failed %s read refuses the delete with a plain sentence, reports it and changes nothing', async (_label, failAt) => {
    let n = 0;
    stubHolder.stub = makeSupabaseStub({
      'organization_members.select': () => {
        n += 1;
        if (n === failAt) return { data: null, error: { message: 'fetch failed' } };
        return { data: [{ organization_id: 'org-1' }], error: null };
      },
      'user_profiles.update': { data: null, error: null },
    });
    const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('internal_error');
      // A3 review: the raw PostgREST message reached the toast and nothing was
      // reported; the phone route already said this sentence and reported it.
      expect(result.error.message).toBe('Could not check the organizations you own. Nothing was deleted. Try again.');
      expect(result.error.message).not.toContain('fetch failed');
    }
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'fetch failed' }),
      expect.objectContaining({ tag: 'account.delete.owner_check', extra: { source: 'web' } }),
    );
    expect(stubHolder.stub.chains.get('user_profiles.update')).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
    expect(adminRpc).not.toHaveBeenCalled();
    expect(insertAuditRowReportedMock).not.toHaveBeenCalled();
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

    // Rewritten by 0388 (was: asserted the tombstone and an audit() row, which
    // audit()'s organization gate then dropped for a person with no org): the
    // row is now written after the delete with organization_id null.
    it('deletes the account instead of dying on the org gate, and still writes the audit row', async () => {
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(true);
      expect(stubHolder.stub!.chains.get('user_profiles.update')).toBeUndefined();
      expect(adminAuth.deleteUser).toHaveBeenCalledWith('user-1');
      expect(insertAuditRowReportedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: null,
          user_id: null,
          event: 'user.deactivated',
          metadata: expect.objectContaining({ entity_id: 'user-1', reason: 'self_deletion' }),
        }),
      );
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
      stubHolder.stub!.client.auth.getUser.mockImplementation(async () => {
        throw new Error('network');
      });
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('forbidden');
      expect(adminAuth.deleteUser).not.toHaveBeenCalled();
    });

    // S50a: the posture is this person's own: their factor list and their
    // verified level, each held to the user requireSession() validated.
    it("a factor list that is not the validated user's: sign in again, nothing deleted", async () => {
      mfaState.sessionUserId = 'user-2';
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'unauthenticated',
          message: 'Sign in again, then try again.',
          details: { reason: 'session_changed' },
        },
      });
      expect(adminAuth.deleteUser).not.toHaveBeenCalled();
    });

    it("an enrolled user whose verified level is not their own session's is not at aal2", async () => {
      mfaState.totp = [{ status: 'verified' }];
      mfaState.currentLevel = 'aal2';
      stubHolder.stub!.client.auth.getSession = verifiedSessionAuth(() => ({
        sub: 'user-2',
        aal: 'aal2',
      })).getSession;
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'forbidden', details: { reason: 'aal2_required' } },
      });
      expect(adminAuth.deleteUser).not.toHaveBeenCalled();
    });

    it('reads neither listFactors() nor the unverified level', async () => {
      mfaState.totp = [{ status: 'verified' }];
      mfaState.currentLevel = 'aal2';
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(true);
      expect(stubHolder.stub!.client.auth.mfa.listFactors).not.toHaveBeenCalled();
      expect(
        stubHolder.stub!.client.auth.mfa.getAuthenticatorAssuranceLevel,
      ).not.toHaveBeenCalled();
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

  /**
   * The action reads the person's memberships twice: once at the top, and once
   * before the delete. A list that cannot be read is not "no workspace":
   * nothing is deleted and the person is asked to try again.
   */
  describe('a membership list that cannot be read', () => {
    it('the first read: nothing is deleted or written, try again', async () => {
      authState.membershipsUnreadableAt = 1;
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result).toEqual(err('internal_error', ACCOUNT_DELETE_RETRY_COPY));
      expect(adminAuth.deleteUser).not.toHaveBeenCalled();
      expect(checkRateLimitMock).not.toHaveBeenCalled();
      expect(insertAuditRowReportedMock).not.toHaveBeenCalled();
      expect(revokeAllSessionsForUserMock).not.toHaveBeenCalled();
      expect(reportErrorMock).toHaveBeenCalledTimes(1);
      expect(reportErrorMock).toHaveBeenCalledWith(expect.any(Error), {
        tag: 'account.delete.membership_read',
        extra: { source: 'web' },
      });
    });

    it('the second read: nothing is deleted or written, try again', async () => {
      authState.membershipsUnreadableAt = 2;
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result).toEqual(err('internal_error', ACCOUNT_DELETE_RETRY_COPY));
      expect(adminAuth.deleteUser).not.toHaveBeenCalled();
      expect(adminRpc).not.toHaveBeenCalled();
      expect(insertAuditRowReportedMock).not.toHaveBeenCalled();
      // This read comes after the limiter, which counted the attempt.
      expect(checkRateLimitMock).toHaveBeenCalledTimes(1);
      expect(reportErrorMock).toHaveBeenCalledTimes(1);
      expect(reportErrorMock).toHaveBeenCalledWith(expect.any(Error), {
        tag: 'account.delete.membership_read',
        extra: { source: 'web' },
      });
    });

    it('control: a member whose list reads is deleted and the row is filed under their organization', async () => {
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(true);
      expect(authState.membershipReads).toBe(2);
      expect(insertAuditRowReportedMock).toHaveBeenCalledWith(
        expect.objectContaining({ organization_id: 'org-1', event: 'user.deactivated' }),
      );
    });

    it('control: a person with no workspace is deleted and the row has no organization (SP-129)', async () => {
      authState.orgLess = true;
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(true);
      expect(authState.membershipReads).toBe(2);
      expect(insertAuditRowReportedMock).toHaveBeenCalledWith(
        expect.objectContaining({ organization_id: null, event: 'user.deactivated' }),
      );
    });
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
        expect(result.error.message).toBe(
          'Your account could not be deleted right now. You have been signed out; nothing else changed. Try again in a minute.',
        );
      }
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it('writes no audit row and no tombstone (0388: nothing is written before the delete)', async () => {
      await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(insertAuditRowReportedMock).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
      expect(stubHolder.stub!.chains.get('user_profiles.update')).toBeUndefined();
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

  /**
   * Review R7 (2026-10-03): deleteUser can answer an error although the
   * account is gone (a lost reply after GoTrue committed; or the person's
   * phone deleted it first, so this DELETE found no user). The person used to
   * be told "could not be deleted" and no audit row was written. Now the
   * action asks GoTrue again and answers the truth.
   */
  describe('when deleteUser errors but the account is gone (review R7)', () => {
    const NOT_FOUND = { name: 'AuthApiError', status: 404, code: 'user_not_found', message: 'User not found' };

    it('a lost reply, then GoTrue has no such user: success, the audit row, and this browser signed out', async () => {
      adminAuth.deleteUser.mockImplementationOnce(async () => ({
        error: { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' },
      }));
      // The platform-admin check reads the account first (S50a); the second
      // read is the one after the failed delete.
      adminAuth.getUserById
        .mockImplementationOnce(async () => ({ data: { user: { id: 'user-1' } }, error: null }))
        .mockImplementationOnce(async () => ({ data: { user: null }, error: NOT_FOUND }));
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(true);
      expect(adminAuth.getUserById).toHaveBeenCalledWith('user-1');
      expect(insertAuditRowReportedMock).toHaveBeenCalledTimes(1);
      expect(insertAuditRowReportedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'user.deactivated',
          user_id: null,
          metadata: expect.objectContaining({ entity_id: 'user-1', reason: 'self_deletion' }),
        }),
      );
      expect(cookieSignOut).toHaveBeenCalledWith({ scope: 'local' });
      expect(revokeAllSessionsForUserMock).not.toHaveBeenCalled();
      expect(reportErrorMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tag: 'account.delete.auth_delete_error_but_gone', level: 'warning' }),
      );
      expect(reportErrorMock).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tag: 'account.delete.auth_delete_failed' }),
      );
    });

    // Only the gap between the last check's factor read (S50a) and the delete:
    // the other request deleted the account after GoTrue listed its factors.
    // Deleted any earlier, the factor read itself answers 404 (the next case).
    it('deleted by another request after the last check read its factors (404 user_not_found to the delete): success, no second audit row', async () => {
      adminAuth.deleteUser.mockImplementationOnce(async () => ({ error: NOT_FOUND }));
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(true);
      expect(adminAuth.listFactors).toHaveBeenCalledTimes(1);
      // The platform-admin check's read only (S50a): the delete's own answer
      // settles it, so GoTrue is not asked again.
      expect(adminAuth.getUserById).toHaveBeenCalledTimes(1);
      expect(insertAuditRowReportedMock).not.toHaveBeenCalled();
      // The request that deleted it removes the avatar files (0393).
      expect(avatarStorage.list).not.toHaveBeenCalled();
      expect(cookieSignOut).toHaveBeenCalledWith({ scope: 'local' });
      expect(revokeAllSessionsForUserMock).not.toHaveBeenCalled();
    });

    // The likeliest way to meet the deletion: both requests pass their checks
    // (each check is rolled back before its delete), the other one deletes,
    // and this one's next GoTrue call is the last check's factor read. GoTrue
    // answers every /admin/users/<id> route, the factor list included, with
    // 404 user_not_found once the user is gone.
    it('deleted by another request before the last check read its factors (404 user_not_found there): success, this browser signed out, nothing deleted or written here', async () => {
      adminAuth.listFactors.mockImplementationOnce(async () => ({ data: null, error: NOT_FOUND }));
      // Not Once: a queued answer the action never asks for would carry over
      // to the next test (clearAllMocks keeps it); the top-level beforeEach
      // resets this one.
      adminAuth.deleteUser.mockImplementation(async () => ({ error: NOT_FOUND }));
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result).toEqual({ ok: true, data: undefined });
      expect(adminAuth.listFactors).toHaveBeenCalledWith({ userId: 'user-1' });
      expect(adminAuth.deleteUser).not.toHaveBeenCalled();
      expect(insertAuditRowReportedMock).not.toHaveBeenCalled();
      expect(avatarStorage.list).not.toHaveBeenCalled();
      expect(cookieSignOut).toHaveBeenCalledTimes(1);
      expect(cookieSignOut).toHaveBeenCalledWith({ scope: 'local' });
      expect(revokeAllSessionsForUserMock).not.toHaveBeenCalled();
      // Not an outage: the factors were not "unreadable".
      expect(reportErrorMock).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tag: 'auth.step_up_held.factors_unreadable' }),
      );
    });

    // The same race when getClaims() cannot check the token locally (the key
    // set could not be fetched): the session's token is then checked by GoTrue,
    // which answers 403 user_not_found for a deleted account, so the last check
    // finds no session of the account. GoTrue is asked whether the account
    // still exists before "sign in again" is said.
    it('deleted by another request during the check, while GoTrue checks the token: success, this browser signed out, nothing deleted or written here', async () => {
      adminRpc.mockImplementationOnce(async () => {
        const auth = stubHolder.stub!.client.auth as unknown as Record<string, unknown>;
        auth.getClaims = async () => ({
          data: null,
          error: { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' },
        });
        auth.getUser = async () => ({
          data: { user: null },
          error: {
            name: 'AuthApiError',
            status: 403,
            code: 'user_not_found',
            message: 'User from sub claim in JWT does not exist',
          },
        });
        return { data: { deletable: true }, error: null };
      });
      // The platform-admin check finds the account; it is gone after that.
      // (Not Once: see above.)
      let reads = 0;
      adminAuth.getUserById.mockImplementation(async () =>
        ++reads === 1
          ? { data: { user: { id: 'user-1' } }, error: null }
          : { data: { user: null }, error: NOT_FOUND },
      );
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result).toEqual({ ok: true, data: undefined });
      expect(adminAuth.getUserById).toHaveBeenCalledTimes(2);
      expect(adminAuth.getUserById).toHaveBeenNthCalledWith(2, 'user-1');
      expect(adminAuth.listFactors).not.toHaveBeenCalled();
      expect(adminAuth.deleteUser).not.toHaveBeenCalled();
      expect(insertAuditRowReportedMock).not.toHaveBeenCalled();
      expect(cookieSignOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    it('no session of the account at the last check, and GoTrue cannot say whether it exists: sign in again, nothing deleted or signed out', async () => {
      adminRpc.mockImplementationOnce(async () => {
        mfaState.sessionUserId = 'user-2';
        return { data: { deletable: true }, error: null };
      });
      let reads = 0;
      adminAuth.getUserById.mockImplementation(async () =>
        ++reads === 1
          ? { data: { user: { id: 'user-1' } }, error: null }
          : { data: { user: null }, error: { message: 'upstream unavailable', status: 503 } },
      );
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'unauthenticated',
          message: 'Sign in again, then try again.',
          details: { reason: 'session_changed' },
        },
      });
      expect(adminAuth.deleteUser).not.toHaveBeenCalled();
      expect(cookieSignOut).not.toHaveBeenCalled();
    });

    it('the check finds no such account (deleted from another device): success, nothing deleted or written here', async () => {
      adminRpc.mockImplementationOnce(async () => ({
        data: { deletable: false, reason: 'not_found' },
        error: null,
      }));
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(true);
      expect(adminAuth.deleteUser).not.toHaveBeenCalled();
      expect(insertAuditRowReportedMock).not.toHaveBeenCalled();
      expect(cookieSignOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    it('a lost reply while the account is still there keeps the failure answer (SP-008)', async () => {
      adminAuth.deleteUser.mockImplementationOnce(async () => ({
        error: { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' },
      }));
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('internal_error');
      expect(insertAuditRowReportedMock).not.toHaveBeenCalled();
      expect(revokeAllSessionsForUserMock).toHaveBeenCalledWith('user-1');
      expect(cookieSignOut).not.toHaveBeenCalled();
    });
  });

  describe('what the deletion leaves for review (O-A3-5, O-A3-2)', () => {
    it("O-A3-5: the user.deactivated row records the organization's API keys, webhooks and links the person created that keep working", async () => {
      adminTables.from = makeSupabaseStub({
        'api_keys.select': { data: null, error: null, count: 1 },
        'integration_endpoints.select': { data: null, error: null, count: 0 },
        'public_request_links.select': { data: null, error: null, count: 2 },
        'maintenance_request_share_links.select': { data: null, error: null, count: 3 },
      }).client.from;
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(true);
      expect(insertAuditRowReportedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: 'org-1',
          metadata: expect.objectContaining({
            created_still_active: { api_keys: 1, webhooks: 0, public_request_links: 2, share_links: 3 },
          }),
        }),
      );
    });

    it('O-A3-2: the only member of an organization with a Stripe subscription: the platform admin is told (info) after the delete', async () => {
      adminTables.from = makeSupabaseStub({
        'organization_members.select': (call) =>
          call.methods.includes('neq')
            ? { data: [], error: null }
            : { data: [{ organization_id: 'org-solo' }], error: null },
        'organizations.select': { data: [{ id: 'org-solo' }], error: null },
      }).client.from;
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(true);
      expect(reportErrorMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tag: 'account.delete.solo_owner_subscription',
          level: 'info',
          extra: { source: 'web', organizationIds: 'org-solo' },
        }),
      );
    });

    it('O-A3-2: nothing is reported when the delete fails (the organization keeps its owner)', async () => {
      adminTables.from = makeSupabaseStub({
        'organization_members.select': (call) =>
          call.methods.includes('neq')
            ? { data: [], error: null }
            : { data: [{ organization_id: 'org-solo' }], error: null },
        'organizations.select': { data: [{ id: 'org-solo' }], error: null },
      }).client.from;
      adminAuth.deleteUser.mockImplementationOnce(async () => ({ error: { message: 'Invalid API key' } }));
      await deleteOwnAccountAction({ confirm: 'DELETE' });
      const tags = reportErrorMock.mock.calls.map((c) => (c as unknown[])[1] as { tag?: string } | undefined);
      expect(tags.map((t) => t?.tag)).not.toContain('account.delete.solo_owner_subscription');
    });
  });

  describe('a member joins between the check and the delete (desk check F-5)', () => {
    it('the last-owner sentence, the sessions are kept, nothing is written', async () => {
      // The account trigger refuses inside GoTrue's delete (a 500); the
      // account is still there, and the re-check now answers last_owner.
      adminAuth.deleteUser.mockImplementationOnce(async () => ({
        error: { name: 'AuthApiError', status: 500, message: 'Database error deleting user' },
      }));
      adminRpc
        .mockImplementationOnce(async () => ({ data: { deletable: true }, error: null }))
        .mockImplementationOnce(async () => ({
          data: {
            deletable: false,
            reason: 'blocked',
            sqlstate: 'P0001',
            constraint: 'organization_last_owner',
            table: 'public.organization_members',
          },
          error: null,
        }));
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('conflict');
        expect(result.error.message).toBe(ACCOUNT_DELETE_LAST_OWNER_COPY);
      }
      expect(adminRpc).toHaveBeenCalledTimes(2);
      expect(revokeAllSessionsForUserMock).not.toHaveBeenCalled();
      expect(insertAuditRowReportedMock).not.toHaveBeenCalled();
      expect(cookieSignOut).not.toHaveBeenCalled();
      expect(avatarStorage.list).not.toHaveBeenCalled();
    });

    // Re-pinned by 0458 (the re-check answered deletable here, which now
    // means "try again"): a re-check that cannot answer keeps SP-008.
    it('a re-check that cannot answer keeps SP-008 (sessions revoked, the signed-out sentence)', async () => {
      adminAuth.deleteUser.mockImplementationOnce(async () => ({
        error: { name: 'AuthApiError', status: 500, message: 'Database error deleting user' },
      }));
      adminRpc
        .mockImplementationOnce(async () => ({ data: { deletable: true }, error: null }))
        .mockImplementationOnce(async () => ({ data: null, error: { code: 'PGRST301' } }));
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe(ACCOUNT_DELETE_SIGNED_OUT_COPY);
      expect(revokeAllSessionsForUserMock).toHaveBeenCalledWith('user-1');
    });

    // Migration 0458: the owner check runs at the auth server's commit and
    // can answer busy (55P03, another change to the organization's owners
    // was being saved); the auth server answers a 500 and the account stays.
    // The re-check then answers deletable (or a lock to retry): nothing
    // changed, the database is reachable, so the person is told to try again
    // and stays signed in, as for the check's own retry answer.
    it.each([
      { recheck: { data: { deletable: true }, error: null }, name: 'deletable' },
      { recheck: { data: { deletable: false, reason: 'blocked', sqlstate: '55P03' }, error: null }, name: 'a busy lock' },
    ])('a re-check that answers $name: try again, the sessions are kept, nothing is written', async ({ recheck }) => {
      adminAuth.deleteUser.mockImplementationOnce(async () => ({
        error: { name: 'AuthApiError', status: 500, message: 'Database error deleting user' },
      }));
      adminRpc
        .mockImplementationOnce(async () => ({ data: { deletable: true }, error: null }))
        .mockImplementationOnce(async () => recheck);
      const result = await deleteOwnAccountAction({ confirm: 'DELETE' });
      expect(result).toEqual(err('internal_error', ACCOUNT_DELETE_RETRY_COPY));
      expect(adminRpc).toHaveBeenCalledTimes(2);
      expect(revokeAllSessionsForUserMock).not.toHaveBeenCalled();
      expect(cookieSignOut).not.toHaveBeenCalled();
      expect(insertAuditRowReportedMock).not.toHaveBeenCalled();
      expect(avatarStorage.list).not.toHaveBeenCalled();
      expect(reportErrorMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tag: 'account.delete.auth_delete_transient', level: 'warning' }),
      );
      expect(reportErrorMock).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tag: 'account.delete.auth_delete_failed' }),
      );
    });
  });
});
