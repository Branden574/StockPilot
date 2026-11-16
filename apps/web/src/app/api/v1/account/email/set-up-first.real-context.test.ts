// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The phone's request route for the sign-in email change, through the REAL
 * withApiContext: the bearer token's user, the one-round-trip context read
 * (get_request_context) and the organization the phone names in
 * X-Organization-Id, with that organization's authenticator policy.
 *
 * A member with no authenticator whose named organization requires one of
 * their role gets 403 mfa_required, before a limit is spent, the password is
 * checked or anything is minted or sent. The organization the request names
 * decides: the same member naming an organization with an optional policy
 * starts the change.
 *
 * Faked: the Supabase clients, the service client, the limits, the password
 * check and the emails. Made-up people and organizations only.
 */

const refs = vi.hoisted(() => ({
  policies: {} as Record<string, string>,
  factors: [] as Array<{ status: string }>,
  pending: null as string | null,
  minted: 0,
  sent: 0,
  passwordChecks: 0,
  limitChecks: 0,
}));

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/env', () => {
  // A dull signing value under a neutral name (secret-shaped-fixtures.guard).
  const SIGNING_INPUT = 'test-only-signing-input';
  return {
    env: {
      NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
      NEXT_PUBLIC_APP_URL: 'https://app.example.test',
      SUPABASE_SERVICE_ROLE_KEY: SIGNING_INPUT,
    },
  };
});
vi.mock('@supabase/supabase-js', () => ({ createClient: () => memberClient() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => memberClient() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => {
    refs.limitChecks += 1;
    return { allowed: true, remaining: 2, resetAt: Date.now() + 1 };
  }),
}));
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => {
    refs.passwordChecks += 1;
    return { ok: true };
  }),
}));
vi.mock('@/lib/email/resend', () => ({
  sendEmail: vi.fn(async () => {
    refs.sent += 1;
    return { ok: true, id: 'msg' };
  }),
}));
vi.mock('@/lib/email/es/families/security', () => {
  const rendered = () => ({ subject: 's', html: '<p>h</p>', text: 't', from: 'from@example.test' });
  return {
    renderEmailChangeCurrentEmail: rendered,
    renderEmailChangeNewEmail: rendered,
    renderEmailChangedNoticeEmail: rendered,
  };
});
vi.mock('@/server/services/audit', () => ({ insertAuditRowReported: vi.fn(async () => true) }));
vi.mock('@/server/services/auth-audit', () => ({
  resolveDefaultOrgAndRole: vi.fn(async () => ({ organizationId: null, role: null })),
}));
vi.mock('@/lib/supabase/admin', () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({
      data: { full_name: 'Example Person', disabled_at: null, deleted_at: null },
      error: null,
    }),
  };
  return {
    createAdminClient: () => ({
      from: () => chain,
      rpc: async () => ({ data: false, error: null }),
      auth: {
        admin: {
          // A change just minted carries the time the auth server recorded.
          getUserById: async (id: string) => {
            const pending = refs.pending ?? (refs.minted >= 2 ? 'minted@example.test' : null);
            return {
              data: {
                user: {
                  id,
                  email: 'person@example.test',
                  new_email: pending,
                  email_change_sent_at: pending ? new Date().toISOString() : null,
                },
              },
              error: null,
            };
          },
          generateLink: async () => {
            refs.minted += 1;
            return {
              data: { properties: { hashed_token: 'ef'.repeat(28), email_otp: '000000' } },
              error: null,
            };
          },
        },
      },
    }),
  };
});

import { insertAuditRowReported } from '@/server/services/audit';

import { POST as requestPOST } from './request/route';

const USER = '99999999-9999-4999-8999-999999999999';
const REQUIRING = 'aaaaaaaa-1111-4111-8111-111111111111';
const OPTIONAL = 'bbbbbbbb-2222-4222-8222-222222222222';

/** get_request_context(): the member in both organizations, each with its own policy. */
function requestContext() {
  return {
    user_id: USER,
    profile: {
      id: USER,
      email: 'person@example.test',
      full_name: null,
      avatar_url: null,
      default_organization_id: REQUIRING,
      disabled_at: null,
    },
    memberships: [REQUIRING, OPTIONAL].map((id) => ({
      organization_id: id,
      role: 'staff',
      organization: {
        id,
        name: `Org ${id.slice(0, 1)}`,
        logo_url: null,
        terminology: null,
        mfa_policy: refs.policies[id],
        timezone: null,
        nav_overrides: null,
        dashboard_layout: null,
        order_status_config: null,
        all_modules_comp: false,
        order_catalog_last_hide_at: null,
      },
      role_overrides: [],
      user_overrides: [],
      enabled_modules: [],
    })),
  };
}

function memberClient() {
  return {
    from: (table: string) => {
      throw new Error(`unexpected table read: ${table}`);
    },
    rpc: async (name: string) =>
      name === 'get_request_context'
        ? { data: requestContext(), error: null }
        : { data: null, error: { message: `unexpected rpc ${name}` } },
    auth: {
      getUser: async () => ({ data: { user: { id: USER, factors: refs.factors } }, error: null }),
    },
  };
}

/** The phone's access token at aal1: unsigned, read through the fakes above. */
function token(): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'none', typ: 'JWT' })}.${seg({ sub: USER, aal: 'aal1' })}.`;
}

function ask(organizationId: string) {
  return requestPOST(
    new NextRequest('https://app.example.test/api/v1/account/email/request', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token()}`,
        'content-type': 'application/json',
        'x-organization-id': organizationId,
      },
      body: JSON.stringify({
        newEmail: 'new-address@example.test',
        currentPassword: 'test-only-password',
      }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  Object.assign(refs, {
    policies: { [REQUIRING]: 'all_required', [OPTIONAL]: 'optional' },
    factors: [],
    pending: null,
    minted: 0,
    sent: 0,
    passwordChecks: 0,
    limitChecks: 0,
  });
});

describe('the phone request route, with the real context builder', () => {
  it('a member with no authenticator gets 403 mfa_required, and nothing is spent, checked, sent or written', async () => {
    const res = await ask(REQUIRING);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'mfa_required',
      message: 'Multi-factor authentication required. Enroll in MFA before performing this action.',
    });
    expect(refs.limitChecks).toBe(0);
    expect(refs.passwordChecks).toBe(0);
    expect(refs.minted).toBe(0);
    expect(refs.sent).toBe(0);
    expect(insertAuditRowReported).not.toHaveBeenCalled();
  });

  it("the current organization's policy decides: allowed with the optional one named", async () => {
    const res = await ask(OPTIONAL);
    expect(res.status).toBe(200);
    expect(refs.passwordChecks).toBe(1);
    expect(refs.minted).toBe(2);
    expect(refs.sent).toBe(2);
  });

  it("the current organization's policy decides: refused with the requiring one named", async () => {
    const res = await ask(REQUIRING);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('mfa_required');
    expect(refs.passwordChecks).toBe(0);
  });
});
