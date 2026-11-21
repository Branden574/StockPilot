// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTHENTICATOR_SET_UP_OWED_COPY,
  CONTEXT_UNAVAILABLE_COPY,
  isRefusedBeforeAnyWrite,
} from '@stockpilot/core';

import { AccountStatusUnavailableError } from '@/lib/auth/account-status';
import { withApiContext } from '@/lib/auth/api-context';
import { MembershipUnavailableError } from '@/lib/auth/membership-unavailable';
import { markMfaPolicyUnread } from '@/lib/auth/mfa-policy';

import {
  apiReadContext,
  isReadMethod,
  owesAuthenticatorSetUp,
  policyUnreadBody,
  refuseSetUpOwedRead,
  setUpOwedReadBody,
} from './api-read-context';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));

/**
 * The read wrapper for API reads (server/lib/api-read-context.ts).
 *
 * A member whose organization requires an authenticator of their role, and
 * who has none, gets one answer on a read (a GET or HEAD, or another method
 * whose caller hands 'read'): 403 `forbidden` with core's sentence and
 * `details.reason: 'mfa_required'`, the shape the phone already reads as "set
 * one up first". When the policy was not read (the context is marked), the
 * answer is the retryable 503 `check_failed` instead, which claims nothing
 * about the policy. withApiContext is mocked here; the real one,
 * on both sign-in paths and both ways of reading, is
 * api-read-context.set-up-reads.test.ts. Everyone else gets exactly what
 * withApiContext gave, the same object, so the route answers as it would
 * with withApiContext alone. A throw passes through unchanged, so a context
 * that could not be built keeps each route's own answer.
 */

const OWED = { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: false } as const;
const ORDER = '7e7e7e7e-8f8f-4a9a-8b0b-1c1c1c1c1c1c';

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

  it('writes one info line: the method and how the session came; never the path, the query or a token', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctxWith(OWED));
    await apiReadContext(
      new Request(`https://app.test/api/v1/orders/${ORDER}?code=123&token=hidden`, {
        headers: { authorization: 'Bearer t' },
      }),
    );
    expect(console.info).toHaveBeenCalledTimes(1);
    const line = JSON.stringify(vi.mocked(console.info).mock.calls[0]);
    expect(line).toContain('must set up an authenticator first');
    expect(line).toContain('"method":"GET"');
    expect(line).toContain('"via":"bearer"');
    expect(line).not.toContain(ORDER);
    expect(line).not.toContain('/api/');
    expect(line).not.toContain('token=hidden');
    expect(line).not.toContain('code=123');

    vi.mocked(withApiContext).mockResolvedValueOnce(ctxWith(OWED));
    await apiReadContext(req('GET', { cookie: 'sb-x-auth-token=v' }));
    expect(JSON.stringify(vi.mocked(console.info).mock.calls[1])).toContain('"via":"cookie"');
  });

  it.each(['GET', 'HEAD', 'POST'])(
    'a %s read whose policy was not read: the retryable 503 check_failed, never the set-up sentence',
    async (method) => {
      vi.mocked(withApiContext).mockResolvedValueOnce(markMfaPolicyUnread(ctxWith(OWED)));
      const read = await apiReadContext(req(method), method === 'POST' ? 'read' : undefined);
      expect('response' in read).toBe(true);
      const res = (read as { response: Response }).response;
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      if (method !== 'HEAD') {
        const body = await res.json();
        expect(body).toEqual({
          error: 'check_failed',
          message: CONTEXT_UNAVAILABLE_COPY,
          details: { reason: 'context_unavailable', retryable: true },
        });
        // Not the API context gate's "nothing was written" marker: a read needs none.
        expect(
          isRefusedBeforeAnyWrite({ status: 503, code: body.error, details: body.details }),
        ).toBe(false);
      }
      expect(JSON.stringify(vi.mocked(console.info).mock.calls[0])).toContain(
        'the authenticator policy could not be read',
      );
    },
  );

  it('a policy that was not read, for a member who owes nothing (an authenticator at aal2): the context, unchanged', async () => {
    const ctx = markMfaPolicyUnread(
      ctxWith({ mfaRequired: true, mfaSatisfied: true, mfaEnrolled: true }),
    );
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx);
    const read = await apiReadContext(req());
    expect((read as { ctx: unknown }).ctx).toBe(ctx);
  });

  it('a write whose policy was not read is not held here either', async () => {
    const ctx = markMfaPolicyUnread(ctxWith(OWED));
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx);
    expect((await apiReadContext(req('POST'))) as unknown).toEqual({ ctx });
  });

  it('a POST whose caller hands it read is held like a GET; a GET handed nothing is still held', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctxWith(OWED));
    await expectHeldAnswer(await apiReadContext(req('POST'), 'read'));
    vi.mocked(withApiContext).mockResolvedValueOnce(ctxWith(OWED));
    await expectHeldAnswer(await apiReadContext(req('GET')));
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
    const c = policyUnreadBody();
    expect(c).toEqual(policyUnreadBody());
    expect(c).not.toBe(policyUnreadBody());
    expect(c).not.toHaveProperty('details.nothingWritten');
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
      expect(refuseSetUpOwedRead(req(method), ctxWith(labels), 'write'), method).toBeNull();
      // A gate's own kind 'read' (the return options POST): held like a GET.
      expect(refuseSetUpOwedRead(req(method), ctxWith(labels), 'read') !== null, method).toBe(owed);
    }
    // A GET handed 'write' by mistake is still a read.
    expect(refuseSetUpOwedRead(req('GET'), ctxWith(labels), 'write') !== null).toBe(owed);
  });

  it('GET and HEAD are the reads, in any case; nothing else is', () => {
    for (const m of ['GET', 'HEAD', 'get', 'head', 'Get']) expect(isReadMethod(m), m).toBe(true);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', '']) {
      expect(isReadMethod(m), m).toBe(false);
    }
  });
});
