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
const { logoStorage, fetchObjectPrefixMock } = vi.hoisted(() => ({
  logoStorage: {
    body: null as Uint8Array | null,
    remove: vi.fn(),
  },
  fetchObjectPrefixMock: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    auth: {
      admin: {
        deleteUser: vi.fn(async () => ({ error: null })),
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
