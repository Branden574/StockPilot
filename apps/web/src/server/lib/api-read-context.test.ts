// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTHENTICATOR_SET_UP_OWED_COPY } from '@stockpilot/core';

import { AccountStatusUnavailableError } from '@/lib/auth/account-status';
import { withApiContext } from '@/lib/auth/api-context';
import { MembershipUnavailableError } from '@/lib/auth/membership-unavailable';

import {
  apiReadContext,
  isReadMethod,
  owesAuthenticatorSetUp,
  refuseSetUpOwedRead,
  setUpOwedReadBody,
} from './api-read-context';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));

/**
 * The read wrapper for /api/v1 GET handlers (server/lib/api-read-context.ts).
 *
 * A member whose organization requires an authenticator of their role, and
 * who has none, gets one answer on a read: 403 `forbidden` with core's
 * sentence and `details.reason: 'mfa_required'`, the shape the phone already
 * reads as "set one up first". withApiContext is mocked here; the real one,
 * on both sign-in paths and both ways of reading, is
 * api-read-context.set-up-reads.test.ts. Everyone else gets exactly what
 * withApiContext gave, the same object, so the route answers as it would
 * with withApiContext alone. A throw passes through unchanged, so a context
 * that could not be built keeps each route's own answer.
 */

const OWED = { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: false } as const;

function ctxWith(labels: { mfaRequired: boolean; mfaSatisfied: boolean; mfaEnrolled?: boolean }) {
  return {
    organizationId: '0a0a0a0a-1111-4222-8333-444444444444',
    userId: '0b0b0b0b-1111-4222-8333-444444444444',
    role: 'staff',
    permissions: new Set(['items:read']),
    enabledModules: new Set(),
    supabase: {},
    ...labels,
  } as never;
}

function req(method = 'GET', headers: Record<string, string> = { authorization: 'Bearer t' }) {
  return new Request('https://app.test/api/v1/items/lookup?code=123&token=hidden', {
    method,
    headers,
  });
}

/** Every label set a context can carry, with whether it owes set-up. */
const LABELS: Array<
  [string, { mfaRequired: boolean; mfaSatisfied: boolean; mfaEnrolled?: boolean }, boolean]
> = [];
for (const mfaRequired of [false, true]) {
  for (const mfaSatisfied of [false, true]) {
    for (const mfaEnrolled of [false, true, undefined]) {
      LABELS.push([
        `required ${mfaRequired}, satisfied ${mfaSatisfied}, enrolled ${String(mfaEnrolled)}`,
        { mfaRequired, mfaSatisfied, ...(mfaEnrolled === undefined ? {} : { mfaEnrolled }) },
        mfaRequired && !mfaSatisfied && mfaEnrolled !== true,
      ]);
    }
  }
}

async function expectHeldAnswer(read: Awaited<ReturnType<typeof apiReadContext>>, method = 'GET') {
  expect('response' in read).toBe(true);
  const res = (read as { response: Response }).response;
  expect(res.status).toBe(403);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  if (method !== 'HEAD') {
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: AUTHENTICATOR_SET_UP_OWED_COPY,
      details: { reason: 'mfa_required' },
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('apiReadContext', () => {
  it('asks withApiContext once, with the request alone, as every route does', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const r = req();
    await apiReadContext(r);
    expect(withApiContext).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withApiContext).mock.calls[0]).toEqual([r]);
    expect(vi.mocked(withApiContext).mock.calls[0]![0]).toBe(r);
  });

  it.each(['GET', 'HEAD'])(
    'a %s by a member who owes set-up: 403, core sentence, reason mfa_required, not stored',
    async (method) => {
      vi.mocked(withApiContext).mockResolvedValueOnce(ctxWith(OWED));
      await expectHeldAnswer(await apiReadContext(req(method)), method);
    },
  );

  it('writes one info line: method, path and how the session came; never the query or a token', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctxWith(OWED));
    await apiReadContext(req());
    expect(console.info).toHaveBeenCalledTimes(1);
    const line = JSON.stringify(vi.mocked(console.info).mock.calls[0]);
    expect(line).toContain('must set up an authenticator first');
    expect(line).toContain('"method":"GET"');
    expect(line).toContain('"path":"/api/v1/items/lookup"');
    expect(line).toContain('"via":"bearer"');
    expect(line).not.toContain('token=hidden');
    expect(line).not.toContain('code=123');

    vi.mocked(withApiContext).mockResolvedValueOnce(ctxWith(OWED));
    await apiReadContext(req('GET', { cookie: 'sb-x-auth-token=v' }));
    expect(JSON.stringify(vi.mocked(console.info).mock.calls[1])).toContain('"via":"cookie"');
  });

  it('a null context stays null, so the route keeps its own 401', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    expect(await apiReadContext(req())).toEqual({ ctx: null });
    expect(console.info).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
    'a %s by the same member is not held here: the context, unchanged',
    async (method) => {
      const ctx = ctxWith(OWED);
      vi.mocked(withApiContext).mockResolvedValueOnce(ctx);
      const read = await apiReadContext(req(method));
      expect(Object.keys(read)).toEqual(['ctx']);
      expect((read as { ctx: unknown }).ctx).toBe(ctx);
      expect(console.info).not.toHaveBeenCalled();
    },
  );

  it.each(LABELS.filter(([, , owed]) => !owed))(
    'parity for a member who owes nothing (%s): the same context object, no answer',
    async (_name, labels) => {
      const ctx = ctxWith(labels);
      vi.mocked(withApiContext).mockResolvedValueOnce(ctx);
      const read = await apiReadContext(req());
      expect(Object.keys(read)).toEqual(['ctx']);
      expect((read as { ctx: unknown }).ctx).toBe(ctx);
      expect(console.info).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['MembershipUnavailableError', () => new MembershipUnavailableError()],
    ['AccountStatusUnavailableError', () => new AccountStatusUnavailableError()],
    ['an unknown error', () => new Error('unknown')],
  ])('%s from withApiContext is thrown again unchanged', async (_name, make) => {
    const err = make();
    vi.mocked(withApiContext).mockRejectedValueOnce(err);
    await expect(apiReadContext(req())).rejects.toBe(err);
  });

  it('the body is core sentence, never the older service sentence, and a new object each call', () => {
    const a = setUpOwedReadBody();
    const b = setUpOwedReadBody();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.message).toBe(AUTHENTICATOR_SET_UP_OWED_COPY);
    expect(a.message).not.toMatch(/Multi-factor|MFA|two-factor/i);
  });
});

describe('refuseSetUpOwedRead and the predicate', () => {
  it.each(LABELS)('%s: owes set-up = %s', (_name, labels, owed) => {
    expect(owesAuthenticatorSetUp(labels)).toBe(owed);
    for (const method of ['GET', 'HEAD']) {
      expect(refuseSetUpOwedRead(req(method), ctxWith(labels)) !== null, method).toBe(owed);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(refuseSetUpOwedRead(req(method), ctxWith(labels)), method).toBeNull();
    }
  });

  it('GET and HEAD are the reads, in any case; nothing else is', () => {
    for (const m of ['GET', 'HEAD', 'get', 'head', 'Get']) expect(isReadMethod(m), m).toBe(true);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', '']) {
      expect(isReadMethod(m), m).toBe(false);
    }
  });
});
