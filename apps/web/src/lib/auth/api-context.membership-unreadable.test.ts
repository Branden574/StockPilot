import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SECURITY TEST: which organization an API request is served in when the
 * membership choice cannot be read (lib/auth/api-context.ts
 * pickActiveMembership, both sign-in paths).
 *
 * The real withApiContext runs on its legacy reads (the one-round-trip context
 * read fails) over the shared database double (src/test/legacy-api-context.ts).
 * The choice takes up to three reads: the membership in the organization the
 * request names (X-Organization-Id), or else the profile's default
 * organization and the membership in it, and last the oldest membership.
 *
 *   - A read that does not answer (an error, a thrown call, a row without the
 *     columns asked for, or an answer with neither a list nor an error: an
 *     empty or `null` body, a 404 with no body, a non-2xx whose body is `null`)
 *     refuses the request with MembershipUnavailableError, a retryable 5xx,
 *     and no context is built.
 *   - A read that answers "no row" is still an answer: no membership in the
 *     named organization or no membership at all is null (401), as before; no
 *     profile row, no default, or a default without a membership falls to the
 *     oldest membership, as before. "No row" is an empty list answered with
 *     status 200.
 *   - When the account-status read fails too, its own refusal is the one
 *     thrown; a disabled account is null whatever the membership reads say.
 */

const refs = vi.hoisted(() => ({
  client: null as unknown,
  /** Made-up values: the client double ignores both. */
  projectUrl: 'https://example.supabase.co',
  publicValue: 'test-public-value',
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: refs.projectUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: refs.publicValue,
  },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => refs.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => refs.client }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import {
  legacyBearerToken,
  legacyContextClient,
  legacyContextWorld,
  LEGACY_ORG_ID,
  READ_FAILURES,
  type LegacyContextWorld,
} from '@/test/legacy-api-context';

import { withApiContext } from './api-context';

/** The refusal (lib/auth/membership-unavailable.ts), matched by name and code. */
const REFUSED = { name: 'MembershipUnavailableError', code: 'MEMBERSHIP_UNAVAILABLE' };

/** Made-up organizations: OLDEST is the person's first membership, DEFAULT their chosen one. */
const OLDEST = '77777777-0000-4000-8000-00000000000a';
const DEFAULT = LEGACY_ORG_ID;
const STRANGER = '66666666-0000-4000-8000-00000000000b';

let world: LegacyContextWorld;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  world = legacyContextWorld({
    role: 'manager',
    memberships: [
      { organization_id: OLDEST, role: 'staff' },
      { organization_id: DEFAULT, role: 'manager' },
    ],
    defaultOrganizationId: DEFAULT,
  });
  refs.client = legacyContextClient(world);
});

type Path = 'phone' | 'cookie';

/** A request on one sign-in path, naming an organization or not. */
function request(path: Path, orgHeader: string | null): Request {
  const headers: Record<string, string> =
    path === 'phone'
      ? { authorization: `Bearer ${legacyBearerToken()}` }
      : { cookie: 'sb-example-auth-token=made-up-cookie' };
  if (orgHeader !== null) headers['x-organization-id'] = orgHeader;
  return new Request('https://app.example.test/api/v1/example', { headers });
}

const PATHS: Path[] = ['phone', 'cookie'];
const HOW = READ_FAILURES;

/** The organization the context carries, or null for the 401 answer. */
async function servedIn(path: Path, orgHeader: string | null): Promise<string | null> {
  const ctx = await withApiContext(request(path, orgHeader));
  return ctx?.organizationId ?? null;
}

describe.each(PATHS)('a membership read that answers (%s path)', (path) => {
  it('a member naming an organization is served in it', async () => {
    expect(await servedIn(path, OLDEST)).toBe(OLDEST);
    expect(await servedIn(path, DEFAULT)).toBe(DEFAULT);
  });

  it('the organization header is matched whatever its case', async () => {
    expect(await servedIn(path, OLDEST.toUpperCase())).toBe(OLDEST);
  });

  it('a member naming no organization is served in the default organization', async () => {
    expect(await servedIn(path, null)).toBe(DEFAULT);
  });

  it('no default organization: the oldest membership', async () => {
    world.defaultOrganizationId = null;
    expect(await servedIn(path, null)).toBe(OLDEST);
  });

  it('no profile row: the oldest membership', async () => {
    world.profileMissing = true;
    expect(await servedIn(path, null)).toBe(OLDEST);
  });

  it('a default organization the person is no longer a member of: the oldest membership', async () => {
    world.defaultOrganizationId = STRANGER;
    expect(await servedIn(path, null)).toBe(OLDEST);
  });

  it('an organization the person is not a member of: null (401)', async () => {
    expect(await servedIn(path, STRANGER)).toBeNull();
  });

  it('no membership at all: null (401)', async () => {
    world.memberships = [];
    expect(await servedIn(path, null)).toBeNull();
    expect(await servedIn(path, DEFAULT)).toBeNull();
  });

  it('a disabled account: null (401)', async () => {
    world.disabledAt = '2026-01-01T00:00:00Z';
    expect(await servedIn(path, DEFAULT)).toBeNull();
    expect(await servedIn(path, null)).toBeNull();
  });

  it.each([
    ['not an organization id', 'not-an-organization'],
    ['in braces', `{${DEFAULT}}`],
    ['without hyphens', DEFAULT.replace(/-/g, '')],
  ])('an organization header %s: null (401), and no membership read', async (_how, header) => {
    expect(await servedIn(path, header)).toBeNull();
    expect(world.calls).not.toContain('from:organization_members');
  });

  it('an invite not yet accepted is no membership', async () => {
    world.memberships = [
      { organization_id: OLDEST, role: 'staff' },
      { organization_id: DEFAULT, role: 'manager', accepted: false },
    ];
    // Named: not a member there.
    expect(await servedIn(path, DEFAULT)).toBeNull();
    // Default pointing at the invite: the oldest accepted membership.
    expect(await servedIn(path, null)).toBe(OLDEST);
    // Only the invite: no membership at all.
    world.memberships = [{ organization_id: DEFAULT, role: 'manager', accepted: false }];
    expect(await servedIn(path, null)).toBeNull();
  });
});

describe.each(PATHS)('a membership read that does not answer (%s path)', (path) => {
  it.each(HOW)(
    'the membership in the named organization (%s): refused with a retry, never 401',
    async (how) => {
      world.membershipReadFails = { read: 'named', orgId: DEFAULT, how };
      await expect(withApiContext(request(path, DEFAULT))).rejects.toMatchObject(REFUSED);
    },
  );

  it.each(HOW)(
    'the profile default organization (%s): refused with a retry, and no context is built',
    async (how) => {
      world.membershipReadFails = { read: 'profile', how };
      await expect(withApiContext(request(path, null))).rejects.toMatchObject(REFUSED);
      // Nothing was read for an organization: the context stopped at the choice.
      expect(world.calls).not.toContain('from:organization_modules');
    },
  );

  it.each(HOW)(
    'the membership in the default organization (%s): refused with a retry, and no context is built',
    async (how) => {
      world.membershipReadFails = { read: 'named', orgId: DEFAULT, how };
      await expect(withApiContext(request(path, null))).rejects.toMatchObject(REFUSED);
      expect(world.calls).not.toContain('from:organization_modules');
    },
  );

  it.each(HOW)('the oldest membership (%s): refused with a retry, never 401', async (how) => {
    world.defaultOrganizationId = null;
    world.membershipReadFails = { read: 'oldest', how };
    await expect(withApiContext(request(path, null))).rejects.toMatchObject(REFUSED);
  });

  it('the refusal carries one fixed sentence and a code, never the read text', async () => {
    world.membershipReadFails = { read: 'profile', how: 'error' };
    const e = await withApiContext(request(path, null)).catch((err: unknown) => err);
    expect(e).toMatchObject({
      ...REFUSED,
      message: 'Your access could not be checked. Please try again.',
    });
  });

  it('a disabled account is the 401 every disabled account gets, whatever the membership reads answered', async () => {
    world.disabledAt = '2026-01-01T00:00:00Z';
    world.membershipReadFails = { read: 'named', orgId: DEFAULT, how: 'error' };
    expect(await servedIn(path, DEFAULT)).toBeNull();
    world.membershipReadFails = { read: 'profile', how: 'error' };
    expect(await servedIn(path, null)).toBeNull();
  });

  it('the account-status read fails too: its own refusal is the one thrown', async () => {
    world.accountStatusFails = true;
    world.membershipReadFails = { read: 'named', orgId: DEFAULT, how: 'error' };
    await expect(withApiContext(request(path, DEFAULT))).rejects.toMatchObject({
      name: 'AccountStatusUnavailableError',
    });
    world.membershipReadFails = { read: 'profile', how: 'no_body' };
    await expect(withApiContext(request(path, null))).rejects.toMatchObject({
      name: 'AccountStatusUnavailableError',
    });
  });

  it('a failed read for an organization the request does not use changes nothing', async () => {
    // The oldest-membership read is never reached for a member of the default.
    world.membershipReadFails = { read: 'oldest', how: 'error' };
    expect(await servedIn(path, null)).toBe(DEFAULT);
    // Nor is the profile read reached when the request names an organization.
    world.membershipReadFails = { read: 'profile', how: 'error' };
    expect(await servedIn(path, OLDEST)).toBe(OLDEST);
  });
});
