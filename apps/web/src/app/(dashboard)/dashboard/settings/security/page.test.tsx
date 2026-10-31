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
/** The session id the page marks as "this device". */
const listedWith = vi.fn();
vi.mock('@/server/services/sessions', () => ({
  SessionsService: class {
    async list(currentSessionId: string | null) {
      listedWith(currentSessionId);
      return [];
    }
  },
}));
vi.mock('@/server/actions/mfa-recovery', () => ({
  getMfaRecoveryCodeStatus: vi.fn(async () => ({ total: 10, unused: 10 })),
}));

let factorsAnswer: { data: unknown; error: unknown };
/**
 * The VERIFIED claims: what getClaims() returns once the access token's
 * signature checks out. null = the token does not verify (forged or expired),
 * and GoTrue refuses it too.
 */
let verifiedClaims: { sub: string; session_id: string; aal: 'aal1' | 'aal2' } | null;
/**
 * What the cookie CLAIMS, unverified. The page used to read these: the
 * stored session's token (for the session id) and
 * getAuthenticatorAssuranceLevel() (its decode, and the stored user object's
 * factors as nextLevel). Each case sets them to disagree with the verified
 * claims, so a page that reads them again fails here.
 */
let unverifiedAal: { data: unknown; error: unknown };
/** getClaims() answers only once this settles (a cold key-set fetch, held). */
let claimsGate: Promise<void> = Promise.resolve();
const STORED_PAYLOAD = { sub: 'u1', session_id: 'sess-stored', aal: 'aal2' };
const STORED_ACCESS = `h.${Buffer.from(JSON.stringify(STORED_PAYLOAD)).toString('base64url')}.s`;
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getClaims: async () => {
        await claimsGate;
        return verifiedClaims
          ? { data: { claims: verifiedClaims }, error: null }
          : {
              data: null,
              error: { name: 'AuthInvalidJwtError', message: 'Invalid JWT signature' },
            };
      },
      getSession: async () => ({ data: { session: { access_token: STORED_ACCESS } }, error: null }),
      // Only the fallback asks GoTrue about a token; it refuses an unverifiable one.
      getUser: async () => ({
        data: { user: null },
        error: { name: 'AuthApiError', message: 'invalid JWT' },
      }),
      mfa: {
        listFactors: async () => factorsAnswer,
        getAuthenticatorAssuranceLevel: async () => unverifiedAal,
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

import { withContext } from '@/server/services/context';

import SecuritySettingsPage from './page';

async function renderPage(enroll?: string) {
  render(await SecuritySettingsPage({ searchParams: Promise.resolve(enroll ? { enroll } : {}) }));
}

beforeEach(() => {
  claimsGate = Promise.resolve();
  factorsAnswer = { data: { all: [] }, error: null };
  verifiedClaims = { sub: 'u1', session_id: 'sess-verified', aal: 'aal2' };
  unverifiedAal = { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null };
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
    verifiedClaims = { sub: 'u1', session_id: 'sess-verified', aal: 'aal1' };
    await renderPage();
    expect(screen.getByText(/Verify it.s you first/)).toBeTruthy();
  });

  it('an unreadable list at AAL1 offers the step-up even when the stored user object lists no factor', async () => {
    // Enrollment is unknown, and the cookie's stored user object (nextLevel
    // aal1 here) is not evidence: nothing signs it. Only a verified AAL2
    // session is shown the form; the action refuses while the list is
    // unreadable either way.
    factorsAnswer = { data: null, error: { message: 'upstream timeout', status: 503 } };
    verifiedClaims = { sub: 'u1', session_id: 'sess-verified', aal: 'aal1' };
    unverifiedAal = { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null };
    await renderPage();
    expect(screen.getByText(/Verify it.s you first/)).toBeTruthy();
  });

  it('an unreadable list at a verified AAL2 session still shows the password form', async () => {
    factorsAnswer = { data: null, error: { message: 'upstream timeout', status: 503 } };
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

describe('Security page: what it reads from the session', () => {
  const ENROLLED = {
    data: { all: [{ id: 'f1', status: 'verified', friendly_name: 'Phone' }] },
    error: null,
  };

  it('a verified AAL2 session with a verified factor gets the password form', async () => {
    factorsAnswer = ENROLLED;
    await renderPage();
    expect(screen.queryByText(/Verify it.s you first/)).toBeNull();
  });

  it('a token that does not verify is not AAL2, whatever the cookie claims: the step-up, not the form', async () => {
    factorsAnswer = ENROLLED;
    verifiedClaims = null;
    // The cookie's own decode says AAL2; the page used to believe it.
    unverifiedAal = { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null };
    await renderPage();
    expect(screen.getByText(/Verify it.s you first/)).toBeTruthy();
  });

  it("marks this device by the VERIFIED session id, never the stored token's", async () => {
    await renderPage();
    expect(listedWith).toHaveBeenLastCalledWith('sess-verified');
  });

  it('a token that does not verify marks no session as this device', async () => {
    verifiedClaims = null;
    await renderPage();
    expect(listedWith).toHaveBeenLastCalledWith(null);
  });
});

describe('Security page: the claims read does not hold up the service context', () => {
  it('withContext() is already under way while the verified claims are still on their way', async () => {
    // A cold key set: getClaims() waits on the Auth server's key-set fetch.
    // Reading the claims first and only then starting withContext() put that
    // fetch in series ahead of the context's own Supabase round trips.
    let answerClaims!: () => void;
    claimsGate = new Promise((resolve) => {
      answerClaims = resolve;
    });
    vi.mocked(withContext).mockClear();
    const rendering = renderPage();
    await vi.waitFor(() => expect(withContext).toHaveBeenCalledTimes(1));
    answerClaims();
    await rendering;
    expect(listedWith).toHaveBeenLastCalledWith('sess-verified');
  });
});
