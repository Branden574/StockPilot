// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S43c): a Server Action that works for an
 * organization does nothing for a session that still owes its authenticator
 * code. It is sent to /signin/mfa, and the redirect gets out of the action.
 *
 * Two kinds of action, both through the REAL session loader, gate and
 * withContext() (only the network is faked, and it records every call):
 *   - one that builds its context with withContext() and reads without asking
 *     for a permission (loadOlderItemActivityAction: an item's older activity);
 *   - one that asks requireOrgContext() directly (updateNotificationPreferences-
 *     Action).
 * Neither makes a table read for such a session. A member with no
 * authenticator goes on to the action's own reads, as before.
 *
 * And the actions that must run BEFORE the code still do, because they ask
 * requireSession(), which never asks for it: starting to set up a first
 * authenticator, and the recovery code on the code page.
 *
 * next/navigation is the real one: the redirect is Next's own control-flow
 * error, which each action's catch must let through
 * (action-catch.guard.test.ts).
 */

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
  return { createClient: async () => f.fixtureClient() };
});
vi.mock('@/lib/error-reporter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/error-reporter')>()),
  reportError: vi.fn(async () => {}),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 4 })),
}));

import { resetWorld, VERIFIED_FACTOR, world } from '@/test/step-up-session-fixture';

import { loadOlderItemActivityAction } from './activity';
import { consumeMfaRecoveryCodeAction } from './mfa-recovery';
import { enrollFactorAction } from './mfa';
import { updateNotificationPreferencesAction } from './notification-preferences';

const ITEM = '11111111-1111-4111-8111-111111111111';
const BEFORE = {
  movement: { createdAt: '2026-11-01T00:00:00.000Z', id: '22222222-2222-4222-8222-222222222222' },
};

const tableReads = () => world.calls.filter((c) => c.startsWith('from:'));

/** Next's redirect error for `to` (its digest names the destination). */
const redirectTo = (to: string) => ({
  digest: expect.stringMatching(`^NEXT_REDIRECT;[a-z]+;${to}`),
});
const CODE_PAGE = '/signin/mfa\\?redirect=%2Fdashboard%2Finventory%3Fview%3Dlow;';

beforeEach(() => {
  resetWorld();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('an action that reads through withContext() without asking for a permission', () => {
  const call = () => loadOlderItemActivityAction({ itemId: ITEM, before: BEFORE });

  it('a member with a verified factor at aal1: redirected to the code page, and nothing is read', async () => {
    world.factors = VERIFIED_FACTOR;
    await expect(call()).rejects.toMatchObject(redirectTo(CODE_PAGE));
    expect(tableReads()).toEqual([]);
  });

  it('a token that cannot be verified is no better than aal1', async () => {
    world.factors = VERIFIED_FACTOR;
    world.aal = 'aal2';
    world.claimsRead = 'error';
    await expect(call()).rejects.toMatchObject(redirectTo(CODE_PAGE));
    expect(tableReads()).toEqual([]);
  });

  it('an unreadable factor list: the generic failure, and nothing is read', async () => {
    world.factorRead = 'error';
    const result = await call();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('Something went wrong. Please try again.');
    expect(tableReads()).toEqual([]);
  });

  it('a member with no authenticator goes on to the reads, as before', async () => {
    await call();
    expect(tableReads().length).toBeGreaterThan(0);
  });

  it('the same member at aal2 goes on to the reads', async () => {
    world.factors = VERIFIED_FACTOR;
    world.aal = 'aal2';
    await call();
    expect(tableReads().length).toBeGreaterThan(0);
  });
});

describe('an action that asks requireOrgContext() directly', () => {
  const call = () => updateNotificationPreferencesAction({ push_low_stock: false });

  it('a member with a verified factor at aal1: redirected to the code page, and nothing is written', async () => {
    world.factors = VERIFIED_FACTOR;
    await expect(call()).rejects.toMatchObject(redirectTo(CODE_PAGE));
    expect(tableReads()).toEqual([]);
  });

  it('a member with no authenticator reaches the write, as before', async () => {
    await call().catch(() => undefined);
    expect(tableReads().length).toBeGreaterThan(0);
  });
});

describe('the actions that run before the code still run', () => {
  it('starting to set up a first authenticator, at aal1 with no factor yet', async () => {
    const result = await enrollFactorAction();
    expect(result).toEqual({
      ok: true,
      data: { factorId: 'factor-new', qrCode: 'qr', secret: 'secret', uri: 'otpauth://example' },
    });
  });

  it('the recovery code on the code page reaches its own checks on a session that owes the code', async () => {
    world.factors = VERIFIED_FACTOR;
    const result = await consumeMfaRecoveryCodeAction({ code: 'AAAA-BBBB-CCCC-DDDD' });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'forbidden',
        message: 'Your account password is required to use a recovery code.',
      }),
    });
    // The gate's reads were never made: this action asks requireSession().
    expect(world.calls.filter((c) => c === 'auth:getUser')).toEqual([]);
  });
});
