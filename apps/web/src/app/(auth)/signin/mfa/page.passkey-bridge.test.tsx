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
 * code only. Once the records are read (a bridge recorded, or none for this
 * account), a reserved-name factor that no record names is no app either: it
 * is never offered for a typed code (the lab walk of stage 4, state S12; its
 * code is one no member has), so an account left with no app gets the words
 * of a second step that cannot be used here and the recovery code. While the
 * records cannot be read (a failed read, or the table missing) a factor that
 * carries the reserved name is still never offered for a typed code (fail
 * closed): an account with an app is offered the app, and an account left
 * with none gets a "could not load, reload to try again" card that still
 * holds the form with no code box: the recovery code and the sign-out (the
 * second lab walk, FAIL 1: without them a passkey-only member was held on the
 * card for as long as the fault lasted). An account with no reserved-name
 * factor makes no record read, so a failed read changes nothing for it.
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
  /** The service client cannot be made (a server without its key). */
  adminThrows: false,
  adminClients: 0,
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
  createAdminClient: () => {
    h.adminClients += 1;
    if (h.adminThrows) throw new Error('the service client could not be made');
    return {
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
    };
  },
}));
vi.mock('@/components/auth/mfa-challenge-form', () => ({ MfaChallengeForm: () => null }));
// Stage 4: the passkey step answers as for an account whose passkeys are not
// open, the stage 2 page these tests pin (page.passkeys.test.tsx covers 'ready').
vi.mock('@/server/security/passkeys', () => ({ passkeyStepFor: vi.fn(async () => 'none') }));
vi.mock('@/components/auth/passkey-step', () => ({ PasskeyStep: () => null }));

import { MfaChallengeForm } from '@/components/auth/mfa-challenge-form';

import MfaChallengePage from './page';

const APP = { id: 'app-1', status: 'verified', friendly_name: 'Phone' };
const BRIDGE = { id: 'bridge-1', status: 'verified', friendly_name: 'sp-passkey-bridge-a1b2c3' };
const IMPOSTOR = { id: 'other-1', status: 'verified', friendly_name: 'sp-passkey-bridge-zzz' };

/** The card's words and the factors handed to the form, or the redirect. */
async function shown(
  /** How many forms the card must hold: one, or none for a card of words only. */
  forms_expected = 1,
): Promise<
  | { to: string }
  | { description: string; factors: Array<{ id: string; friendlyName: string | null }> | null }
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
  expect(forms).toHaveLength(forms_expected);
  return { description: page.props.description, factors: forms[0]?.factors ?? null };
}

beforeEach(() => {
  redirect.mockClear();
  h.factors = [APP];
  h.aal = 'aal1';
  h.record = { data: { factor_id: BRIDGE.id }, error: null };
  h.recordFilters = [];
  h.adminThrows = false;
  h.adminClients = 0;
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

  it.each([
    ['beside the recorded bridge (S15)', { data: { factor_id: BRIDGE.id }, error: null }],
    ['with no bridge row for the account (S12)', { data: null, error: null }],
  ])(
    'a reserved-name factor that no record names, %s, is never offered for a code: no app left, the can\u2019t-be-used words',
    async (_state, record) => {
      h.factors = [IMPOSTOR, BRIDGE];
      h.record = record;
      expect(await shown()).toEqual({
        description:
          "Your second step can't be used here right now. Use a recovery code to get back in, or try again later.",
        factors: [],
      });
    },
  );

  it('S12 with an authenticator app too: the app only, whatever the order', async () => {
    h.record = { data: null, error: null };
    for (const order of [
      [IMPOSTOR, APP],
      [APP, IMPOSTOR],
    ]) {
      h.factors = order;
      expect(await shown()).toEqual({
        description: "One more step. Confirm it's you with a code from your authenticator app.",
        factors: [{ id: APP.id, friendlyName: 'Phone' }],
      });
    }
  });

  const NOT_YET = {
    data: null,
    error: {
      code: 'PGRST205',
      message: "Could not find the table 'public.passkey_bridges' in the schema cache",
    },
  };
  const FAILED = { data: null, error: { code: '57014', message: 'canceling statement' } };
  /** The card's words while the record cannot be read: reload, or the recovery code below them. */
  const TRY_AGAIN =
    'We could not load your second step just now. Reload this page to try again, or use a recovery code.';

  describe('while the record cannot be read (fail closed)', () => {
    it.each([
      ['a failed read', FAILED, false],
      ['the table missing', NOT_YET, false],
      ['a service client that cannot be made', FAILED, true],
    ])(
      '%s, an app beside a reserved-name factor: the app only, whatever the order',
      async (_state, record, adminThrows) => {
        h.record = record;
        h.adminThrows = adminThrows;
        for (const order of [
          [BRIDGE, APP],
          [APP, IMPOSTOR, BRIDGE],
        ]) {
          h.factors = order;
          expect(await shown()).toEqual({
            description: "One more step. Confirm it's you with a code from your authenticator app.",
            factors: [{ id: APP.id, friendlyName: 'Phone' }],
          });
        }
      },
    );

    it.each([
      ['a failed read', FAILED, false],
      ['the table missing', NOT_YET, false],
      ['a service client that cannot be made', FAILED, true],
    ])(
      '%s, no app: the try-again card with the recovery code and the sign-out, no code box, and no trip to the dashboard',
      async (_state, record, adminThrows) => {
        h.record = record;
        h.adminThrows = adminThrows;
        for (const factors of [[BRIDGE], [IMPOSTOR, BRIDGE]]) {
          h.factors = factors;
          // The form with no factor: no code box, so no code is sent; its
          // "Use a recovery code" and "Cancel and sign out" stay
          // (mfa-challenge-form.recovery-only.test.tsx).
          expect(await shown(1)).toEqual({ description: TRY_AGAIN, factors: [] });
        }
        expect(redirect).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['a failed read', FAILED, false],
      ['the table missing', NOT_YET, false],
      ['a service client that cannot be made', FAILED, true],
    ])(
      '%s: an account with no reserved-name factor gets the page exactly as before, with no record read',
      async (_state, record, adminThrows) => {
        h.record = record;
        h.adminThrows = adminThrows;
        const second = { id: 'app-2', status: 'verified', friendly_name: null };
        h.factors = [APP, second];
        expect(await shown()).toEqual({
          description: "One more step. Confirm it's you with a code from your authenticator app.",
          factors: [
            { id: APP.id, friendlyName: 'Phone' },
            { id: 'app-2', friendlyName: null },
          ],
        });
        expect(h.adminClients).toBe(0);
        expect(h.recordFilters).toEqual([]);
      },
    );
  });

  it('still sends an account with no verified factor, or a session at aal2, to the dashboard', async () => {
    h.factors = [];
    expect(await shown()).toEqual({ to: '/dashboard' });
    h.factors = [BRIDGE];
    h.aal = 'aal2';
    expect(await shown()).toEqual({ to: '/dashboard' });
  });
});
