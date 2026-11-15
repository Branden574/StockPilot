import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { audit } from '@/server/services/audit';
import { putConnectionSecret } from '@/server/connectors/secret-store';
import { exchangeCode } from '@/server/connectors/sage-intacct/oauth';
import { makeSupabaseStub, type QueryResult, type SupabaseStub } from '@/test/supabase-mock';
import { verifiedSessionAuth } from '@/test/verified-session-stub';

import { GET } from './route';

import type { Role } from '@stockpilot/core';

/**
 * The Sage Intacct callback mirrors the QuickBooks one, including the fact that
 * it resolves its own principal with createClient() + auth.getUser() and is
 * therefore covered by NONE of the three account-status chokepoints. This file
 * exists mainly to hold that guard in place; the happy path is asserted
 * alongside it so a guard that refuses everyone cannot pass.
 */

vi.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_APP_URL: 'https://app.example.com' },
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn() }));
vi.mock('@/server/connectors/secret-store', () => ({ putConnectionSecret: vi.fn() }));
vi.mock('@/server/connectors/sage-intacct/oauth', () => ({ exchangeCode: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const SETTINGS_PATH = '/dashboard/settings/integrations';
const CONNECTION_ID = '33333333-3333-3333-3333-333333333333';
const ORG_ID = '44444444-4444-4444-4444-444444444444';
const USER_ID = 'user-sage-1';
const STATE = 'sage-csrf-state';
const COMPANY_ID = 'ACME-CO';

function userClient(
  overrides: Record<string, QueryResult> = {},
  user: { id: string; factors?: Array<{ status: string }> } | null = { id: USER_ID },
) {
  const stub = makeSupabaseStub({
    'org_connections.select': {
      data: [
        {
          id: CONNECTION_ID,
          organization_id: ORG_ID,
          status: 'pending',
          oauth_state: STATE,
        },
      ],
      error: null,
    },
    'organization_modules.select': { data: [{ module_id: 'integrations', enabled: true }], error: null },
    // The comp flag, read beside the row. Not comped by default.
    'organizations.select': { data: [{ all_modules_comp: false }], error: null },
    // The organization's authenticator policy, read on its own (maybeSingle).
    // Optional by default, so the tests below that are not about the policy
    // keep the member they always had: an admin with no authenticator.
    'organizations.select.maybeSingle': { data: [{ mfa_policy: 'optional' }], error: null },
    'organization_members.select': { data: [{ role: 'admin' }], error: null },
    // Permission overrides, read by the real loader (docket S19). None by
    // default, so the admin holds integrations:manage at its role default.
    'role_permission_overrides.select': { data: [], error: null },
    'user_permission_overrides.select': { data: [], error: null },
    // Account status (0308). Default = ACTIVE.
    'user_profiles.select': { data: [{ disabled_at: null }], error: null },
    ...overrides,
  });
  stub.client.auth.getUser = vi.fn(async () => ({ data: { user }, error: null }));
  return stub;
}

function adminClient(updateError: { message: string } | null = null) {
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    from: vi.fn(() => ({
      update: vi.fn((payload: Record<string, unknown>) => {
        updates.push(payload);
        return { eq: vi.fn(() => Promise.resolve({ error: updateError })) };
      }),
    })),
  };
  return { client, updates };
}

function callbackUrl(params: Record<string, string>) {
  const url = new URL('https://app.example.com/api/integrations/sage_intacct/callback');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

function location(res: Response) {
  return new URL(res.headers.get('location') ?? '');
}

describe('GET /api/integrations/sage_intacct/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createClient).mockResolvedValue(userClient().client as never);
    vi.mocked(createAdminClient).mockReturnValue(adminClient().client as never);
    vi.mocked(putConnectionSecret).mockResolvedValue('sage-secret-handle');
    vi.mocked(exchangeCode).mockResolvedValue({
      accessToken: 'SAGE-ACCESS-SECRET',
      refreshToken: 'SAGE-REFRESH-SECRET',
      expiresAt: '2026-01-01T00:00:00.000Z',
      companyId: COMPANY_ID,
    } as never);
  });

  it('redirects to /signin when there is no session', async () => {
    vi.mocked(createClient).mockResolvedValueOnce(userClient({}, null).client as never);

    const res = await GET(callbackUrl({ code: 'c', state: STATE }));

    expect(res.status).toBe(302);
    expect(location(res).pathname).toBe('/signin');
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('refuses a DISABLED account before exchanging the code or writing any secret', async () => {
    vi.mocked(createClient).mockResolvedValueOnce(
      userClient({
        'user_profiles.select': {
          data: [{ disabled_at: '2026-07-31T00:00:00.000Z' }],
          error: null,
        },
      }).client as never,
    );

    const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

    expect(res.status).toBe(302);
    expect(location(res).searchParams.get('error')).toBe('forbidden');
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(putConnectionSecret).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  // ── Authenticator code (docket S43a) ──────────────────────────────────────
  // This route builds its own principal, so withApiContext's refusal of a
  // session that still owes its authenticator code never sees it. It asks the
  // same question (cookieSessionOwesStepUp, the shared rule) right after
  // getUser: an enrolled member signed in with the password alone cannot finish
  // a connect, and nothing is read, exchanged or written for them.
  it('refuses an enrolled session that has not entered its code, before reading or exchanging anything', async () => {
    const stub = userClient({}, { id: USER_ID, factors: [{ status: 'verified' }] });
    Object.assign(
      stub.client.auth,
      verifiedSessionAuth(() => ({ sub: USER_ID, aal: 'aal1' })),
    );
    vi.mocked(createClient).mockResolvedValueOnce(stub.client as never);

    const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

    expect(res.status).toBe(302);
    expect(location(res).pathname).toBe(SETTINGS_PATH);
    expect(location(res).searchParams.get('error')).toBe('forbidden');
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(putConnectionSecret).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    // Not the account status, not the pending row: no table at all.
    expect(stub.fromCalls).toEqual([]);
  });

  it('refuses an enrolled session whose level cannot be read (fail closed)', async () => {
    const stub = userClient({}, { id: USER_ID, factors: [{ status: 'verified' }] });
    Object.assign(
      stub.client.auth,
      verifiedSessionAuth(() => ({ sub: USER_ID, aal: 'aal2', read: 'error' })),
    );
    vi.mocked(createClient).mockResolvedValueOnce(stub.client as never);

    const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

    expect(location(res).searchParams.get('error')).toBe('forbidden');
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(stub.fromCalls).toEqual([]);
  });

  it("refuses an enrolled session whose session now holds another account's aal2 (review round 1)", async () => {
    // The cookie's refresh token and expires_at are the sender's to write, so
    // the level read can load another account's refreshed session after
    // getUser() validated this one. Its aal2 is not this member's code.
    const stub = userClient({}, { id: USER_ID, factors: [{ status: 'verified' }] });
    Object.assign(
      stub.client.auth,
      verifiedSessionAuth(() => ({ sub: 'another-account', aal: 'aal2' })),
    );
    // What an unbound level read (getAuthenticatorAssuranceLevel) answers after
    // that refresh: the other account's aal2.
    stub.client.auth.mfa.getAuthenticatorAssuranceLevel = vi.fn(async () => ({
      data: { currentLevel: 'aal2', nextLevel: 'aal2' },
      error: null,
    }));
    vi.mocked(createClient).mockResolvedValueOnce(stub.client as never);

    const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

    expect(location(res).searchParams.get('error')).toBe('forbidden');
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(putConnectionSecret).not.toHaveBeenCalled();
    expect(stub.fromCalls).toEqual([]);
  });

  it('an enrolled session that entered its code (aal2) finishes the connect', async () => {
    const stub = userClient({}, { id: USER_ID, factors: [{ status: 'verified' }] });
    Object.assign(
      stub.client.auth,
      verifiedSessionAuth(() => ({ sub: USER_ID, aal: 'aal2' })),
    );
    vi.mocked(createClient).mockResolvedValueOnce(stub.client as never);

    const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

    expect(location(res).searchParams.get('connected')).toBe('sage_intacct');
    expect(exchangeCode).toHaveBeenCalledWith('auth-code');
    expect(putConnectionSecret).toHaveBeenCalledTimes(1);
  });

  // ── The organization's authenticator policy ───────────────────────────────
  // The same answer pages and the API give (cookieSessionMfaState): when the
  // organization's policy requires an authenticator of this member and the
  // session has not met it, the callback answers with its `forbidden` redirect
  // before the code is exchanged or anything is written.
  describe("the organization's authenticator policy", () => {
    type Policy = 'optional' | 'admins_required' | 'all_required';
    type Shape = 'no authenticator' | 'authenticator, aal2' | 'factor removed, token at aal2';

    function policyClient(
      policy: Policy | QueryResult,
      role: Role,
      shape: Shape,
      overrides: Record<string, QueryResult> = {},
    ) {
      const enrolled = shape === 'authenticator, aal2';
      const stub = userClient(
        {
          'organizations.select.maybeSingle':
            typeof policy === 'string' ? { data: [{ mfa_policy: policy }], error: null } : policy,
          'organization_members.select': { data: [{ role }], error: null },
          ...overrides,
        },
        { id: USER_ID, factors: enrolled ? [{ status: 'verified' }] : [] },
      );
      Object.assign(
        stub.client.auth,
        verifiedSessionAuth(() => ({
          sub: USER_ID,
          aal: shape === 'no authenticator' ? 'aal1' : 'aal2',
        })),
      );
      vi.mocked(createClient).mockResolvedValueOnce(stub.client as never);
      return stub;
    }

    // A manager holds integrations:manage only when it is granted to them.
    const GRANTED = {
      'user_permission_overrides.select': {
        data: [{ permission: 'integrations:manage', granted: true }],
        error: null,
      },
    };

    function expectRefusedBeforeAnyExchangeOrWrite(res: Response, stub: SupabaseStub) {
      expect(res.status).toBe(302);
      expect(location(res).pathname).toBe(SETTINGS_PATH);
      expect(location(res).searchParams.get('error')).toBe('forbidden');
      expect(location(res).searchParams.has('connected')).toBe(false);
      expect(exchangeCode).not.toHaveBeenCalled();
      expect(putConnectionSecret).not.toHaveBeenCalled();
      expect(createAdminClient).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
      expect(stub.chainsAll.has('org_connections.update')).toBe(false);
    }

    it.each([
      ['admins_required', 'admin', {}],
      ['admins_required', 'owner', {}],
      ['all_required', 'admin', {}],
      ['all_required', 'owner', {}],
      ['all_required', 'manager', GRANTED],
    ] as Array<[Policy, Role, Record<string, QueryResult>]>)(
      '%s, %s with no authenticator: forbidden, before any exchange or write',
      async (policy, role, overrides) => {
        const stub = policyClient(policy, role, 'no authenticator', overrides);

        const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

        expectRefusedBeforeAnyExchangeOrWrite(res, stub);
      },
    );

    // The account has no verified factor any more, while the session's token
    // still says aal2: the policy is met only by an account that has one.
    it.each([
      ['admins_required', 'admin'],
      ['admins_required', 'owner'],
      ['all_required', 'admin'],
    ] as Array<[Policy, Role]>)(
      '%s, %s whose factor was removed while the token is still at aal2: forbidden, before any exchange or write',
      async (policy, role) => {
        const stub = policyClient(policy, role, 'factor removed, token at aal2');

        const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

        expectRefusedBeforeAnyExchangeOrWrite(res, stub);
      },
    );

    it.each([
      ['hidden from the member', { data: [], error: null }],
      ['unreadable', { data: null, error: { message: 'timeout', code: '57014' } }],
    ] as Array<[string, QueryResult]>)(
      'a policy %s is held to the strictest one: an admin with no authenticator is refused',
      async (_how, answer) => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const stub = policyClient(answer, 'admin', 'no authenticator');

        const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

        expectRefusedBeforeAnyExchangeOrWrite(res, stub);
      },
    );

    it.each([
      ['optional', 'admin', 'no authenticator', {}, false, true, false],
      ['optional', 'admin', 'authenticator, aal2', {}, true, true, true],
      ['admins_required', 'manager', 'no authenticator', GRANTED, false, true, false],
      ['admins_required', 'admin', 'authenticator, aal2', {}, true, true, true],
      ['admins_required', 'owner', 'authenticator, aal2', {}, true, true, true],
      ['all_required', 'admin', 'authenticator, aal2', {}, true, true, true],
    ] as Array<[Policy, Role, Shape, Record<string, QueryResult>, boolean, boolean, boolean]>)(
      '%s, %s, %s: connects, and the context handed to audit carries the real authenticator state',
      async (policy, role, shape, overrides, mfaRequired, mfaSatisfied, mfaEnrolled) => {
        const admin = adminClient();
        vi.mocked(createAdminClient).mockReturnValue(admin.client as never);
        policyClient(policy, role, shape, overrides);

        const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

        expect(location(res).searchParams.get('connected')).toBe('sage_intacct');
        expect(exchangeCode).toHaveBeenCalledWith('auth-code');
        expect(putConnectionSecret).toHaveBeenCalledTimes(1);
        expect(admin.updates[0]).toMatchObject({ status: 'active' });
        expect(audit).toHaveBeenCalledTimes(1);
        const [, auditCtx] = vi.mocked(audit).mock.calls[0]!;
        expect(auditCtx).toMatchObject({
          organizationId: ORG_ID,
          userId: USER_ID,
          role,
          mfaRequired,
          mfaSatisfied,
          mfaEnrolled,
        });
      },
    );
  });

  it('refuses with internal_error (not forbidden) when the account status cannot be read', async () => {
    vi.mocked(createClient).mockResolvedValueOnce(
      userClient({
        'user_profiles.select': { data: null, error: { message: 'db down' } },
      }).client as never,
    );

    const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

    expect(res.status).toBe(302);
    expect(location(res).searchParams.get('error')).toBe('internal_error');
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(putConnectionSecret).not.toHaveBeenCalled();
  });

  // ── The integrations module ────────────────────────────────────────────────
  it('a module that is off is refused with module_disabled, before any exchange', async () => {
    vi.mocked(createClient).mockResolvedValueOnce(
      userClient({
        'organization_modules.select': {
          data: [{ module_id: 'integrations', enabled: false }],
          error: null,
        },
      }).client as never,
    );

    const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

    expect(location(res).searchParams.get('error')).toBe('module_disabled');
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(putConnectionSecret).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the module row',
      { 'organization_modules.select': { data: null, error: { message: 'timeout', code: '57014' } } },
    ],
    [
      'the comp flag, beside a row that says off',
      {
        'organization_modules.select': {
          data: [{ module_id: 'integrations', enabled: false }],
          error: null,
        },
        'organizations.select': { data: null, error: { message: 'timeout', code: '57014' } },
      },
    ],
  ] as Array<[string, Record<string, QueryResult>]>)(
    'a module state that could not be read (%s): the transient error code, never module_disabled, and nothing is exchanged or stored',
    async (_name, overrides) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.mocked(createClient).mockResolvedValueOnce(userClient(overrides).client as never);

      const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

      expect(res.status).toBe(302);
      expect(location(res).searchParams.get('error')).toBe('internal_error');
      expect(exchangeCode).not.toHaveBeenCalled();
      expect(putConnectionSecret).not.toHaveBeenCalled();
      expect(createAdminClient).not.toHaveBeenCalled();
    },
  );

  // ── Effective permissions (docket S19) ─────────────────────────────────────
  // The same gate as the QuickBooks callback: the member's EFFECTIVE set, the
  // rule beginConnect applies. org_connections' write rule asks only for the
  // admin role (0146), so an admin whose integrations:manage was revoked can
  // write a pending row with a state of their choosing; a static check here
  // then let them finish the connect.
  it.each([
    ['for them (a member override)', 'user_permission_overrides.select'],
    ['for every admin (a role override)', 'role_permission_overrides.select'],
  ])(
    'refuses an admin whose integrations:manage was revoked %s, before exchanging the code or writing any secret',
    async (_how, table) => {
      vi.mocked(createClient).mockResolvedValueOnce(
        userClient({
          [table]: { data: [{ permission: 'integrations:manage', granted: false }], error: null },
        }).client as never,
      );

      const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

      expect(res.status).toBe(302);
      expect(location(res).searchParams.get('error')).toBe('forbidden');
      expect(exchangeCode).not.toHaveBeenCalled();
      expect(putConnectionSecret).not.toHaveBeenCalled();
      expect(createAdminClient).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    },
  );

  it('refuses with internal_error (not forbidden) when the permission overrides cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(createClient).mockResolvedValueOnce(
      userClient({
        'role_permission_overrides.select': {
          data: null,
          error: { message: 'db down', code: '57014' },
        },
      }).client as never,
    );

    const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

    expect(res.status).toBe(302);
    expect(location(res).searchParams.get('error')).toBe('internal_error');
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(putConnectionSecret).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it('the owner still finishes the connect when the overrides cannot be read (the lockout escape hatch)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(createClient).mockResolvedValueOnce(
      userClient({
        'organization_members.select': { data: [{ role: 'owner' }], error: null },
        'user_permission_overrides.select': { data: null, error: { message: 'db down' } },
      }).client as never,
    );

    const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

    expect(location(res).searchParams.get('connected')).toBe('sage_intacct');
    expect(putConnectionSecret).toHaveBeenCalledTimes(1);
  });

  it('a manager, who does not hold integrations:manage, is refused', async () => {
    vi.mocked(createClient).mockResolvedValueOnce(
      userClient({
        'organization_members.select': { data: [{ role: 'manager' }], error: null },
      }).client as never,
    );

    const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

    expect(location(res).searchParams.get('error')).toBe('forbidden');
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('happy path: an ACTIVE user still completes the connect', async () => {
    const admin = adminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin.client as never);

    const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

    expect(exchangeCode).toHaveBeenCalledWith('auth-code');
    expect(putConnectionSecret).toHaveBeenCalledTimes(1);
    expect(admin.updates[0]).toMatchObject({
      status: 'active',
      external_account_id: COMPANY_ID,
      secret_id: 'sage-secret-handle',
      oauth_state: null,
    });
    expect(audit).toHaveBeenCalledTimes(1);

    expect(res.status).toBe(302);
    const loc = location(res);
    expect(loc.pathname).toBe(SETTINGS_PATH);
    expect(loc.searchParams.get('connected')).toBe('sage_intacct');

    // SECRET INVARIANT: tokens must never reach the redirect URL.
    const redirect = res.headers.get('location') ?? '';
    expect(redirect).not.toContain('SAGE-ACCESS-SECRET');
    expect(redirect).not.toContain('SAGE-REFRESH-SECRET');
  });
});
