import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /onboarding on the shared external frame and the auth card (P5.1), and who
 * may see the create form there (owner decision b.9, docket S20).
 *
 * The form is shown only to the people createOrganizationAction accepts: a
 * platform admin who passes the same checkPlatformAdmin({ requireStepUp: true })
 * the action runs. Every other account with no workspace (a removed member, a
 * portal user, an invitee whose acceptance failed) gets the invite-only card,
 * with Sign out, the ordering portal link and Delete my account. A member
 * still goes straight to the dashboard, and an unreadable membership read is
 * never taken for "no workspace": it gets a card that offers to try again and
 * decides nothing else.
 */

let membership: { organization_id: string } | null = null;
let membershipError: { message: string } | null = null;
let sessionEmail = 'person@example.test';
let gate: { ok: true; session: unknown } | { ok: false; reason: 'forbidden' | 'aal2_required' } = {
  ok: false,
  reason: 'forbidden',
};

const checkPlatformAdmin = vi.fn(async (_opts?: { requireStepUp?: boolean }) => gate);
const reportError = vi.fn(async (_err: unknown, _ctx: unknown) => {});

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: 'user-1', email: sessionEmail }),
}));
vi.mock('@/lib/auth/platform-admin', () => ({
  checkPlatformAdmin: (opts?: { requireStepUp?: boolean }) => checkPlatformAdmin(opts),
}));
vi.mock('@/lib/error-reporter', () => ({
  reportError: (err: unknown, ctx: unknown) => reportError(err, ctx),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          not: () => ({
            limit: () => ({
              maybeSingle: async () => ({ data: membership, error: membershipError }),
            }),
          }),
        }),
      }),
    }),
  }),
}));
class Redirect extends Error {}
const replace = vi.fn();
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
  useRouter: () => ({ replace, refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/server/actions/organization', () => ({ createOrganizationAction: vi.fn() }));
// SignOutForm and DeleteAccountButton are the real client components; only the
// Server Actions behind them are stand-ins.
vi.mock('@/server/actions/auth', () => ({ signOutAction: vi.fn() }));
vi.mock('@/server/actions/profile', () => ({ deleteOwnAccountAction: vi.fn() }));
vi.mock('@/components/theme/theme-toggle', () => ({
  ThemeToggle: () => <button type="button">Theme</button>,
}));

import OnboardingPage, { metadata } from './page';

beforeEach(() => {
  membership = null;
  membershipError = null;
  sessionEmail = 'person@example.test';
  gate = { ok: false, reason: 'forbidden' };
  checkPlatformAdmin.mockClear();
  reportError.mockClear();
});

function expectNoCreateForm() {
  expect(screen.queryByLabelText('Workspace name')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Create workspace' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Create your workspace' })).toBeNull();
}

describe('/onboarding', () => {
  it('sends a member of a workspace to the dashboard', async () => {
    membership = { organization_id: 'org-1' };
    await expect(OnboardingPage()).rejects.toThrow('/dashboard');
    expect(checkPlatformAdmin).not.toHaveBeenCalled();
  });

  it('is titled for what it is now: workspace access', () => {
    expect(metadata.title).toBe('Workspace access');
  });

  it('shows an account with no workspace the invite-only card, never the create form', async () => {
    render(await OnboardingPage());

    expect(checkPlatformAdmin).toHaveBeenCalledWith({ requireStepUp: true });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Invite-only access' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Invite only')).toBeInTheDocument();
    expect(
      screen.getByText(
        "You're signed in as person@example.test, and this account isn't part of a workspace yet.",
      ),
    ).toBeInTheDocument();
    // The email's own button name, not the invite page's.
    expect(screen.getByText(/StockPilot workspaces are invite-only\./)).toHaveTextContent(
      'StockPilot workspaces are invite-only. Ask your administrator to invite this email address, then open the invite email and choose Accept invitation. If you already have an invite, open its link again.',
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).toHaveAttribute('type', 'submit');
    expect(screen.getByText(/Ordering from a supplier\?/)).toHaveTextContent(
      'Ordering from a supplier? Open your ordering portal.',
    );
    expect(screen.getByRole('link', { name: 'Open your ordering portal' })).toHaveAttribute(
      'href',
      '/portal',
    );
    expect(screen.getByText("Don't need this account any more?")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete my account' })).toBeInTheDocument();
    expectNoCreateForm();
    expect(screen.queryByText(/You're a platform admin\./)).toBeNull();
    expect(screen.getByRole('button', { name: 'Theme' })).toBeInTheDocument();
  });

  it('leaves out the first clause when the account has no email on its profile', async () => {
    sessionEmail = '';
    render(await OnboardingPage());
    expect(screen.getByText("This account isn't part of a workspace yet.")).toBeInTheDocument();
    expect(screen.queryByText(/You're signed in as/)).toBeNull();
  });

  it('never takes an unreadable membership read for "no workspace": it reports it and offers to try again', async () => {
    membershipError = { message: 'connection reset' };
    render(await OnboardingPage());

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toEqual({ tag: 'onboarding.membership_read' });
    // Nothing else is decided: the admin check never runs.
    expect(checkPlatformAdmin).not.toHaveBeenCalled();
    expect(screen.getByText('Workspace access')).toBeInTheDocument();
    expect(
      screen.getByText('We could not check your workspaces just now. Try again in a moment.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/dashboard');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expectNoCreateForm();
    expect(screen.queryByText(/isn't part of a workspace/)).toBeNull();
    expect(screen.queryByText(/invite-only/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete my account' })).toBeNull();
  });

  it('draws the create card, every field and its default, for a platform admin who passes the check', async () => {
    gate = { ok: true, session: { userId: 'user-1', email: 'person@example.test' } };
    render(await OnboardingPage());

    expect(checkPlatformAdmin).toHaveBeenCalledWith({ requireStepUp: true });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Create your workspace' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "We'll set you up with a default location so you can start adding inventory right away.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Workspace name')).toHaveAttribute('placeholder', 'Acme Co.');
    const industry = screen.getByLabelText('Industry') as HTMLSelectElement;
    expect(industry.options).toHaveLength(12);
    const size = screen.getByLabelText('Team size') as HTMLSelectElement;
    expect(Array.from(size.options).map((o) => o.textContent)).toEqual([
      'Select…',
      'Just me',
      '2-5',
      '6-25',
      '26-100',
      '100+',
    ]);
    expect((screen.getByLabelText('Timezone') as HTMLInputElement).value).not.toBe('');
    expect(screen.getByLabelText('Currency')).toHaveValue('USD');
    expect(screen.getByRole('button', { name: 'Create workspace' })).toHaveAttribute(
      'type',
      'submit',
    );
    expect(screen.getByRole('button', { name: 'Theme' })).toBeInTheDocument();
    // Provisioning a customer is a different flow, and the line says where.
    expect(screen.getByText(/Setting up a customer\?/)).toHaveTextContent(
      'Setting up a customer? Use Platform > Provision. It creates their account and their workspace, and makes them the owner.',
    );
    expect(screen.getByRole('link', { name: 'Platform > Provision' })).toHaveAttribute(
      'href',
      '/platform/provision',
    );
    expect(screen.queryByRole('heading', { name: 'Invite-only access' })).toBeNull();
  });

  it('shows an allowlisted admin without a fresh step-up the card and how to get the form, never the form', async () => {
    gate = { ok: false, reason: 'aal2_required' };
    const { container } = render(await OnboardingPage());

    expect(
      screen.getByRole('heading', { level: 1, name: 'Invite-only access' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/You're a platform admin\./)).toHaveTextContent(
      "You're a platform admin. To create a workspace here, sign out and sign in again with your authenticator; the form shows for 15 minutes after that. After you sign in again, Platform > Provision sets up a customer's workspace.",
    );
    // No link into the console: aal2_required also covers an AAL1 session, and
    // at AAL1 every /platform page answers 404 (requirePlatformAdmin).
    expect(screen.queryByRole('link', { name: 'Platform > Provision' })).toBeNull();
    expect(container.querySelector('a[href^="/platform"]')).toBeNull();
    expectNoCreateForm();
  });
});
