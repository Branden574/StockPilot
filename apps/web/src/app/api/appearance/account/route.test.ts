// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/appearance/account: the signed-in person's own Design and Theme
 * row, read by a plain request instead of a server action (a server action
 * pending on load holds the hydration of the page's streamed content and a
 * client redirect; measured 2026-11-11). It answers the union the action
 * answers, from the same server function, and only to a page of this origin
 * that sends `x-sp-appearance: 1`, for the session's own account, once that
 * session owes no authenticator code. Every answer is no-store, and the route
 * itself sets no cookie.
 */

const {
  getUser,
  cookieSessionOwesStepUp,
  readVerifiedSessionTokenOf,
  createAccessTokenClient,
  reportError,
  calls,
  answer,
} = vi.hoisted(() => ({
  getUser: vi.fn(),
  cookieSessionOwesStepUp: vi.fn(),
  readVerifiedSessionTokenOf: vi.fn(),
  createAccessTokenClient: vi.fn(),
  reportError: vi.fn(),
  calls: [] as { op: string; args: unknown[] }[],
  answer: { current: { data: null as unknown, error: null as unknown } },
}));

const cookieClient = { auth: { getUser: (...a: unknown[]) => getUser(...a) } };
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => cookieClient) }));
vi.mock('@/lib/auth/api-context', () => ({
  cookieSessionOwesStepUp: (...a: unknown[]) => cookieSessionOwesStepUp(...a),
}));
vi.mock('@/lib/auth/verified-claims', () => ({
  readVerifiedSessionTokenOf: (...a: unknown[]) => readVerifiedSessionTokenOf(...a),
}));
vi.mock('@/lib/supabase/access-token-client', () => ({
  createAccessTokenClient: (...a: unknown[]) => createAccessTokenClient(...a),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));

import * as route from './route';

const { POST } = route;

const URL_ = 'https://app.example.test/api/appearance/account';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const ROW = { style: 'classic', theme: 'dark', updated_at: '2026-11-02T10:00:00.123456+00:00' };

const SAME_ORIGIN = {
  'sec-fetch-site': 'same-origin',
  'x-sp-appearance': '1',
  'content-type': 'application/json',
};

function request(body: unknown, headers: Record<string, string> = SAME_ORIGIN): Request {
  return new Request(URL_, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function fakeClient() {
  const chain: Record<string, unknown> = {};
  const record =
    (op: string, result?: () => unknown) =>
    (...args: unknown[]) => {
      calls.push({ op, args });
      return result ? result() : chain;
    };
  Object.assign(chain, {
    from: record('from'),
    select: record('select'),
    eq: record('eq'),
    maybeSingle: record('maybeSingle', () => Promise.resolve(answer.current)),
  });
  return chain;
}

/** No answer may be stored, and the route sets no cookie of its own. */
function expectPlain(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('set-cookie')).toBeNull();
}

beforeEach(() => {
  calls.length = 0;
  answer.current = { data: null, error: null };
  getUser.mockReset();
  cookieSessionOwesStepUp.mockReset();
  readVerifiedSessionTokenOf.mockReset();
  createAccessTokenClient.mockReset();
  reportError.mockReset();
  getUser.mockResolvedValue({ data: { user: { id: USER_A, factors: [] } }, error: null });
  cookieSessionOwesStepUp.mockResolvedValue(false);
  readVerifiedSessionTokenOf.mockImplementation(async (_client: unknown, userId: string) =>
    userId === USER_A ? { token: 'token-a', claims: { userId: USER_A } } : null,
  );
  createAccessTokenClient.mockImplementation(() => fakeClient());
});

describe('POST /api/appearance/account', () => {
  it('answers the row the server holds, read as the verified token, own row only', async () => {
    answer.current = { data: ROW, error: null };
    const response = await POST(request({ userId: USER_A }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, userId: USER_A, row: ROW });
    expectPlain(response);
    // The one session the route validated is the one the read verifies.
    expect(readVerifiedSessionTokenOf).toHaveBeenCalledWith(cookieClient, USER_A);
    expect(createAccessTokenClient).toHaveBeenCalledWith('token-a');
    expect(calls.map((c) => c.op)).toEqual(['from', 'select', 'eq', 'maybeSingle']);
    expect(calls[0]!.args).toEqual(['user_appearance']);
    expect(calls[1]!.args).toEqual(['style, theme, updated_at']);
    expect(calls[2]!.args).toEqual(['user_id', USER_A]);
  });

  it('answers a null row for a person who never chose on an account', async () => {
    const response = await POST(request({ userId: USER_A }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, userId: USER_A, row: null });
    expectPlain(response);
  });

  it('accepts a matching Origin when the browser sends no Sec-Fetch-Site', async () => {
    const response = await POST(
      request({ userId: USER_A }, { origin: 'https://app.example.test', 'x-sp-appearance': '1' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, userId: USER_A, row: null });
  });

  it('refuses a request without the x-sp-appearance header, before any session is read', async () => {
    const without: Record<string, string>[] = [
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'same-origin', 'x-sp-appearance': '0' },
    ];
    for (const headers of without) {
      const response = await POST(request({ userId: USER_A }, headers));
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('');
      expectPlain(response);
    }
    expect(getUser).not.toHaveBeenCalled();
    expect(readVerifiedSessionTokenOf).not.toHaveBeenCalled();
  });

  it.each([
    ['another site', { 'sec-fetch-site': 'cross-site', 'x-sp-appearance': '1' }],
    ['a sibling subdomain', { 'sec-fetch-site': 'same-site', 'x-sp-appearance': '1' }],
    ['another origin', { origin: 'https://evil.example.test', 'x-sp-appearance': '1' }],
    ['an origin it will not name', { origin: 'null', 'x-sp-appearance': '1' }],
    ['neither Origin nor Sec-Fetch-Site', { 'x-sp-appearance': '1' }],
  ])('refuses a request from %s, before any session is read', async (_name, headers) => {
    const response = await POST(request({ userId: USER_A }, headers));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('');
    expectPlain(response);
    expect(getUser).not.toHaveBeenCalled();
    expect(readVerifiedSessionTokenOf).not.toHaveBeenCalled();
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['an empty body', ''],
    ['no user id', {}],
    ['a user id that is not a uuid', { userId: 'someone' }],
    ['a user id that is not text', { userId: 7 }],
    ['a list', [USER_A]],
    ['more than 256 bytes', { userId: USER_A, padding: 'x'.repeat(300) }],
  ])('answers invalid (400) for %s, before any session is read', async (_name, body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, reason: 'invalid' });
    expectPlain(response);
    expect(getUser).not.toHaveBeenCalled();
    expect(readVerifiedSessionTokenOf).not.toHaveBeenCalled();
  });

  it('answers unauthenticated, in JSON and never a redirect, for a signed-out browser', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { name: 'AuthSessionMissingError' } });
    const response = await POST(request({ userId: USER_A }));
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('content-type')).toMatch(/^application\/json/u);
    expect(await response.json()).toEqual({ ok: false, reason: 'unauthenticated' });
    expectPlain(response);
    expect(readVerifiedSessionTokenOf).not.toHaveBeenCalled();
    expect(createAccessTokenClient).not.toHaveBeenCalled();
  });

  it("refuses another person's id: the session's own account is the only one it reads", async () => {
    const response = await POST(request({ userId: USER_B }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: 'unauthenticated' });
    expectPlain(response);
    expect(createAccessTokenClient).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('refuses when the session changed hands between the two reads of it', async () => {
    // getUser validated A, but the verified token is no longer A's.
    readVerifiedSessionTokenOf.mockResolvedValue(null);
    const response = await POST(request({ userId: USER_A }));
    expect(await response.json()).toEqual({ ok: false, reason: 'unauthenticated' });
    expect(createAccessTokenClient).not.toHaveBeenCalled();
  });

  it('refuses a session that still owes its authenticator code, before the row is read', async () => {
    cookieSessionOwesStepUp.mockResolvedValue(true);
    const response = await POST(request({ userId: USER_A }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: 'unauthenticated' });
    expectPlain(response);
    expect(cookieSessionOwesStepUp).toHaveBeenCalledWith(
      cookieClient,
      expect.objectContaining({ id: USER_A }),
    );
    expect(readVerifiedSessionTokenOf).not.toHaveBeenCalled();
    expect(createAccessTokenClient).not.toHaveBeenCalled();
  });

  it('answers missing-table when the web is ahead of the migration, and reports nothing', async () => {
    answer.current = { data: null, error: { code: '42P01', message: 'relation does not exist' } };
    const response = await POST(request({ userId: USER_A }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: 'missing-table' });
    expectPlain(response);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('answers error for any other failed read, reported under the tag the action used', async () => {
    answer.current = { data: null, error: { code: '57014', message: 'canceling statement' } };
    const response = await POST(request({ userId: USER_A }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: 'error' });
    expectPlain(response);
    expect(reportError).toHaveBeenCalledWith(expect.anything(), {
      tag: 'appearance.read',
      level: 'warning',
    });
  });

  it('answers error when the session cannot be read at all', async () => {
    getUser.mockRejectedValue(new Error('the Auth server did not answer'));
    const response = await POST(request({ userId: USER_A }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: 'error' });
    expectPlain(response);
    expect(reportError).toHaveBeenCalledWith(expect.anything(), {
      tag: 'appearance.read',
      level: 'warning',
    });
  });

  it('is POST only, and never cached or prerendered', () => {
    const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
    expect(methods.filter((m) => m in route)).toEqual(['POST']);
    expect(route.dynamic).toBe('force-dynamic');
  });
});
