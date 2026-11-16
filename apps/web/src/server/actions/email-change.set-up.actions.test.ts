// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sign-in email change on the profile page, for a member who must set up
 * an authenticator first: an owner or admin with no verified factor under
 * admins_required, anyone under all_required.
 *
 * The profile page is open to such a member, and its name action reaches its
 * own authenticator check, which answers that one is required. Starting and
 * resending an email change give that same answer, before a limit is spent,
 * the password is checked or anything is minted or sent. Cancelling a pending
 * change still runs.
 *
 * Through the REAL session loader (which organization applies, from the
 * request's own context read), the set-up rule (lib/auth/step-up-gate) and the
 * service; only the network, the limits, the password check and the emails are
 * faked.
 */

const svc = vi.hoisted(() => ({
  pending: null as string | null,
  minted: 0,
  sent: 0,
  passwordChecks: 0,
  limitChecks: 0,
  cancelled: 0,
}));

/** How the organization row read goes, when the membership does not carry the row. */
const orgRead = vi.hoisted(() => ({
  hidden: false,
  answer: 'row' as 'row' | 'empty' | 'error',
}));

vi.mock('next/headers', async () => {
  const f = await import('@/test/step-up-session-fixture');
  return {
    headers: async () => f.fixtureHeaders(),
    cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/supabase/server', async () => {
  const f = await import('@/test/step-up-session-fixture');
  return {
    createClient: async () => {
      const client = f.fixtureClient();
      return {
        ...client,
        // get_request_context(): the fixture's answer, with the organization
        // row hidden from the member when the case says so.
        rpc: async (fn: string) => {
          const res = (await client.rpc(fn)) as {
            data: { memberships: Array<{ organization: unknown }> };
          };
          if (orgRead.hidden) {
            for (const m of res.data.memberships) m.organization = null;
          }
          return res;
        },
        from: (table: string) => {
          f.world.calls.push(`from:${table}`);
          const builder: Record<string, unknown> = {};
          for (const m of ['select', 'eq', 'not', 'order']) builder[m] = () => builder;
          if (table === 'user_profiles') {
            // The action's own account status read.
            builder.maybeSingle = async () => ({ data: { disabled_at: null }, error: null });
          } else if (table === 'organizations') {
            builder.maybeSingle = async () =>
              orgRead.answer === 'error'
                ? { data: null, error: { code: '57014', message: 'statement timeout' } }
                : orgRead.answer === 'empty'
                  ? { data: null, error: null }
                  : { data: { mfa_policy: f.world.policy }, error: null };
          } else {
            throw new Error(`unexpected table read: ${table}`);
          }
          return builder;
        },
      };
    },
  };
});
vi.mock('@/lib/error-reporter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/error-reporter')>()),
  reportError: vi.fn(async () => {}),
}));
vi.mock('@/lib/env', () => {
  // A dull signing value under a neutral name (secret-shaped-fixtures.guard).
  const SIGNING_INPUT = 'test-only-signing-input';
  return {
    env: {
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
      NEXT_PUBLIC_APP_URL: 'https://app.example.test',
      SUPABASE_SERVICE_ROLE_KEY: SIGNING_INPUT,
    },
  };
});
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => {
    svc.limitChecks += 1;
    return { allowed: true, remaining: 2, resetAt: Date.now() + 1 };
  }),
}));
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => {
    svc.passwordChecks += 1;
    return { ok: true };
  }),
}));
vi.mock('@/lib/email/resend', () => ({
  sendEmail: vi.fn(async () => {
    svc.sent += 1;
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
vi.mock('@/server/services/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/audit')>()),
  insertAuditRowReported: vi.fn(async () => true),
}));
vi.mock('@/server/services/auth-audit', () => ({
  resolveDefaultOrgAndRole: vi.fn(async () => ({ organizationId: null, role: null })),
}));
vi.mock('@/lib/supabase/admin', async () => {
  const f = await import('@/test/step-up-session-fixture');
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
      rpc: async (fn: string) => {
        if (fn === 'cancel_pending_email_change') {
          svc.cancelled += 1;
          return { data: true, error: null };
        }
        return { data: false, error: null };
      },
      auth: {
        admin: {
          // A pending change (or one just minted) carries the time the auth
          // server recorded for its request.
          getUserById: async (id: string) => {
            const pending = svc.pending ?? (svc.minted >= 2 ? 'minted@example.test' : null);
            return {
              data: {
                user: {
                  id,
                  email: f.EMAIL,
                  new_email: pending,
                  email_change_sent_at: pending ? new Date().toISOString() : null,
                },
              },
              error: null,
            };
          },
          generateLink: async () => {
            svc.minted += 1;
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

import { ORG, ORG_2, resetWorld, VERIFIED_FACTOR, world } from '@/test/step-up-session-fixture';

import {
  cancelEmailChangeAction,
  requestEmailChangeAction,
  resendEmailChangeAction,
} from './email-change';
import { updateProfileNameAction } from './profile';

const PROFILE = '/dashboard/settings/profile';
const PENDING = 'pending@example.test';
const INPUT = { newEmail: 'new-address@example.test', currentPassword: 'test-only-password' };

const COULD_NOT_CHECK = {
  ok: false,
  error: { code: 'internal_error', message: 'Your access could not be checked. Please try again.' },
};

function nothingSpent() {
  expect(svc.limitChecks).toBe(0);
  expect(svc.passwordChecks).toBe(0);
  expect(svc.minted).toBe(0);
  expect(svc.sent).toBe(0);
}

beforeEach(() => {
  resetWorld();
  world.pathname = PROFILE;
  world.returnPath = PROFILE;
  world.policy = 'admins_required';
  world.role = 'admin';
  world.orgs = [ORG, ORG_2];
  Object.assign(svc, {
    pending: null,
    minted: 0,
    sent: 0,
    passwordChecks: 0,
    limitChecks: 0,
    cancelled: 0,
  });
  Object.assign(orgRead, { hidden: false, answer: 'row' });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('a member who must set up an authenticator first, on the profile page', () => {
  it('starting an email change gets the answer the name action gets, and nothing is spent, checked or sent', async () => {
    const name = await updateProfileNameAction({ fullName: 'Pat Example' });
    expect(name).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message:
          'Multi-factor authentication required. Enroll in MFA before performing this action.',
        details: { reason: 'mfa_required' },
      },
    });
    expect(await requestEmailChangeAction(INPUT)).toEqual(name);
    nothingSpent();
  });

  it('resending a pending change gets the same answer, and nothing is spent or sent', async () => {
    svc.pending = PENDING;
    const name = await updateProfileNameAction({ fullName: 'Pat Example' });
    expect(await resendEmailChangeAction()).toEqual(name);
    nothingSpent();
  });

  it('everyone under all_required: a staff member is refused the same way', async () => {
    world.policy = 'all_required';
    world.role = 'staff';
    const result = await requestEmailChangeAction(INPUT);
    expect(result).toMatchObject({ ok: false, error: { details: { reason: 'mfa_required' } } });
    nothingSpent();
  });

  it('an authenticator that was never verified does not count', async () => {
    world.factors = [{ status: 'unverified' }];
    const result = await requestEmailChangeAction(INPUT);
    expect(result).toMatchObject({ ok: false, error: { details: { reason: 'mfa_required' } } });
    nothingSpent();
  });

  it('cancelling a pending change still runs', async () => {
    svc.pending = PENDING;
    expect(await cancelEmailChangeAction()).toEqual({ ok: true, data: { cancelled: true } });
    expect(svc.cancelled).toBe(1);
  });

  it('an organization row hidden from the member is held to the strictest policy: refused under any policy', async () => {
    world.policy = 'optional';
    world.role = 'staff';
    orgRead.hidden = true;
    orgRead.answer = 'empty';
    const result = await requestEmailChangeAction(INPUT);
    expect(result).toMatchObject({ ok: false, error: { details: { reason: 'mfa_required' } } });
    nothingSpent();
  });

  it('an organization row that could not be read: the access could not be checked, and nothing is changed', async () => {
    orgRead.hidden = true;
    orgRead.answer = 'error';
    expect(await requestEmailChangeAction(INPUT)).toEqual(COULD_NOT_CHECK);
    svc.pending = PENDING;
    expect(await resendEmailChangeAction()).toEqual(COULD_NOT_CHECK);
    nothingSpent();
  });

  it('a request with no verified session of its own: the access could not be checked', async () => {
    world.headerUser = null;
    expect(await requestEmailChangeAction(INPUT)).toEqual(COULD_NOT_CHECK);
    nothingSpent();
  });
});

describe('everyone else keeps the rules they had', () => {
  it('a manager under admins_required starts a change: the limits, the password, both links and both emails', async () => {
    world.role = 'manager';
    expect(await requestEmailChangeAction(INPUT)).toMatchObject({
      ok: true,
      data: { pendingEmail: INPUT.newEmail },
    });
    expect(svc.limitChecks).toBe(2);
    expect(svc.passwordChecks).toBe(1);
    expect(svc.minted).toBe(2);
    expect(svc.sent).toBe(2);
  });

  it('a member of an organization with an optional policy starts and resends a change', async () => {
    world.policy = 'optional';
    expect((await requestEmailChangeAction(INPUT)).ok).toBe(true);
    svc.pending = PENDING;
    expect((await resendEmailChangeAction()).ok).toBe(true);
  });

  it('a member with an authenticator at aal2 under all_required starts a change', async () => {
    world.policy = 'all_required';
    world.factors = VERIFIED_FACTOR;
    world.aal = 'aal2';
    expect((await requestEmailChangeAction(INPUT)).ok).toBe(true);
  });

  it('a member with an authenticator whose session is not at aal2 is asked for the code, before the password', async () => {
    world.policy = 'optional';
    world.factors = VERIFIED_FACTOR;
    world.aal = 'aal1';
    expect(await requestEmailChangeAction(INPUT)).toMatchObject({
      ok: false,
      error: { code: 'forbidden', details: { reason: 'aal2_required' } },
    });
    expect(svc.passwordChecks).toBe(0);
    expect(svc.minted).toBe(0);
  });

  it('an account with no organization starts, resends and cancels a change as before', async () => {
    world.orgs = [];
    world.policy = 'all_required';
    expect((await requestEmailChangeAction(INPUT)).ok).toBe(true);
    svc.pending = PENDING;
    expect((await resendEmailChangeAction()).ok).toBe(true);
    expect((await cancelEmailChangeAction()).ok).toBe(true);
    expect(svc.passwordChecks).toBe(1);
  });
});
