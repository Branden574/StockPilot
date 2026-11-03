import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The self-only appearance actions (Liquid Glass plan 3.2-3.4): zod-validated,
 * acting only as the verified person the browser names, writing only that
 * person's own row, and answering with the row the server holds or a reason.
 */

const { readVerifiedSessionTokenOf, createAccessTokenClient, reportError, calls, answer } =
  vi.hoisted(() => ({
    readVerifiedSessionTokenOf: vi.fn(),
    createAccessTokenClient: vi.fn(),
    reportError: vi.fn(),
    calls: [] as { op: string; args: unknown[] }[],
    answer: { current: { data: null as unknown, error: null as unknown } },
  }));

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({ cookie: true })) }));
vi.mock('@/lib/auth/verified-claims', () => ({
  readVerifiedSessionTokenOf: (...args: unknown[]) => readVerifiedSessionTokenOf(...args),
}));
vi.mock('@/lib/supabase/access-token-client', () => ({
  createAccessTokenClient: (...args: unknown[]) => createAccessTokenClient(...args),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));

import { getMyAppearanceAction, setMyAppearanceAction } from './appearance';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

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
    upsert: record('upsert'),
    maybeSingle: record('maybeSingle', () => Promise.resolve(answer.current)),
    single: record('single', () => Promise.resolve(answer.current)),
  });
  return chain;
}

beforeEach(() => {
  calls.length = 0;
  answer.current = { data: null, error: null };
  readVerifiedSessionTokenOf.mockReset();
  createAccessTokenClient.mockReset();
  reportError.mockReset();
  readVerifiedSessionTokenOf.mockImplementation(async (_client: unknown, userId: string) =>
    userId === USER_A ? { token: 'token-a', claims: { userId: USER_A } } : null,
  );
  createAccessTokenClient.mockImplementation(() => fakeClient());
});

describe('setMyAppearanceAction', () => {
  it('refuses anything but the four words and a user id, before any request', async () => {
    for (const appearance of ['Liquid Glass', '', 'LIGHT', 'glass', null, 3]) {
      expect(await setMyAppearanceAction({ userId: USER_A, appearance })).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
    expect(await setMyAppearanceAction({ userId: 'not-a-uuid', appearance: 'dark' })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(readVerifiedSessionTokenOf).not.toHaveBeenCalled();
  });

  it('writes only when the verified session is the person named, as that token, own row only', async () => {
    answer.current = {
      data: { appearance: 'liquid-glass', updated_at: '2026-11-02T10:00:00.123456+00:00' },
      error: null,
    };
    const result = await setMyAppearanceAction({ userId: USER_A, appearance: 'liquid-glass' });
    expect(result).toEqual({
      ok: true,
      userId: USER_A,
      row: { appearance: 'liquid-glass', updated_at: '2026-11-02T10:00:00.123456+00:00' },
    });
    expect(createAccessTokenClient).toHaveBeenCalledWith('token-a');
    expect(calls.map((c) => c.op)).toEqual(['from', 'upsert', 'select', 'single']);
    expect(calls[0]!.args).toEqual(['user_appearance']);
    expect(calls[1]!.args).toEqual([
      { user_id: USER_A, appearance: 'liquid-glass' },
      { onConflict: 'user_id' },
    ]);
  });

  it('never writes another person’s row: a session that is not the person named is unauthenticated', async () => {
    expect(await setMyAppearanceAction({ userId: USER_B, appearance: 'dark' })).toEqual({
      ok: false,
      reason: 'unauthenticated',
    });
    expect(createAccessTokenClient).not.toHaveBeenCalled();
  });

  it('says the account store is missing (PGRST205 / 42P01), so the page never claims sync', async () => {
    for (const code of ['PGRST205', '42P01']) {
      answer.current = { data: null, error: { code, message: 'missing' } };
      expect(await setMyAppearanceAction({ userId: USER_A, appearance: 'dark' })).toEqual({
        ok: false,
        reason: 'missing-table',
      });
    }
    expect(reportError).not.toHaveBeenCalled();
  });

  it('reports any other failure and answers error', async () => {
    answer.current = { data: null, error: { code: '42501', message: 'denied' } };
    expect(await setMyAppearanceAction({ userId: USER_A, appearance: 'dark' })).toEqual({
      ok: false,
      reason: 'error',
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    createAccessTokenClient.mockImplementation(() => {
      throw new Error('network');
    });
    expect(await setMyAppearanceAction({ userId: USER_A, appearance: 'dark' })).toEqual({
      ok: false,
      reason: 'error',
    });
  });
});

describe('getMyAppearanceAction', () => {
  it('reads the person’s own row, or null when they never chose', async () => {
    expect(await getMyAppearanceAction(USER_A)).toEqual({ ok: true, userId: USER_A, row: null });
    expect(calls.map((c) => c.op)).toEqual(['from', 'select', 'eq', 'maybeSingle']);
    expect(calls[2]!.args).toEqual(['user_id', USER_A]);
    answer.current = {
      data: { appearance: 'dark', updated_at: '2026-11-02T10:00:00+00:00' },
      error: null,
    };
    expect(await getMyAppearanceAction(USER_A)).toEqual({
      ok: true,
      userId: USER_A,
      row: { appearance: 'dark', updated_at: '2026-11-02T10:00:00+00:00' },
    });
  });

  it('refuses a malformed id and another person', async () => {
    expect(await getMyAppearanceAction('x')).toEqual({ ok: false, reason: 'invalid' });
    expect(await getMyAppearanceAction(USER_B)).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('says the account store is missing', async () => {
    answer.current = { data: null, error: { code: 'PGRST205', message: 'missing' } };
    expect(await getMyAppearanceAction(USER_A)).toEqual({ ok: false, reason: 'missing-table' });
  });
});
