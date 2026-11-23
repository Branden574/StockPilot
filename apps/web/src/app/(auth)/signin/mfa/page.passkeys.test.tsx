import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Stage 4: the second-step page with a passkey that answers (plan section 4,
 * 3.1 #1 and #2). The passkey step is offered above the form; the bridge is
 * never in the form's list; with an app too, the form keeps the app. When the
 * server says 'none' the page is stage 2's (page.passkey-bridge.test.tsx).
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
const passkeyStepFor = vi.fn(async (..._a: unknown[]) => 'ready' as 'ready' | 'none');
vi.mock('@/server/security/passkeys', () => ({ passkeyStepFor: (...a: unknown[]) => passkeyStepFor(...a) }));
vi.mock('@/components/auth/passkey-step', () => ({ PasskeyStep: () => null }));

import { MfaChallengeForm } from '@/components/auth/mfa-challenge-form';
import { PasskeyStep } from '@/components/auth/passkey-step';

import MfaChallengePage from './page';

const APP = { id: 'app-1', status: 'verified', friendly_name: 'Phone' };
const BRIDGE = { id: 'bridge-1', status: 'verified', friendly_name: 'sp-passkey-bridge-a1b2c3' };

async function rendered() {
  const page = (await MfaChallengePage()) as ReactElement<{ description: string; children: ReactNode }>;
  const found: { steps: Array<{ hasApps: boolean }>; forms: Array<{ factors: unknown[] }> } = { steps: [], forms: [] };
  const walk = (node: ReactNode): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (el.type === PasskeyStep) found.steps.push(el.props as never);
    if (el.type === MfaChallengeForm) found.forms.push(el.props as never);
    walk(el.props?.children);
  };
  walk(page.props.children);
  return { description: page.props.description, ...found };
}

beforeEach(() => {
  redirect.mockClear();
  passkeyStepFor.mockClear();
  passkeyStepFor.mockResolvedValue('ready');
  h.aal = 'aal1';
  h.record = { data: { factor_id: BRIDGE.id }, error: null };
  h.recordFilters = [];
});

describe('the second-step page with a passkey', () => {
  it('passkey only: the passkey step, its words, and a form with no app (the recovery code stays)', async () => {
    h.factors = [BRIDGE];
    const page = await rendered();
    expect(page.description).toBe("One more step. Confirm it's you with your passkey.");
    expect(page.steps).toEqual([{ hasApps: false }]);
    expect(page.forms).toEqual([{ factors: [] }]);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('a passkey and an app: the passkey step, then the form with the app only', async () => {
    h.factors = [BRIDGE, APP];
    const page = await rendered();
    expect(page.steps).toEqual([{ hasApps: true }]);
    expect(page.forms).toEqual([{ factors: [{ id: APP.id, friendlyName: 'Phone' }] }]);
  });

  it('the server is asked with this account and its verified factors only', async () => {
    h.factors = [BRIDGE, APP, { id: 'u-1', status: 'unverified', friendly_name: 'x' }];
    await rendered();
    expect(passkeyStepFor).toHaveBeenCalledWith('user-1', [BRIDGE, APP]);
  });

  it("'none': no passkey step at all (stage 2's page)", async () => {
    passkeyStepFor.mockResolvedValue('none');
    h.factors = [BRIDGE];
    const page = await rendered();
    expect(page.steps).toEqual([]);
    expect(page.description).toBe(
      "Your second step can't be used here right now. Use a recovery code to get back in, or try again later.",
    );
  });
});
