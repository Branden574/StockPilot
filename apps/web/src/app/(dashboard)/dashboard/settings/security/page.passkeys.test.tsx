import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Stage 4: the Security page's Passkeys panel. It is there only when
 * server/security/passkeys.ts passkeysPanelFor answers (both switches, the
 * key, every organization of the member, a site, a readable account); when
 * it answers null, or fails, the page has no trace of it: no title, no words,
 * the same markup as a page with no panel at all. Each of the four
 * conditions is pinned in passkeys.test.ts ("the gate"); this pins the page.
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
vi.mock('@/components/settings/passkeys-panel', async () => {
  const React = await import('react');
  return {
    PasskeysPanel: ({ data }: { data: { passkeys: unknown[] } }) =>
      React.createElement('div', { 'data-testid': 'passkeys-panel' }, String(data.passkeys.length)),
  };
});
vi.mock('@/lib/auth/context-factor-list', () => ({
  contextFactorsOf: async (ctx: unknown, userId: string) => {
    h.contextAsked.push([ctx, userId]);
    return h.contextFactors;
  },
}));
vi.mock('@/server/security/passkeys', () => ({
  passkeysPanelFor: async (userId: string, factors: unknown) => {
    h.panelReads.push(userId);
    h.panelFactors.push(factors);
    if (h.panelThrows) throw new Error('read failed');
    return h.panel;
  },
}));

const h = vi.hoisted(() => ({
  factors: [] as Array<{ id: string; status: string; friendly_name?: string | null }>,
  aal: 'aal2' as 'aal1' | 'aal2',
  record: { data: null as unknown, error: null as unknown },
  bridgeReads: [] as Array<[string, unknown]>,
  panel: null as unknown,
  panelThrows: false,
  panelReads: [] as string[],
  /** Review 4 finding 6: the factor list the context read, handed to the panel. */
  contextFactors: null as unknown,
  contextAsked: [] as Array<[unknown, string]>,
  panelFactors: [] as unknown[],
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
const PANEL = {
  passkeys: [{ id: 'p-1' }],
  atLimit: false,
  hasApp: true,
  proof: 'code',
  apps: [{ id: 'app-1', friendlyName: 'Phone' }],
  phoneConfirmation: false,
  aal2: true,
};

async function renderPage() {
  return render(await SecuritySettingsPage({ searchParams: Promise.resolve({}) }));
}

beforeEach(() => {
  h.factors = [APP];
  h.aal = 'aal2';
  h.record = { data: null, error: null };
  h.bridgeReads = [];
  h.panel = null;
  h.panelThrows = false;
  h.panelReads = [];
  h.contextFactors = [APP];
  h.contextAsked = [];
  h.panelFactors = [];
});

describe('Security page: the Passkeys panel', () => {
  it('present when the server answers: titled Passkeys, read for the member of this page', async () => {
    h.panel = PANEL;
    const { container } = await renderPage();
    expect(screen.getByTestId('passkeys-panel').textContent).toBe('1');
    expect(screen.getByText('Passkeys')).toBeTruthy();
    expect(container.textContent).toContain(
      "Confirm it's you with your face, fingerprint or device PIN",
    );
    expect(h.panelReads).toEqual(['user-1']);
  });

  it('it sits after the authenticator app panel and before Active sessions', async () => {
    h.panel = PANEL;
    const { container } = await renderPage();
    const text = container.textContent ?? '';
    const at = (s: string) => text.indexOf(s);
    expect(at('Passkeys')).toBeGreaterThan(at('app-1'));
    expect(at('Active sessions')).toBeGreaterThan(at('Passkeys'));
  });

  it('absent when the server answers null: no title, no words, the markup of a page without it', async () => {
    const { container } = await renderPage();
    expect(screen.queryByTestId('passkeys-panel')).toBeNull();
    expect(container.textContent).not.toMatch(/passkey/i);
    // React numbers its ids per render; the rest must match byte for byte.
    const markup = (html: string) => html.replace(/_r_[a-z0-9]+_/g, '_id_');
    const without = markup(container.innerHTML);

    // A read that fails gives the very same page.
    document.body.innerHTML = '';
    h.panelThrows = true;
    const failed = await renderPage();
    expect(markup(failed.container.innerHTML)).toBe(without);
  });
});

describe('review 4 finding 6: the panel is read with the factor list the context already read', () => {
  it('names first: the context factor list goes to the panel (no second factor read for it)', async () => {
    h.panel = PANEL;
    await renderPage();
    expect(h.contextAsked).toHaveLength(1);
    expect(h.contextAsked[0]![1]).toBe('user-1');
    expect(h.panelFactors).toEqual([[APP]]);
  });
});
