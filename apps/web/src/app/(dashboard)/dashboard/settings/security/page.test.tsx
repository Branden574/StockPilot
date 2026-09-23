import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Security page's authenticator card, when the factor list cannot be read.
 *
 * auth-js resolves a GoTrue failure of mfa.listFactors() as { data: null, error }.
 * The page read `data?.all ?? []`, so an enrolled user saw "not enrolled" and,
 * in enroll mode, "Enroll to continue": an instruction to set up an
 * authenticator they already have. Display only (every action re-checks), but
 * it must say what actually happened.
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
    MfaEnrollment: ({ verifiedFactors }: { verifiedFactors: unknown[] }) =>
      React.createElement('div', { 'data-testid': 'mfa-enrollment' }, `enrolled:${verifiedFactors.length}`),
  };
});
vi.mock('@/components/settings/active-sessions', () => ({ ActiveSessions: () => null }));
vi.mock('@/components/settings/change-password-form', () => ({ ChangePasswordForm: () => null }));
vi.mock('@/components/settings/mfa-policy-editor', () => ({ MfaPolicyEditor: () => null }));
vi.mock('@/components/settings/mfa-recovery-codes', async () => {
  const React = await import('react');
  return {
    MfaRecoveryCodes: () => React.createElement('div', { 'data-testid': 'recovery-codes' }),
  };
});

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'u1', role: 'staff' })),
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

let factorsAnswer: { data: unknown; error: unknown };
let aalAnswer: { data: unknown; error: unknown } = {
  data: { currentLevel: 'aal2', nextLevel: 'aal2' },
  error: null,
};
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getSession: async () => ({ data: { session: null } }),
      mfa: {
        listFactors: async () => factorsAnswer,
        getAuthenticatorAssuranceLevel: async () => aalAnswer,
      },
    },
    from: () => {
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) builder[m] = () => builder;
      builder.maybeSingle = async () => ({ data: { mfa_policy: 'optional' }, error: null });
      return builder;
    },
  }),
}));

import SecuritySettingsPage from './page';

async function renderPage(enroll?: string) {
  render(await SecuritySettingsPage({ searchParams: Promise.resolve(enroll ? { enroll } : {}) }));
}

beforeEach(() => {
  factorsAnswer = { data: { all: [] }, error: null };
  aalAnswer = { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null };
});

describe('Security page: the authenticator card', () => {
  it('an unreadable factor list says so, and never shows the not-enrolled state', async () => {
    factorsAnswer = { data: null, error: { message: 'upstream timeout', status: 503 } };
    await renderPage();

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Could not load your authenticator status/);
    expect(screen.getByRole('link', { name: 'Try again' }).getAttribute('href')).toBe(
      '/dashboard/settings/security',
    );
    expect(screen.queryByTestId('mfa-enrollment')).toBeNull();
  });

  it('an unreadable list for an enrolled user at AAL1 offers the step-up, not the password form', async () => {
    factorsAnswer = { data: null, error: { message: 'upstream timeout', status: 503 } };
    // The session's own assurance data: a verified factor exists (nextLevel aal2).
    aalAnswer = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null };
    await renderPage();
    expect(screen.getByText(/Verify it.s you first/)).toBeTruthy();
  });

  it('an unreadable list for a user with no factor still shows the password form', async () => {
    factorsAnswer = { data: null, error: { message: 'upstream timeout', status: 503 } };
    aalAnswer = { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null };
    await renderPage();
    expect(screen.queryByText(/Verify it.s you first/)).toBeNull();
  });

  it('in enroll mode, an unreadable list does not tell the user to enroll', async () => {
    factorsAnswer = { data: null, error: { message: 'upstream timeout', status: 503 } };
    await renderPage('1');

    expect(screen.queryByText('Enroll to continue')).toBeNull();
    expect(screen.getByRole('link', { name: 'Try again' }).getAttribute('href')).toBe(
      '/dashboard/settings/security?enroll=1',
    );
  });

  it('a readable empty list is the not-enrolled state, with no alert', async () => {
    await renderPage('1');

    expect(screen.getByTestId('mfa-enrollment').textContent).toBe('enrolled:0');
    expect(screen.getByText('Enroll to continue')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a readable list with a verified factor shows it, and the recovery codes', async () => {
    factorsAnswer = {
      data: { all: [{ id: 'f1', status: 'verified', friendly_name: 'Phone' }] },
      error: null,
    };
    await renderPage();

    expect(screen.getByTestId('mfa-enrollment').textContent).toBe('enrolled:1');
    expect(screen.getByTestId('recovery-codes')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
