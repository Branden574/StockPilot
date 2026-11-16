// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The phone's email change routes (/api/v1/account/email/request, /resend,
 * /cancel) for a member whose organization requires an authenticator of their
 * role while they have none verified.
 *
 * withApiContext resolves that member's context with the organization's
 * policy (lib/auth/api-context.ts, mfaFromPolicy): required, not satisfied,
 * not enrolled. Request and resend answer the refusal the web's name and
 * avatar give (mfaGateError, the 'mfa_required' shape), as a 403, before a
 * limit is spent, the password is checked or anything is minted or sent.
 * Cancel only removes a pending change and still runs.
 *
 * Real: the three routes, their glue (server/lib/email-change-api.ts) and the
 * service (server/services/email-change.ts). Faked: the context, the service
 * client, the limits, the password check and the emails.
 */

const state = vi.hoisted(() => ({
  ctx: null as Record<string, unknown> | null,
  pending: null as string | null,
}));

const checkRateLimit = vi.fn();
const verifyPasswordSideChannel = vi.fn();
const sendEmail = vi.fn();
const generateLink = vi.fn();
const rpc = vi.fn();

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(async () => state.ctx),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
}));
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: (...a: unknown[]) => verifyPasswordSideChannel(...a),
}));
vi.mock('@/lib/email/resend', () => ({ sendEmail: (a: unknown) => sendEmail(a) }));
vi.mock('@/lib/email/es/families/security', () => {
  const rendered = () => ({ subject: 's', html: '<p>h</p>', text: 't', from: 'from@example.test' });
  return {
    renderEmailChangeCurrentEmail: rendered,
    renderEmailChangeNewEmail: rendered,
    renderEmailChangedNoticeEmail: rendered,
  };
});
vi.mock('@/lib/env', () => {
  // A dull signing value under a neutral name (secret-shaped-fixtures.guard).
  const SIGNING_INPUT = 'test-only-signing-input';
  return {
    env: {
      NEXT_PUBLIC_APP_URL: 'https://app.example.test',
      SUPABASE_SERVICE_ROLE_KEY: SIGNING_INPUT,
    },
  };
});
vi.mock('@/server/services/audit', () => ({ insertAuditRowReported: vi.fn(async () => true) }));
vi.mock('@/server/services/auth-audit', () => ({
  resolveDefaultOrgAndRole: vi.fn(async () => ({ organizationId: ORG, role: 'staff' })),
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
      rpc: (...a: unknown[]) => rpc(...a),
      auth: {
        admin: {
          getUserById: async (id: string) => ({
            data: {
              user: {
                id,
                email: 'person@example.test',
                new_email: state.pending,
                email_change_sent_at: state.pending ? new Date().toISOString() : null,
              },
            },
            error: null,
          }),
          generateLink: (...a: unknown[]) => generateLink(...a),
        },
      },
    }),
  };
});

import { NextRequest } from 'next/server';

import { POST as cancelPOST } from './cancel/route';
import { POST as requestPOST } from './request/route';
import { POST as resendPOST } from './resend/route';

const USER = '99999999-9999-4999-8999-999999999999';
const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
const PENDING = 'pending@example.test';

/** The sentence the web's name and avatar answer a member who owes set-up with. */
const SET_UP_SENTENCE =
  'Multi-factor authentication required. Enroll in MFA before performing this action.';

/** The authenticator state withApiContext gives each kind of member. */
const OWES_SET_UP = { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: false };
const NOT_REQUIRED = { mfaRequired: false, mfaSatisfied: true, mfaEnrolled: false };
const ENROLLED_AAL2 = { mfaRequired: true, mfaSatisfied: true, mfaEnrolled: true };
const ENROLLED_AAL1 = { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: true };

function member(mfa: Record<string, boolean>) {
  return {
    organizationId: ORG,
    userId: USER,
    role: 'staff',
    supabase: {},
    enabledModules: new Set(),
    ...mfa,
  };
}

function post(path: string, body: unknown = {}) {
  return new NextRequest(`https://app.example.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-only-token' },
    body: JSON.stringify(body),
  });
}

const REQUEST_BODY = {
  newEmail: 'new-address@example.test',
  currentPassword: 'test-only-password',
};
const ask = () => requestPOST(post('/api/v1/account/email/request', REQUEST_BODY));
const resend = () => resendPOST(post('/api/v1/account/email/resend'));
const cancel = () => cancelPOST(post('/api/v1/account/email/cancel'));

function nothingSpent() {
  expect(checkRateLimit).not.toHaveBeenCalled();
  expect(verifyPasswordSideChannel).not.toHaveBeenCalled();
  expect(generateLink).not.toHaveBeenCalled();
  expect(sendEmail).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  state.ctx = member(OWES_SET_UP);
  state.pending = null;
  checkRateLimit.mockResolvedValue({ allowed: true, remaining: 2, resetAt: Date.now() + 1 });
  verifyPasswordSideChannel.mockResolvedValue({ ok: true });
  sendEmail.mockResolvedValue({ ok: true, id: 'msg' });
  rpc.mockImplementation(async (name: string) =>
    name === 'cancel_pending_email_change'
      ? { data: true, error: null }
      : { data: false, error: null },
  );
  generateLink.mockImplementation(async () => {
    state.pending = REQUEST_BODY.newEmail;
    return {
      data: { properties: { hashed_token: 'ef'.repeat(28), email_otp: '000000' } },
      error: null,
    };
  });
});

describe('a member who owes authenticator set-up', () => {
  it('request: 403 mfa_required with the name and avatar sentence, and nothing is spent, checked or sent', async () => {
    const res = await ask();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mfa_required', message: SET_UP_SENTENCE });
    nothingSpent();
  });

  it('resend: the same answer for a pending change, and nothing is spent or sent', async () => {
    state.pending = PENDING;
    const res = await resend();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mfa_required', message: SET_UP_SENTENCE });
    nothingSpent();
  });

  it('cancel still runs: it only removes the pending change', async () => {
    state.pending = PENDING;
    const res = await cancel();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
    expect(rpc).toHaveBeenCalledWith('cancel_pending_email_change', { p_user_id: USER });
  });
});

describe('everyone else keeps the rules they had', () => {
  it('a member whose organization does not require one starts a change: limits, then the password, then both links', async () => {
    state.ctx = member(NOT_REQUIRED);
    const res = await ask();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pendingEmail: REQUEST_BODY.newEmail });
    expect(checkRateLimit).toHaveBeenCalled();
    expect(verifyPasswordSideChannel).toHaveBeenCalled();
    expect(generateLink).toHaveBeenCalledTimes(2);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('a member with an authenticator at aal2 starts and resends a change', async () => {
    state.ctx = member(ENROLLED_AAL2);
    expect((await ask()).status).toBe(200);
    expect((await resend()).status).toBe(200);
  });

  it('a member with an authenticator whose session is not at aal2 is asked for the code, before the password', async () => {
    state.ctx = member(ENROLLED_AAL1);
    const res = await ask();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'aal2_required' });
    expect(verifyPasswordSideChannel).not.toHaveBeenCalled();
    expect(generateLink).not.toHaveBeenCalled();
  });

  it('a wrong password is still refused', async () => {
    state.ctx = member(NOT_REQUIRED);
    verifyPasswordSideChannel.mockResolvedValue({
      ok: false,
      reason: 'invalid_password',
      message: 'x',
    });
    const res = await ask();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: 'Current password is incorrect.',
    });
    expect(generateLink).not.toHaveBeenCalled();
  });

  it('the limits still answer 429 before the password is checked', async () => {
    state.ctx = member(NOT_REQUIRED);
    checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 1 });
    const res = await ask();
    expect(res.status).toBe(429);
    expect(verifyPasswordSideChannel).not.toHaveBeenCalled();
  });

  it('an account with no organization gets no context, so each route answers 401 as before', async () => {
    state.ctx = null;
    for (const call of [ask, resend, cancel]) {
      const res = await call();
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthenticated' });
    }
    nothingSpent();
    expect(rpc).not.toHaveBeenCalled();
  });
});
