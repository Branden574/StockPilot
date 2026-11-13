import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S43c): the authenticator code page and the gate
 * that sends people to it never send a session back and forth.
 *
 * requireOrgContext() (lib/auth/session.ts) redirects a member who owes the
 * code to /signin/mfa. This page is where that lands, so it must show the code
 * form to exactly that session: it reads the session itself (getUser, the
 * factor list), never asks for an organization context, and sends on to the
 * dashboard only a session the gate lets through.
 *
 * Both run for real against the same faked network
 * (src/test/step-up-session-fixture.ts).
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
vi.mock('@/components/auth/mfa-challenge-form', () => ({ MfaChallengeForm: () => null }));

import { requireOrgContext } from '@/lib/auth/session';
import { redirectOf, resetWorld, VERIFIED_FACTOR, world } from '@/test/step-up-session-fixture';

import MfaChallengePage from './page';

beforeEach(() => {
  redirect.mockClear();
  resetWorld();
  // The request is for the code page itself.
  world.returnPath = '/signin/mfa?redirect=%2Fdashboard%2Finventory';
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

/** What the page does: the redirect it ends in, or the card it shows. */
async function pageOutcome(): Promise<{ to: string } | { card: string }> {
  let shown: ReactElement<{ description: string }> | undefined;
  const to = await redirectOf(async () => {
    shown = (await MfaChallengePage()) as ReactElement<{ description: string }>;
  });
  return to !== null ? { to } : { card: shown!.props.description };
}

describe('the code page, for a session the gate sends to it', () => {
  it('a member with a verified factor at aal1 is shown the code form, with no redirect', async () => {
    world.factors = VERIFIED_FACTOR;
    expect(await pageOutcome()).toEqual({
      card: "One more step. Confirm it's you with a code from your authenticator app.",
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('it builds no organization context: the session context is never loaded', async () => {
    world.factors = VERIFIED_FACTOR;
    await pageOutcome();
    expect(world.calls.filter((c) => c.startsWith('rpc:') || c.startsWith('from:'))).toEqual([]);
  });

  it('when the Auth server cannot be read, the page never sends the session on to the dashboard', async () => {
    world.factors = VERIFIED_FACTOR;
    world.factorRead = 'error';
    // The page's own getUser() fails with the same answer, which it treats as
    // signed out.
    expect(await pageOutcome()).toEqual({ to: '/signin' });
  });
});

describe('the page and the gate agree, so neither sends a session back to the other', () => {
  const states: Array<[string, () => void]> = [
    ['a verified factor at aal1', () => void (world.factors = VERIFIED_FACTOR)],
    [
      'a verified factor at aal2',
      () => void ((world.factors = VERIFIED_FACTOR), (world.aal = 'aal2')),
    ],
    ['no factor at aal1', () => undefined],
    ['only an unverified factor', () => void (world.factors = [{ status: 'unverified' }])],
  ];

  it.each(states)('%s', async (_name, arrange) => {
    arrange();
    const page = await pageOutcome();
    // The gate, asked for a dashboard page.
    world.returnPath = '/dashboard/inventory';
    const gate = await redirectOf(() => requireOrgContext());
    const gateSendsToCodePage = gate?.startsWith('/signin/mfa') ?? false;
    const pageSendsToDashboard = 'to' in page && page.to === '/dashboard';
    // Exactly one of the two: the page keeps the session the gate sends it,
    // and passes on the session the gate lets through.
    expect({ gateSendsToCodePage, pageSendsToDashboard }).toEqual(
      gateSendsToCodePage
        ? { gateSendsToCodePage: true, pageSendsToDashboard: false }
        : { gateSendsToCodePage: false, pageSendsToDashboard: true },
    );
  });

  it('the gate never names the code page as the page to come back to', async () => {
    world.factors = VERIFIED_FACTOR;
    expect(await redirectOf(() => requireOrgContext())).toBe('/signin/mfa');
  });
});
