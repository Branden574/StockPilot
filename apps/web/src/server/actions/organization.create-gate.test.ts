import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: only a platform admin creates a workspace (owner
 * decision b.9, docket S20).
 *
 * createOrganizationAction is a Server Action, and a Server Action is a public
 * POST endpoint: anyone signed in can call it without the /onboarding form,
 * and Next.js runs a posted action before the page could redirect anyone. It
 * used to check only that the caller was signed in, then wrote the
 * organization, an owner seat for the caller, their default organization and
 * a Main Warehouse with the service role. So any account, a member of any
 * workspace in any role included, could create workspaces without limit. It
 * now runs checkPlatformAdmin({ requireStepUp: true }) first, the check
 * Platform > Provision runs: the VERIFIED sign-in email on the deploy-time
 * allowlist, the session at AAL2, and an authenticator code from the last 15
 * minutes.
 *
 * The check under test is the REAL one (recurring pattern 23: never mock away
 * the check under test). The real server client and auth-js run against the
 * fixture's ES256 keys and Auth server (src/test/auth-session-fixture.ts),
 * with the cookie jar through next/headers and a per-test allowlist, as in
 * lib/auth/platform-admin.gates.test.ts. Only the session loader (each
 * caller's profile and role), the service-role client and the two audit
 * writers are stand-ins.
 */

const h = vi.hoisted(() => ({
  /** The allowlist (STOCKPILOT_PLATFORM_ADMIN_EMAILS) for this test. */
  allowlist: '',
  /** What the session loader answers; null = signed out. */
  session: null as null | {
    userId: string;
    email: string;
    fullName: string | null;
    avatarUrl: string | null;
    defaultOrganizationId: string | null;
  },
  /** The caller's role in a workspace; null = no accepted membership. */
  role: null as null | string,
  /** The service-role client the action receives. */
  adminClient: null as unknown,
}));

let jar = new Map<string, string>();
vi.mock('next/headers', async () => {
  const { cookieStoreOver } = await import('@/test/auth-session-fixture');
  return { cookies: async () => cookieStoreOver(jar), headers: async () => new Headers() };
});
vi.mock('@/lib/env', async () => {
  const f = await import('@/test/auth-session-fixture');
  return {
    env: {
      NEXT_PUBLIC_SUPABASE_URL: f.FIXTURE_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: f.FIXTURE_ANON_KEY,
      get STOCKPILOT_PLATFORM_ADMIN_EMAILS() {
        return h.allowlist;
      },
    },
  };
});

/** Next.js carries redirect() as a thrown error with this digest. */
function redirectError(to: string): Error {
  return Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${to};307;` });
}

function orgContext() {
  if (!h.session) throw redirectError('/signin');
  // requireOrgContext sends an account with no accepted membership to /onboarding.
  if (!h.role) throw redirectError('/onboarding');
  return {
    ...h.session,
    organizationId: '33333333-3333-4333-8333-333333333333',
    organizationName: 'Member Workspace',
    role: h.role,
  };
}

vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => {
    if (!h.session) throw redirectError('/signin');
    return h.session;
  }),
  // Each caller's role, so a later gate keyed on the role would still be
  // reached by these tests.
  requireOrgContext: vi.fn(async () => orgContext()),
}));
vi.mock('@/server/services/context', () => {
  class ServiceError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { ServiceError, withContext: vi.fn(async () => orgContext()) };
});
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => h.adminClient),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => {}),
  insertAuditRowReported: vi.fn(async () => true),
}));
vi.mock('@/server/services/platform/audit', () => ({
  recordPlatformAudit: vi.fn(async () => true),
}));

import { revalidatePath } from 'next/cache';

import { createAdminClient } from '@/lib/supabase/admin';
import { insertAuditRowReported } from '@/server/services/audit';
import { recordPlatformAudit } from '@/server/services/platform/audit';
import {
  FIXTURE_EMAIL,
  FIXTURE_USER_ID,
  fakeAuthServer,
  makeSigningKey,
  sessionClaims,
  sessionCookies,
  signAccessToken,
  type FakeAuthServer,
  type SessionClaimsInput,
  type SigningKey,
} from '@/test/auth-session-fixture';
import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

import { createOrganizationAction } from './organization';

/** An address on the allowlist that is NOT the fixture's verified email. */
const ADMIN_EMAIL = 'platform-admin@example.com';
const NEW_ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INPUT = { name: 'New Workspace', timezone: 'America/Los_Angeles', currency: 'USD' };

let projectKey: SigningKey;
let server: FakeAuthServer;
let stub: SupabaseStub;
/** GET /user requests that reached the Auth server, or the outage standing in for it. */
let userLookups = 0;

beforeAll(async () => {
  projectKey = await makeSigningKey('project-kid-1');
});

function freshStub(memberInsertError: { message: string } | null = null): SupabaseStub {
  return makeSupabaseStub({
    // ensureUniqueSlug's probe: the slug is free.
    'organizations.select': { data: null, error: null },
    'organizations.insert': { data: [{ id: NEW_ORG_ID, slug: 'new-workspace' }], error: null },
    'organization_members.insert': { data: null, error: memberInsertError },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  server = fakeAuthServer(projectKey);
  userLookups = 0;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input instanceof Request ? input.url : input).endsWith('/auth/v1/user')) {
      userLookups += 1;
    }
    return server.fetch(input, init);
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  jar = new Map();
  h.allowlist = '';
  h.session = null;
  h.role = null;
  stub = freshStub();
  h.adminClient = stub.client;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(input: SessionClaimsInput, profileEmail = FIXTURE_EMAIL) {
  const claims = sessionClaims(input);
  jar = sessionCookies(await signAccessToken(projectKey, claims), claims);
  h.session = {
    userId: FIXTURE_USER_ID,
    // user_profiles.email: what the session loader reads, and its owner can edit.
    email: profileEmail,
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: null,
  };
}

/** The Auth server cannot answer GET /user (an outage), so the verified email cannot be read. */
function authUserLookupFails() {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input instanceof Request ? input.url : input).endsWith('/auth/v1/user')) {
      userLookups += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ code: 'unavailable', msg: 'try again' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return server.fetch(input, init);
  });
}

function expectNothingWritten() {
  expect(createAdminClient).not.toHaveBeenCalled();
  expect(stub.fromCalls).toEqual([]);
  expect(insertAuditRowReported).not.toHaveBeenCalled();
  expect(recordPlatformAudit).not.toHaveBeenCalled();
  expect(revalidatePath).not.toHaveBeenCalled();
}

const FRESH_STEP_UP: SessionClaimsInput = { aal: 'aal2', totpAgeSeconds: 60 };

interface Caller {
  who: string;
  /** user_profiles.email as the session loader returns it. */
  profileEmail: string;
  /** The caller's role in some workspace; null = no accepted membership. */
  role: string | null;
  allowlist: string;
  claims: SessionClaimsInput;
  authDown?: boolean;
}

// Every member is signed in with a fresh MFA step-up, so the allowlist alone
// refuses them.
const REFUSED: Caller[] = [
  ...['owner', 'admin', 'manager', 'staff', 'viewer'].map((role): Caller => ({
    who: `a workspace ${role} (verified email not on the allowlist)`,
    profileEmail: FIXTURE_EMAIL,
    role,
    allowlist: ADMIN_EMAIL,
    claims: FRESH_STEP_UP,
  })),
  {
    who: 'a member removed from their only workspace',
    profileEmail: FIXTURE_EMAIL,
    role: null,
    allowlist: ADMIN_EMAIL,
    claims: { aal: 'aal1' },
  },
  {
    who: 'a B2B portal user (a customer account, never a member)',
    profileEmail: FIXTURE_EMAIL,
    role: null,
    allowlist: ADMIN_EMAIL,
    claims: { aal: 'aal1' },
  },
  {
    who: 'an invited user who has not accepted the invite',
    profileEmail: FIXTURE_EMAIL,
    role: null,
    allowlist: ADMIN_EMAIL,
    claims: { aal: 'aal1' },
  },
  {
    who: 'a member whose profile email was rewritten to an allowlisted address (verified email differs)',
    profileEmail: ADMIN_EMAIL,
    role: 'staff',
    allowlist: ADMIN_EMAIL,
    claims: FRESH_STEP_UP,
  },
  {
    who: 'an allowlisted account whose verified email cannot be read (Auth answers 503): fails closed',
    profileEmail: FIXTURE_EMAIL,
    role: null,
    allowlist: FIXTURE_EMAIL,
    claims: FRESH_STEP_UP,
    authDown: true,
  },
];

describe('createOrganizationAction refuses everyone who is not a platform admin', () => {
  it.each(REFUSED)('$who: forbidden, and nothing is written', async (caller) => {
    h.allowlist = caller.allowlist;
    h.role = caller.role;
    await signIn(caller.claims, caller.profileEmail);
    if (caller.authDown) authUserLookupFails();

    const res = await createOrganizationAction(INPUT);

    expect(res).toEqual({
      ok: false,
      error: { code: 'forbidden', message: 'Not authorized.' },
    });
    expectNothingWritten();
    // The real check asked the Auth server for the verified email: the
    // profile column the session loader returned was never trusted.
    expect(userLookups).toBeGreaterThanOrEqual(1);
  });

  it('the check runs before the input is read: a non-admin with invalid input gets forbidden, not a validation error', async () => {
    h.allowlist = ADMIN_EMAIL;
    h.role = 'owner';
    await signIn(FRESH_STEP_UP);

    const res = await createOrganizationAction({ name: '', timezone: '', currency: 'X' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
    expectNothingWritten();
  });

  it('a signed-out caller is sent to sign-in (the redirect propagates) and nothing is written', async () => {
    h.allowlist = FIXTURE_EMAIL;
    await expect(createOrganizationAction(INPUT)).rejects.toMatchObject({
      digest: expect.stringContaining('NEXT_REDIRECT'),
    });
    expectNothingWritten();
  });
});

describe('a platform admin without a fresh step-up is asked to re-authenticate', () => {
  it.each([
    ['at AAL1', { aal: 'aal1' } as SessionClaimsInput],
    [
      'at AAL2 with an authenticator code 16 minutes old',
      { aal: 'aal2', totpAgeSeconds: 16 * 60 } as SessionClaimsInput,
    ],
  ])('%s: forbidden with reason aal2_required, and nothing is written', async (_label, claims) => {
    h.allowlist = FIXTURE_EMAIL;
    await signIn(claims);

    const res = await createOrganizationAction(INPUT);

    expect(res).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Re-authenticate with MFA to create a workspace.',
        details: { reason: 'aal2_required' },
      },
    });
    expectNothingWritten();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let pending promise callbacks and the fake Auth server's replies run. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

describe('a platform admin with a fresh step-up creates the workspace', () => {
  beforeEach(async () => {
    h.allowlist = FIXTURE_EMAIL;
    await signIn(FRESH_STEP_UP);
  });

  it('writes the organization, an owner seat bound to the session (never the input), the default organization and the Main Warehouse', async () => {
    const res = await createOrganizationAction({
      ...INPUT,
      // A stray id in the posted input is never used.
      user_id: '99999999-9999-4999-8999-999999999999',
    } as typeof INPUT);

    expect(res).toEqual({ ok: true, data: { organizationId: NEW_ORG_ID, slug: 'new-workspace' } });

    const orgInsert = stub.chainArgsAll.get('organizations.insert')!;
    expect(orgInsert).toHaveLength(1);
    expect(orgInsert[0]![0]![0]).toMatchObject({
      name: 'New Workspace',
      slug: 'new-workspace',
      timezone: 'America/Los_Angeles',
      currency: 'USD',
    });

    const seat = stub.chainArgsAll.get('organization_members.insert')!;
    expect(seat).toHaveLength(1);
    expect(seat[0]![0]![0]).toMatchObject({
      organization_id: NEW_ORG_ID,
      user_id: FIXTURE_USER_ID,
      role: 'owner',
    });

    expect(stub.chainsAll.get('user_profiles.update')).toEqual([['update', 'eq']]);
    expect(stub.chainArgsAll.get('user_profiles.update')![0]).toEqual([
      [{ default_organization_id: NEW_ORG_ID }],
      ['id', FIXTURE_USER_ID],
    ]);
    expect(stub.chainArgsAll.get('locations.insert')![0]![0]![0]).toEqual({
      organization_id: NEW_ORG_ID,
      name: 'Main Warehouse',
      type: 'warehouse',
    });
    expect(stub.chainsAll.get('organizations.delete')).toBeUndefined();
  });

  it("writes both audit trails: the new organization's own row and the platform console's org_provisioned", async () => {
    await createOrganizationAction(INPUT);

    expect(insertAuditRowReported).toHaveBeenCalledTimes(1);
    expect(insertAuditRowReported).toHaveBeenCalledWith({
      organization_id: NEW_ORG_ID,
      user_id: FIXTURE_USER_ID,
      event: 'organization.provisioned_by_platform_admin',
      metadata: { entity_type: 'organization', entity_id: NEW_ORG_ID, via: 'onboarding' },
    });
    expect(recordPlatformAudit).toHaveBeenCalledTimes(1);
    expect(recordPlatformAudit).toHaveBeenCalledWith({
      actorUserId: FIXTURE_USER_ID,
      actorEmail: FIXTURE_EMAIL,
      action: 'org_provisioned',
      targetOrganizationId: NEW_ORG_ID,
      targetUserId: FIXTURE_USER_ID,
      detail: { via: 'onboarding', slug: 'new-workspace' },
    });
  });

  it.each([
    ['the tenant row answers first', 'tenant'],
    ['the platform row answers first', 'platform'],
  ] as const)('answers only once both audit writes have answered (%s)', async (_label, first) => {
    const tenant = deferred<boolean>();
    const platform = deferred<boolean>();
    vi.mocked(insertAuditRowReported).mockReturnValueOnce(tenant.promise);
    vi.mocked(recordPlatformAudit).mockReturnValueOnce(platform.promise);

    let answered = false;
    const run = createOrganizationAction(INPUT).then((r) => {
      answered = true;
      return r;
    });

    await vi.waitFor(() =>
      expect(
        vi.mocked(insertAuditRowReported).mock.calls.length +
          vi.mocked(recordPlatformAudit).mock.calls.length,
      ).toBeGreaterThan(0),
    );
    await settle();
    expect(answered).toBe(false);

    (first === 'tenant' ? tenant : platform).resolve(true);
    await settle();
    expect(answered).toBe(false);

    (first === 'tenant' ? platform : tenant).resolve(true);
    await expect(run).resolves.toMatchObject({ ok: true });
    expect(insertAuditRowReported).toHaveBeenCalledTimes(1);
    expect(recordPlatformAudit).toHaveBeenCalledTimes(1);
  });

  it('a failed owner-seat insert rolls the organization back, answers an error and writes no audit row', async () => {
    stub = freshStub({ message: 'membership insert refused' });
    h.adminClient = stub.client;

    const res = await createOrganizationAction(INPUT);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('internal_error');
    expect(stub.chainsAll.get('organizations.delete')).toEqual([['delete', 'eq']]);
    expect(stub.chainArgsAll.get('organizations.delete')![0]).toEqual([[], ['id', NEW_ORG_ID]]);
    expect(insertAuditRowReported).not.toHaveBeenCalled();
    expect(recordPlatformAudit).not.toHaveBeenCalled();
    expect(stub.chainsAll.get('user_profiles.update')).toBeUndefined();
    expect(stub.chainsAll.get('locations.insert')).toBeUndefined();
  });
});
