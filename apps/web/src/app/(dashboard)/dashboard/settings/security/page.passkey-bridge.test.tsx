import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: the Security page never lists a passkey's bridge factor
 * as an authenticator app, so its Remove button is never offered for it
 * (plan 3.2 c, d).
 *
 * The authenticator card lists the verified factors without the account's
 * RECORDED bridge (lib/auth/passkey-bridge.ts). The bridge still counts as a
 * second step everywhere else on the page: the password change waits for
 * aal2, and the recovery codes stay offered to an account whose only second
 * step is a passkey. A reserved-name factor that is not the recorded bridge,
 * and every factor while the records do not exist yet, is listed like any app.
 */

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/components/settings/mfa-enrollment', async () => {
  const React = await import('react');
  return {
    MfaEnrollment: ({ verifiedFactors }: { verifiedFactors: Array<{ id: string }> }) =>
      React.createElement(
        'div',
        { 'data-testid': 'mfa-enrollment' },
        verifiedFactors.map((f) => f.id).join(',') || 'none',
      ),
  };
});
vi.mock('@/components/settings/active-sessions', () => ({ ActiveSessions: () => null }));
vi.mock('@/components/settings/change-password-form', async () => {
  const React = await import('react');
  return {
    ChangePasswordForm: () => React.createElement('div', { 'data-testid': 'password-form' }),
  };
});
vi.mock('@/components/settings/mfa-policy-editor', () => ({ MfaPolicyEditor: () => null }));
vi.mock('@/components/settings/mfa-recovery-codes', async () => {
  const React = await import('react');
  return {
    MfaRecoveryCodes: () => React.createElement('div', { 'data-testid': 'recovery-codes' }),
  };
});
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'user-1',
    role: 'staff',
  })),
}));
vi.mock('@/server/services/context', () => ({ withContext: vi.fn(async () => ({})) }));
vi.mock('@/server/services/sessions', () => ({
  SessionsService: class {
    async list() {
      return [];
    }
  },
}));
vi.mock('@/server/actions/mfa-recovery', () => ({
  getMfaRecoveryCodeStatus: vi.fn(async () => ({ total: 10, unused: 10 })),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

const h = vi.hoisted(() => ({
  factors: [] as Array<{ id: string; status: string; friendly_name?: string | null }>,
  aal: 'aal2' as 'aal1' | 'aal2',
  record: { data: null as unknown, error: null as unknown },
  bridgeReads: [] as Array<[string, unknown]>,
}));

vi.mock('@/lib/auth/verified-claims', () => ({
  getVerifiedSessionClaimsForRequest: vi.fn(async () => ({
    userId: 'user-1',
    sessionId: 'sess-1',
    aal: h.aal,
    amr: [],
  })),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      mfa: {
        listFactors: async () => ({ data: { all: h.factors, totp: h.factors }, error: null }),
      },
    },
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => ({ data: { mfa_policy: 'optional' }, error: null });
      return q;
    },
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (column: string, value: unknown) => {
        h.bridgeReads.push([column, value]);
        return q;
      };
      q.maybeSingle = async () => h.record;
      return q;
    },
  }),
}));

import SecuritySettingsPage from './page';

const APP = { id: 'app-1', status: 'verified', friendly_name: 'Phone' };
const BRIDGE = { id: 'bridge-1', status: 'verified', friendly_name: 'sp-passkey-bridge-a1b2c3' };
const IMPOSTOR = { id: 'other-1', status: 'verified', friendly_name: 'sp-passkey-bridge-zzz' };

async function renderPage() {
  render(await SecuritySettingsPage({ searchParams: Promise.resolve({}) }));
}

beforeEach(() => {
  h.factors = [APP];
  h.aal = 'aal2';
  h.record = { data: { factor_id: BRIDGE.id }, error: null };
  h.bridgeReads = [];
});

describe('Security page and the passkey bridge', () => {
  it('lists the authenticator apps without the recorded bridge, read for the member of this page', async () => {
    h.factors = [BRIDGE, APP];
    await renderPage();
    expect(screen.getByTestId('mfa-enrollment').textContent).toBe('app-1');
    expect(h.bridgeReads).toEqual([['user_id', 'user-1']]);
  });

  it('an account whose only second step is a passkey: no app listed, the recovery codes stay, the password change waits for aal2', async () => {
    h.factors = [BRIDGE];
    h.aal = 'aal1';
    await renderPage();
    expect(screen.getByTestId('mfa-enrollment').textContent).toBe('none');
    expect(screen.getByTestId('recovery-codes')).toBeTruthy();
    expect(screen.queryByTestId('password-form')).toBeNull();
    expect(screen.queryByText('Enroll to continue')).toBeNull();
  });

  it('a reserved-name factor that is not the recorded bridge is listed like any app', async () => {
    h.factors = [IMPOSTOR, BRIDGE, APP];
    await renderPage();
    expect(screen.getByTestId('mfa-enrollment').textContent).toBe('other-1,app-1');
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
    await renderPage();
    expect(screen.getByTestId('mfa-enrollment').textContent).toBe('bridge-1,app-1');
  });

  it('with no reserved-name factor, the records are never read', async () => {
    await renderPage();
    expect(screen.getByTestId('mfa-enrollment').textContent).toBe('app-1');
    expect(h.bridgeReads).toEqual([]);
  });
});
