import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S43c): requireOrgContext() hands out no
 * organization context to a session that still owes its authenticator code.
 *
 * A member who has a verified factor, on a session that is not at aal2, is
 * sent to /signin/mfa, with the page to come back to. That is the rule the
 * dashboard layout applies to a page load; here it holds for every caller of
 * requireOrgContext(): every dashboard page by itself, and every Server Action
 * that works for an organization (directly, or through withContext()).
 *
 * Pinned with it:
 *   - what it does NOT ask: a member with no verified factor passes whatever
 *     the organization's policy says (the layout and assertPermission answer
 *     the policy, as before), and requireSession() never asks for the code
 *     (the code page, the recovery code and enrolling run on it);
 *   - what it costs: nothing but a local check at aal2, one Auth read
 *     otherwise;
 *   - that it fails closed: an unreadable factor list is an error, never
 *     "no factor", and claims or a list of another account count for nothing.
 *
 * Outside a render, as here, React cache() is a pass-through: exactly the
 * Server Action case. session.ts, the gate, request-cache, the bundle parser
 * and the verified claims read are REAL; only the network is faked, and it
 * counts.
 */

const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));
vi.mock('next/headers', async () => {
  const f = await import('@/test/step-up-session-fixture');
  return {
    headers: async () => f.fixtureHeaders(),
    cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  };
});
vi.mock('@/lib/supabase/server', async () => {
  const f = await import('@/test/step-up-session-fixture');
  return { createClient: async () => f.fixtureClient() };
});

import { withContext } from '@/server/services/context';
import {
  countCalls as count,
  ORG,
  ORG_2,
  OTHER,
  redirectOf,
  resetWorld,
  USER,
  VERIFIED_FACTOR as VERIFIED,
  world,
  type MemberRole as Role,
  type Policy,
} from '@/test/step-up-session-fixture';

import { getServerSession, requireOrgContext, requireSession } from './session';

beforeEach(() => {
  redirect.mockClear();
  resetWorld();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('requireOrgContext: a session that owes its authenticator code is sent to enter it', () => {
  it('a member with a verified factor at aal1 is redirected to /signin/mfa, carrying the page to come back to', async () => {
    world.factors = VERIFIED;
    expect(await redirectOf(() => requireOrgContext())).toBe(
      '/signin/mfa?redirect=%2Fdashboard%2Finventory%3Fview%3Dlow',
    );
  });

  it('the same member at aal2 gets the context', async () => {
    world.factors = VERIFIED;
    world.aal = 'aal2';
    const ctx = await requireOrgContext();
    expect(ctx.userId).toBe(USER);
    expect(ctx.organizationId).toBe(ORG);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('a member with no factor at aal1 gets the context', async () => {
    const ctx = await requireOrgContext();
    expect(ctx.organizationId).toBe(ORG);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('a factor that was never verified owes no code', async () => {
    world.factors = [{ status: 'unverified' }];
    expect((await requireOrgContext()).organizationId).toBe(ORG);
  });

  it('a verified factor of any kind beside an unverified one owes the code', async () => {
    world.factors = [{ status: 'unverified' }, { status: 'verified' }];
    expect(await redirectOf(() => requireOrgContext())).toMatch(/^\/signin\/mfa\?/);
  });

  it('a token with no level, or one that cannot be verified, counts as not aal2', async () => {
    world.factors = VERIFIED;
    world.aal = null;
    expect(await redirectOf(() => requireOrgContext())).toMatch(/^\/signin\/mfa\?/);
    world.aal = 'aal2';
    world.claimsRead = 'error';
    expect(await redirectOf(() => requireOrgContext())).toMatch(/^\/signin\/mfa\?/);
    world.claimsRead = 'throw';
    expect(await redirectOf(() => requireOrgContext())).toMatch(/^\/signin\/mfa\?/);
  });

  it('a member with no factor still gets the context when the token cannot be verified', async () => {
    world.claimsRead = 'error';
    expect((await requireOrgContext()).organizationId).toBe(ORG);
  });

  it('the code comes before the organization: no membership, or an organization the member is not in, still goes to /signin/mfa', async () => {
    world.factors = VERIFIED;
    world.orgs = [];
    expect(await redirectOf(() => requireOrgContext())).toMatch(/^\/signin\/mfa\?/);
    world.orgs = [ORG];
    expect(await redirectOf(() => requireOrgContext(ORG_2))).toMatch(/^\/signin\/mfa\?/);
  });

  it('an explicit organization is held to the same rule, and resolves at aal2', async () => {
    world.factors = VERIFIED;
    world.orgs = [ORG, ORG_2];
    expect(await redirectOf(() => requireOrgContext(ORG_2))).toMatch(/^\/signin\/mfa\?/);
    world.aal = 'aal2';
    expect((await requireOrgContext(ORG_2)).organizationId).toBe(ORG_2);
  });
});

describe('where the redirect goes', () => {
  beforeEach(() => {
    world.factors = VERIFIED;
  });

  it('with no page to come back to: /signin/mfa alone', async () => {
    world.returnPath = null;
    expect(await redirectOf(() => requireOrgContext())).toBe('/signin/mfa');
  });

  it('never back to a sign-in page (no code page nested in itself)', async () => {
    for (const back of [
      '/signin/mfa',
      '/signin/mfa?redirect=%2Fdashboard',
      '/signin',
      '/reset/complete',
    ]) {
      world.returnPath = back;
      expect(await redirectOf(() => requireOrgContext()), back).toBe('/signin/mfa');
    }
  });

  it('never off this origin: a return path that is not a same-origin path is dropped', async () => {
    for (const back of [
      'https://elsewhere.example/x',
      '//elsewhere.example/x',
      '/\\elsewhere.example',
    ]) {
      world.returnPath = back;
      expect(await redirectOf(() => requireOrgContext()), back).toBe('/signin/mfa');
    }
  });

  it('no session at all still goes to sign-in, not to the code page', async () => {
    world.headerUser = null;
    expect(await redirectOf(() => requireOrgContext())).toBe(
      '/signin?redirect=%2Fdashboard%2Finventory%3Fview%3Dlow',
    );
  });

  it('a disabled account goes to its own page first', async () => {
    world.disabled = true;
    expect(await redirectOf(() => requireOrgContext())).toBe('/account-disabled');
  });
});

describe('the gate fails closed', () => {
  it('an unreadable factor list is an error for a session not at aal2: no context, and no redirect', async () => {
    world.factorRead = 'error';
    await expect(requireOrgContext()).rejects.toThrow(/getMfaFactorsForRequest/);
    world.factorRead = 'throw';
    await expect(requireOrgContext()).rejects.toThrow('fetch failed');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('at aal2 the list is not needed, so an unreadable one changes nothing', async () => {
    world.aal = 'aal2';
    world.factorRead = 'error';
    expect((await requireOrgContext()).organizationId).toBe(ORG);
  });

  it('a session that no longer exists goes to sign-in through the session-ended route', async () => {
    world.factorRead = 'session-missing';
    expect(await redirectOf(() => requireOrgContext())).toBe('/auth/session-ended');
  });

  it("another account's aal2 claims count for nothing: the member's own factor still owes the code", async () => {
    world.factors = VERIFIED;
    world.aal = 'aal2';
    world.claimsSub = OTHER;
    expect(await redirectOf(() => requireOrgContext())).toMatch(/^\/signin\/mfa\?/);
  });

  it("another account's factor list is no answer: the code is owed, even when that list is empty", async () => {
    world.factorsOf = OTHER;
    world.factors = [];
    expect(await redirectOf(() => requireOrgContext())).toMatch(/^\/signin\/mfa\?/);
  });

  it("another account's claims beside the member's own empty list: nothing is owed", async () => {
    world.claimsSub = OTHER;
    world.aal = 'aal2';
    expect((await requireOrgContext()).userId).toBe(USER);
  });
});

describe('what the gate costs', () => {
  it('at aal2: a local check, and no call to the Auth server', async () => {
    world.factors = VERIFIED;
    world.aal = 'aal2';
    await requireOrgContext();
    expect(count('auth:getUser')).toBe(0);
    expect(count('rpc:get_request_context')).toBe(1);
    expect(world.calls.filter((c) => c.startsWith('from:'))).toEqual([]);
  });

  it('not at aal2: exactly one factor read, whether the code is owed or not', async () => {
    await requireOrgContext();
    expect(count('auth:getUser')).toBe(1);
    world.calls = [];
    world.factors = VERIFIED;
    await redirectOf(() => requireOrgContext());
    expect(count('auth:getUser')).toBe(1);
    expect(count('rpc:get_request_context')).toBe(1);
  });

  it('withContext() in a Server Action shares its own factor read with the gate: one read, not two', async () => {
    const ctx = await withContext();
    expect(ctx.mfaRequired).toBe(false);
    expect(count('auth:getUser')).toBe(1);
    expect(count('rpc:get_request_context')).toBe(1);
    world.calls = [];
    world.factors = VERIFIED;
    world.aal = 'aal2';
    const atAal2 = await withContext();
    expect(atAal2.mfaSatisfied).toBe(true);
    expect(count('auth:getUser')).toBe(1);
  });

  it('no identity header (signed out, or a request the proxy never saw): the gate reads nothing, whatever cookie came with it', async () => {
    world.headerUser = null;
    world.factors = VERIFIED;
    expect(await redirectOf(() => requireOrgContext())).toMatch(/^\/signin\?/);
    expect(world.calls.filter((c) => c.startsWith('auth:'))).toEqual([]);
  });

  it('a header the session does not confirm: sign-in, and the list read for the cookie session decides nothing', async () => {
    // The header names one account; the session's own answer
    // (get_request_context) is for another, so there is no session.
    world.headerUser = OTHER;
    world.factors = VERIFIED;
    world.aal = 'aal2';
    expect(await redirectOf(() => requireOrgContext())).toMatch(/^\/signin\?/);
  });
});

describe('withContext(): no service context for a session that owes its code', () => {
  it('a member with a verified factor at aal1 is redirected: there is no context labelled "not satisfied" to work with', async () => {
    world.factors = VERIFIED;
    expect(await redirectOf(() => withContext())).toBe(
      '/signin/mfa?redirect=%2Fdashboard%2Finventory%3Fview%3Dlow',
    );
  });

  it('the same member at aal2 gets a satisfied context', async () => {
    world.factors = VERIFIED;
    world.aal = 'aal2';
    const ctx = await withContext();
    expect(ctx).toMatchObject({
      userId: USER,
      mfaRequired: true,
      mfaSatisfied: true,
      mfaEnrolled: true,
    });
  });

  it('an unreadable factor list is an error, not a context', async () => {
    world.factorRead = 'error';
    await expect(withContext()).rejects.toThrow(/getMfaFactorsForRequest/);
  });
});

describe('organizations whose policy does not require a code', () => {
  it.each<[Policy, Role]>([
    ['optional', 'owner'],
    ['optional', 'staff'],
    ['admins_required', 'staff'],
  ])('%s, a %s with no factor: the context, and nothing required', async (policy, role) => {
    world.policy = policy;
    world.role = role;
    expect((await requireOrgContext()).role).toBe(role);
    const ctx = await withContext();
    expect(ctx.mfaRequired).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });

  it.each<[Policy, Role]>([
    ['optional', 'owner'],
    ['optional', 'viewer'],
    ['admins_required', 'staff'],
  ])(
    '%s, a %s WITH a verified factor at aal1: the code is owed whatever the policy says',
    async (policy, role) => {
      world.policy = policy;
      world.role = role;
      world.factors = VERIFIED;
      expect(await redirectOf(() => requireOrgContext())).toMatch(/^\/signin\/mfa\?/);
      expect(await redirectOf(() => withContext())).toMatch(/^\/signin\/mfa\?/);
    },
  );
});

describe('organizations whose policy requires a factor from a member who has none', () => {
  // Not this gate's question: the member has no code to enter. The dashboard
  // layout sends them to set one up (all_required) or shows its banner, and
  // assertPermission refuses their actions, as before.
  it.each<[Policy, Role]>([
    ['all_required', 'staff'],
    ['admins_required', 'admin'],
  ])(
    '%s, a %s with no factor: still a context, labelled required and not satisfied',
    async (policy, role) => {
      world.policy = policy;
      world.role = role;
      expect((await requireOrgContext()).organizationId).toBe(ORG);
      const ctx = await withContext();
      expect(ctx).toMatchObject({ mfaRequired: true, mfaSatisfied: false, mfaEnrolled: false });
      expect(redirect).not.toHaveBeenCalled();
    },
  );
});

describe('a platform admin acting as an organization', () => {
  // "Act as" gives the admin's own account a temporary owner membership in the
  // target organization and makes it the active one
  // (server/services/platform/impersonation.ts). The seat is the admin's own
  // session, so the rule is asked of the admin's own account.
  beforeEach(() => {
    world.role = 'owner';
    world.orgs = [ORG_2, ORG];
    world.factors = VERIFIED;
  });

  it('at aal2 the seat resolves as owner of the target organization, whatever that organization requires', async () => {
    world.aal = 'aal2';
    world.policy = 'all_required';
    const ctx = await requireOrgContext();
    expect(ctx).toMatchObject({ userId: USER, organizationId: ORG_2, role: 'owner' });
    expect((await withContext()).mfaSatisfied).toBe(true);
  });

  it('on a session that has not entered the code, the seat is not handed out', async () => {
    expect(await redirectOf(() => requireOrgContext())).toMatch(/^\/signin\/mfa\?/);
    expect(await redirectOf(() => withContext())).toMatch(/^\/signin\/mfa\?/);
  });
});

describe('requireSession() does not ask for the code', () => {
  // The code page, the recovery code, enrolling a first authenticator and
  // signing out all run on a session that has not entered one.
  it('a member with a verified factor at aal1 still has a session, and no gate read is made', async () => {
    world.factors = VERIFIED;
    const session = await requireSession();
    expect(session.userId).toBe(USER);
    expect((await getServerSession())?.userId).toBe(USER);
    expect(redirect).not.toHaveBeenCalled();
    expect(count('auth:getUser')).toBe(0);
    expect(count('auth:getSession')).toBe(0);
  });
});
