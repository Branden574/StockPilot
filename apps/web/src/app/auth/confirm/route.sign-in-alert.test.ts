// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NextRequest } from 'next/server';

/**
 * Part 3 (sign-in alerts): a sign-in by emailed link. A magic link or a
 * password-reset link makes a session without the password step, so until now
 * it called nothing that notes a device. After a verifyOtp that signs a person
 * in by one of those two link types, the route notes the device, the country
 * and the session the same way the password sign-in does, AFTER the response:
 * the answer and its timing do not change. An invite and an email change are
 * not sign-ins of an existing account and note nothing; neither does a link
 * that fails, or one that made no session.
 *
 * Every id and address is made up; the signing value is a dull one under a
 * neutral name (src/test/secret-shaped-fixtures.guard.test.ts).
 */

const SIGNING_INPUT = vi.hoisted(() => {
  const value = 'test-only-signing-input';
  process.env.SUPABASE_SERVICE_ROLE_KEY = value;
  return value;
});

const h = vi.hoisted(() => ({
  deferred: [] as Array<() => Promise<unknown>>,
  noteLoginDevice: vi.fn(async (_a: Record<string, unknown>) => undefined),
  verifyOtp: vi.fn(),
  getClaims: vi.fn(),
}));

vi.mock('@/server/services/lib/defer', () => ({
  defer: (fn: () => Promise<unknown>) => h.deferred.push(fn),
  keepAlive: vi.fn(),
}));
vi.mock('@/lib/auth/login-device', () => ({ noteLoginDevice: h.noteLoginDevice }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      verifyOtp: h.verifyOtp,
      getClaims: h.getClaims,
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
    },
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ auth: { admin: { getUserById: vi.fn() } } }),
}));
vi.mock('@/server/services/email-change', () => ({
  completeEmailChange: vi.fn(async () => ({})),
  EMAIL_CHANGE_RETURN_PATH: '/dashboard/settings/profile',
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

import { signConfirmRecipient } from '@/lib/auth/confirm-recipient';

import { PRESS_GATE_PASSED_FIELD, PRESS_GATE_PASSED_VALUE } from './press-gate';
import { POST } from './route';

const BASE = 'https://app.example.test';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '5e551011-0000-4000-8000-0000000000c1';
const HASH = 'ab'.repeat(28);
const TOKEN = 'header.payload.signature';

function press(type: string, headers: Record<string, string> = {}): NextRequest {
  const r = signConfirmRecipient(SIGNING_INPUT, {
    type,
    tokenHash: HASH,
    userId: USER,
    issued: Math.floor(Date.now() / 1000),
  })!;
  const form = new URLSearchParams({
    token_hash: HASH,
    type,
    r,
    [PRESS_GATE_PASSED_FIELD]: PRESS_GATE_PASSED_VALUE,
  });
  return new NextRequest(`${BASE}/auth/confirm`, {
    method: 'POST',
    body: form.toString(),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'same-origin',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Firefox/128.0',
      'x-forwarded-for': '203.0.113.7',
      'x-vercel-ip-country': 'MX',
      'x-vercel-ip-city': 'Tijuana',
      ...headers,
    },
  });
}

function signedIn() {
  h.verifyOtp.mockResolvedValue({
    data: {
      session: { access_token: TOKEN, user: { id: USER, email: 'member@example.test' } },
      user: { id: USER },
    },
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.deferred.length = 0;
  vi.stubEnv('VERCEL', '1');
  signedIn();
  h.getClaims.mockResolvedValue({ data: { claims: { sub: USER, session_id: SESSION } }, error: null });
});

describe('POST /auth/confirm notes a sign-in by emailed link (part 3)', () => {
  it.each(['magiclink', 'recovery'])(
    '%s: the same redirect as before, and the device is noted after the response with place, session and client',
    async (type) => {
      const res = await POST(press(type));
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(
        type === 'recovery' ? `${BASE}/reset/complete` : `${BASE}/dashboard`,
      );
      // Nothing ran before the answer.
      expect(h.noteLoginDevice).not.toHaveBeenCalled();
      expect(h.getClaims).not.toHaveBeenCalled();
      expect(h.deferred).toHaveLength(1);

      await h.deferred[0]!();
      expect(h.getClaims).toHaveBeenCalledWith(TOKEN);
      expect(h.noteLoginDevice).toHaveBeenCalledWith({
        userId: USER,
        email: 'member@example.test',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/128.0',
        ip: '203.0.113.7',
        place: { country: 'MX', city: 'Tijuana' },
        sessionId: SESSION,
        client: 'web',
      });
    },
  );

  it('an invite notes nothing: it makes an account, it is not a sign-in of one', async () => {
    const res = await POST(press('invite'));
    expect(res.status).toBe(303);
    expect(h.deferred).toEqual([]);
    expect(h.noteLoginDevice).not.toHaveBeenCalled();
  });

  it('an email change notes nothing', async () => {
    await POST(press('email_change'));
    expect(h.deferred).toEqual([]);
  });

  it('a link that fails notes nothing', async () => {
    h.verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'expired' } });
    const res = await POST(press('magiclink'));
    expect(res.headers.get('location')).toBe(`${BASE}/signin?error=auth_callback_failed`);
    expect(h.deferred).toEqual([]);
  });

  it('a verified link that made no session notes nothing', async () => {
    h.verifyOtp.mockResolvedValue({ data: { session: null, user: { id: USER } }, error: null });
    await POST(press('magiclink'));
    expect(h.deferred).toEqual([]);
  });

  it('a token whose claims name another account gives no session id', async () => {
    h.getClaims.mockResolvedValue({ data: { claims: { sub: 'someone-else', session_id: SESSION } }, error: null });
    await POST(press('magiclink'));
    await h.deferred[0]!();
    expect(h.noteLoginDevice).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null }));
  });

  it('a post from another site is refused before verifyOtp, and nothing is noted', async () => {
    await POST(press('magiclink', { 'sec-fetch-site': 'cross-site' }));
    expect(h.verifyOtp).not.toHaveBeenCalled();
    expect(h.deferred).toEqual([]);
  });
});
