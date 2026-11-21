import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: the code page never offers a passkey's bridge factor as
 * an authenticator, and never sends an account whose only second step is a
 * passkey on to the dashboard at aal1 (plan 3.1 #1, #2).
 *
 * The bridge is a verified TOTP factor, so an account that has one owes the
 * second step like any enrolled account: the page keeps it (the "no factor"
 * redirect is for an account with no verified factor at all). The form lists
 * the verified authenticators without the account's RECORDED bridge
 * (lib/auth/passkey-bridge.ts); an account left with none gets the recovery
 * code only. A reserved-name factor that is not the recorded bridge, and every
 * factor while the records do not exist yet, is listed like any app.
 */

const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 1000 })),
}));

const h = vi.hoisted(() => ({
  factors: [] as Array<{ id: string; status: string; friendly_name?: string | null }>,
  aal: 'aal1',
  record: { data: null as unknown, error: null as unknown },
  /** The filters of every passkey_bridges read: whose record was asked for. */
  recordFilters: [] as Array<[string, unknown]>,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
      mfa: {
        listFactors: async () => ({ data: { all: h.factors, totp: h.factors }, error: null }),
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: h.aal, nextLevel: 'aal2' },
          error: null,
        }),
      },
    },
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (column: string, value: unknown) => {
        h.recordFilters.push([column, value]);
        return q;
      };
      q.maybeSingle = async () => h.record;
      return q;
    },
  }),
}));
vi.mock('@/components/auth/mfa-challenge-form', () => ({ MfaChallengeForm: () => null }));

import { MfaChallengeForm } from '@/components/auth/mfa-challenge-form';

import MfaChallengePage from './page';

const APP = { id: 'app-1', status: 'verified', friendly_name: 'Phone' };
const BRIDGE = { id: 'bridge-1', status: 'verified', friendly_name: 'sp-passkey-bridge-a1b2c3' };
const IMPOSTOR = { id: 'other-1', status: 'verified', friendly_name: 'sp-passkey-bridge-zzz' };

/** The card's words and the factors handed to the form, or the redirect. */
async function shown(): Promise<
  | { to: string }
  | { description: string; factors: Array<{ id: string; friendlyName: string | null }> }
> {
  let page: ReactElement<{ description: string; children: ReactNode }>;
  try {
    page = (await MfaChallengePage()) as typeof page;
  } catch (e) {
    const m = /^REDIRECT:(.*)$/.exec((e as Error).message);
    if (m) return { to: m[1]! };
    throw e;
  }
  const forms: Array<{ factors: Array<{ id: string; friendlyName: string | null }> }> = [];
  const walk = (node: ReactNode): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const el = node as ReactElement<{ children?: ReactNode; factors?: never }>;
    if (el.type === MfaChallengeForm) forms.push(el.props as never);
    walk(el.props?.children);
  };
  walk(page.props.children);
  expect(forms).toHaveLength(1);
  return { description: page.props.description, factors: forms[0]!.factors };
}

beforeEach(() => {
  redirect.mockClear();
  h.factors = [APP];
  h.aal = 'aal1';
  h.record = { data: { factor_id: BRIDGE.id }, error: null };
  h.recordFilters = [];
});

describe('the code page and the passkey bridge', () => {
  it('an account whose only factor is the bridge is not sent to the dashboard: it gets the recovery code only', async () => {
    h.factors = [BRIDGE];
    expect(await shown()).toEqual({
      description:
        "Your second step can't be used here right now. Use a recovery code to get back in, or try again later.",
      factors: [],
    });
    expect(redirect).not.toHaveBeenCalled();
    // The record of the account the page validated, and no other.
    expect(h.recordFilters).toEqual([['user_id', 'user-1']]);
  });

  it('an account with an app and the bridge is offered the app only, whatever the order', async () => {
    for (const order of [
      [BRIDGE, APP],
      [APP, BRIDGE],
    ]) {
      h.factors = order;
      expect(await shown()).toEqual({
        description: "One more step. Confirm it's you with a code from your authenticator app.",
        factors: [{ id: APP.id, friendlyName: 'Phone' }],
      });
    }
  });

  it('a reserved-name factor that is not the recorded bridge is listed like any app', async () => {
    h.factors = [IMPOSTOR, BRIDGE];
    const page = await shown();
    expect(page).toMatchObject({
      factors: [{ id: IMPOSTOR.id, friendlyName: IMPOSTOR.friendly_name }],
    });
  });

  it('before the records exist, every verified factor is listed, as today', async () => {
    h.factors = [BRIDGE, APP];
    h.record = {
      data: null,
      error: {
        code: 'PGRST205',
        message: "Could not find the table 'public.passkey_bridges' in the schema cache",
      },
    };
    expect(await shown()).toEqual({
      description: "One more step. Confirm it's you with a code from your authenticator app.",
      factors: [
        { id: BRIDGE.id, friendlyName: BRIDGE.friendly_name },
        { id: APP.id, friendlyName: 'Phone' },
      ],
    });
  });

  it('a record that cannot be read hides nothing', async () => {
    h.factors = [BRIDGE];
    h.record = { data: null, error: { code: '57014', message: 'canceling statement' } };
    expect(await shown()).toMatchObject({ factors: [{ id: BRIDGE.id }] });
  });

  it('still sends an account with no verified factor, or a session at aal2, to the dashboard', async () => {
    h.factors = [];
    expect(await shown()).toEqual({ to: '/dashboard' });
    h.factors = [BRIDGE];
    h.aal = 'aal2';
    expect(await shown()).toEqual({ to: '/dashboard' });
  });
});
