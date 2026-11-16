// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The phone's sign-in email change routes (/api/v1/account/email, /request,
 * /resend, /cancel) when the caller's access cannot be read: withApiContext
 * refuses with AccountStatusUnavailableError, MembershipUnavailableError or
 * PermissionsUnavailableError before the route does anything. Each route
 * answers through the API context gate (server/lib/api-context-gate.ts): 503
 * with core's contextUnavailableBody(), Retry-After 5 and no caching, the
 * answer the phone reads as "nothing was saved, try again". Nothing is spent,
 * checked, minted, sent, reconciled or recorded.
 *
 * Real: the four routes, the gate, their glue and the service. Faked: the
 * context, the service client, the limits, the password check and the emails.
 */

const withApiContext = vi.hoisted(() => vi.fn());
const checkRateLimit = vi.hoisted(() => vi.fn());
const verifyPasswordSideChannel = vi.hoisted(() => vi.fn());
const sendEmail = vi.hoisted(() => vi.fn());
const generateLink = vi.hoisted(() => vi.fn());
const getUserById = vi.hoisted(() => vi.fn());
const adminFrom = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() => vi.fn());
const insertAuditRowReported = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@/lib/auth/api-context', () => ({ withApiContext }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit }));
vi.mock('@/lib/auth/verify-password', () => ({ verifyPasswordSideChannel }));
vi.mock('@/lib/email/resend', () => ({ sendEmail }));
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
vi.mock('@/server/services/audit', () => ({ insertAuditRowReported }));
vi.mock('@/server/services/auth-audit', () => ({
  resolveDefaultOrgAndRole: vi.fn(async () => ({ organizationId: null, role: null })),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: adminFrom,
    rpc,
    auth: { admin: { getUserById, generateLink } },
  }),
}));

import { NextRequest } from 'next/server';

import { contextUnavailableBody } from '@stockpilot/core';

import { AccountStatusUnavailableError } from '@/lib/auth/account-status';
import { PermissionsUnavailableError } from '@/lib/auth/effective-permissions';
import { MembershipUnavailableError } from '@/lib/auth/membership-unavailable';

import { POST as cancelPOST } from './cancel/route';
import { POST as requestPOST } from './request/route';
import { POST as resendPOST } from './resend/route';
import { GET as statusGET } from './route';

function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  return new NextRequest(`https://app.example.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-only-token' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const ROUTES = [
  ['GET /api/v1/account/email', () => statusGET(call('GET', '/api/v1/account/email'))],
  [
    'POST /api/v1/account/email/request',
    () =>
      requestPOST(
        call('POST', '/api/v1/account/email/request', {
          newEmail: 'new-address@example.test',
          currentPassword: 'test-only-password',
        }),
      ),
  ],
  [
    'POST /api/v1/account/email/resend',
    () => resendPOST(call('POST', '/api/v1/account/email/resend', {})),
  ],
  [
    'POST /api/v1/account/email/cancel',
    () => cancelPOST(call('POST', '/api/v1/account/email/cancel', {})),
  ],
] as const;

const REFUSALS = [
  ['AccountStatusUnavailableError', () => new AccountStatusUnavailableError()],
  ['MembershipUnavailableError', () => new MembershipUnavailableError()],
  ['PermissionsUnavailableError', () => new PermissionsUnavailableError()],
] as const;

const CASES = ROUTES.flatMap(([route, send]) =>
  REFUSALS.map(([name, make]) => [route, name, send, make] as const),
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe("the phone's email change routes when the caller's access cannot be read", () => {
  it.each(CASES)(
    '%s, %s: 503 with the try-again answer, and nothing runs',
    async (_r, _n, send, make) => {
      withApiContext.mockRejectedValueOnce(make());
      const res = await send();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual(contextUnavailableBody());
      expect(res.headers.get('Retry-After')).toBe('5');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(withApiContext).toHaveBeenCalledTimes(1);
      // Nothing spent, checked, read, minted, sent, reconciled or recorded.
      expect(checkRateLimit).not.toHaveBeenCalled();
      expect(verifyPasswordSideChannel).not.toHaveBeenCalled();
      expect(getUserById).not.toHaveBeenCalled();
      expect(generateLink).not.toHaveBeenCalled();
      expect(sendEmail).not.toHaveBeenCalled();
      expect(adminFrom).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
      expect(insertAuditRowReported).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES)('%s: signed out is still the 401', async (_route, send) => {
    withApiContext.mockResolvedValueOnce(null);
    const res = await send();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
  });

  it.each(ROUTES)(
    '%s: any other failure of the context step is not turned into the 503',
    async (_route, send) => {
      withApiContext.mockRejectedValueOnce(new Error('something else'));
      await expect(send()).rejects.toThrow('something else');
    },
  );
});
