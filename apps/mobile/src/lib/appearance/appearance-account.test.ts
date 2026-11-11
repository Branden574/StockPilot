import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The person's own appearance row through the signed-in Supabase client
 * (revision R3, item 35): two nullable columns, a save that names only the
 * axes the person chose (a Theme save never clears a Design), the whole row
 * echoed back for the reducer's check and adoption; and the one look at the
 * stored session the first start of the new JS makes (item 31).
 */

const calls = vi.hoisted(() => ({
  log: [] as unknown[][],
  answer: { data: null as unknown, error: null as unknown },
  session: null as null | { user: { id: string } },
  aal: { currentLevel: 'aal1', nextLevel: 'aal1' } as {
    currentLevel: string | null;
    nextLevel: string | null;
  },
  sessionThrows: false,
}));

vi.mock('../supabase', () => {
  const chain = () => {
    const builder: Record<string, (...args: unknown[]) => unknown> = {};
    for (const name of ['from', 'select', 'eq', 'upsert']) {
      builder[name] = (...args: unknown[]) => {
        calls.log.push([name, ...args]);
        return builder;
      };
    }
    builder.maybeSingle = () => Promise.resolve(calls.answer);
    builder.single = () => Promise.resolve(calls.answer);
    return builder;
  };
  return {
    supabase: {
      from: (...args: unknown[]) => chain().from!(...args),
      auth: {
        getSession: async () => {
          if (calls.sessionThrows) throw new Error('keychain locked');
          return { data: { session: calls.session } };
        },
        mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: calls.aal }) },
      },
    },
  };
});

const USER_A = '6f1c2a9e-1b2c-4d3e-8f40-0a1b2c3d4e5f';

beforeEach(() => {
  calls.log = [];
  calls.answer = { data: null, error: null };
  calls.session = null;
  calls.aal = { currentLevel: 'aal1', nextLevel: 'aal1' };
  calls.sessionThrows = false;
});

describe('the account row', () => {
  it('reads both columns of the person’s own row', async () => {
    const { supabaseAppearanceAccount } = await import('./account');
    calls.answer = {
      data: { style: 'classic', theme: null, updated_at: '2026-11-03T10:00:00Z' },
      error: null,
    };
    await expect(supabaseAppearanceAccount.fetch(USER_A)).resolves.toEqual({
      ok: true,
      row: { style: 'classic', theme: null, updated_at: '2026-11-03T10:00:00Z' },
    });
    expect(calls.log).toEqual([
      ['from', 'user_appearance'],
      ['select', 'style, theme, updated_at'],
      ['eq', 'user_id', USER_A],
    ]);
  });

  it('saves only the axes it is given, and reads the whole row back', async () => {
    const { supabaseAppearanceAccount } = await import('./account');
    calls.answer = {
      data: { style: 'classic', theme: 'dark', updated_at: '2026-11-03T10:00:01Z' },
      error: null,
    };
    await supabaseAppearanceAccount.save(USER_A, { theme: 'dark' });
    expect(calls.log).toEqual([
      ['from', 'user_appearance'],
      ['upsert', { user_id: USER_A, theme: 'dark' }, { onConflict: 'user_id' }],
      ['select', 'style, theme, updated_at'],
    ]);
    calls.log = [];
    await supabaseAppearanceAccount.save(USER_A, { style: 'classic', theme: 'light' });
    expect(calls.log[1]).toEqual([
      'upsert',
      { user_id: USER_A, style: 'classic', theme: 'light' },
      { onConflict: 'user_id' },
    ]);
  });

  it('a missing table says so; any other error is a plain failure', async () => {
    const { supabaseAppearanceAccount } = await import('./account');
    calls.answer = { data: null, error: { code: 'PGRST205' } };
    await expect(supabaseAppearanceAccount.fetch(USER_A)).resolves.toEqual({
      ok: false,
      reason: 'missing-table',
    });
    calls.answer = { data: null, error: { code: '42501' } };
    await expect(supabaseAppearanceAccount.save(USER_A, { style: 'classic' })).resolves.toEqual({
      ok: false,
      reason: 'error',
    });
  });
});

describe('who is signed in at the first start (item 31)', () => {
  it('the stored session’s person, when it owes no authenticator code', async () => {
    const { peekSignedInUser } = await import('./account');
    calls.session = { user: { id: USER_A } };
    await expect(peekSignedInUser()).resolves.toBe(USER_A);
    calls.aal = { currentLevel: 'aal2', nextLevel: 'aal2' };
    await expect(peekSignedInUser()).resolves.toBe(USER_A);
  });

  it('nobody: no session, a session that still owes its code, or a refused read', async () => {
    const { peekSignedInUser } = await import('./account');
    await expect(peekSignedInUser()).resolves.toBeNull();
    calls.session = { user: { id: USER_A } };
    calls.aal = { currentLevel: 'aal1', nextLevel: 'aal2' };
    await expect(peekSignedInUser()).resolves.toBeNull();
    calls.sessionThrows = true;
    await expect(peekSignedInUser()).resolves.toBeNull();
    calls.sessionThrows = false;
    calls.session = { user: { id: 'not-a-uuid' } };
    calls.aal = { currentLevel: 'aal1', nextLevel: 'aal1' };
    await expect(peekSignedInUser()).resolves.toBeNull();
  });
});
