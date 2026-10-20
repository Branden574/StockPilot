import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /invite/[token] on the shared external frame and the auth card (P5.1).
 * Every state keeps its words and its one way forward; nothing mutates on GET.
 */

type Invite = {
  id: string;
  organization_id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
} | null;

let invite: Invite = null;
let session: { email: string } | null = null;

vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_APP_URL: 'https://app.example.test' } }));
vi.mock('@/lib/auth/session', () => ({ getServerSession: async () => session }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === 'organization_invites'
              ? { data: invite }
              : { data: { name: 'Lab Charter School' } },
        }),
      }),
    }),
  }),
}));
vi.mock('@/components/theme/theme-toggle', () => ({
  ThemeToggle: () => <button type="button">Theme</button>,
}));
vi.mock('./signup-form', () => ({
  InviteSignupForm: ({ email }: { email: string }) => (
    <form aria-label="Create account">{email}</form>
  ),
}));
vi.mock('./accept-button', () => ({
  AcceptInviteButton: () => <button type="button">Accept invite</button>,
}));

import InvitePage from './page';

const LINK_ID = 'tok_1111111111111111';
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

function makeInvite(extra: Partial<NonNullable<Invite>> = {}): Invite {
  return {
    id: 'inv-1',
    organization_id: 'org-1',
    email: 'new.person@example.test',
    role: 'staff',
    expires_at: FUTURE,
    accepted_at: null,
    ...extra,
  };
}

async function open() {
  return render(await InvitePage({ params: Promise.resolve({ token: LINK_ID }) }));
}

beforeEach(() => {
  invite = null;
  session = null;
});

describe('/invite/[token]', () => {
  it('not found: its title and line, and no form', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1, name: 'Invite not found' })).toBeInTheDocument();
    expect(screen.getByText('This link is invalid or no longer active.')).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('already accepted: Go to sign in', async () => {
    invite = makeInvite({ accepted_at: PAST });
    await open();
    expect(screen.getByRole('heading', { level: 1, name: 'Already accepted' })).toBeInTheDocument();
    expect(
      screen.getByText('This invite was used. Sign in to access Lab Charter School.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/signin');
  });

  it('expired: Go to sign in', async () => {
    invite = makeInvite({ expires_at: PAST });
    await open();
    expect(screen.getByRole('heading', { level: 1, name: 'Invite expired' })).toBeInTheDocument();
    expect(
      screen.getByText('Ask someone at Lab Charter School to invite you again.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toBeInTheDocument();
  });

  it('valid, signed out: the signup form and the Sign in link that comes back here', async () => {
    invite = makeInvite();
    await open();
    expect(
      screen.getByRole('heading', { level: 1, name: "You're invited to Lab Charter School" }),
    ).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Create account' })).toHaveTextContent(
      'new.person@example.test',
    );
    expect(screen.getByText(/Already have an account\?/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      `/signin?redirect=/invite/${LINK_ID}`,
    );
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toContain('/');
    expect(screen.getByRole('button', { name: 'Theme' })).toBeInTheDocument();
  });

  it('valid, signed in as someone else: says so, with no accept control', async () => {
    invite = makeInvite();
    session = { email: 'other@example.test' };
    await open();
    expect(screen.getByText(/You're signed in as/)).toHaveTextContent(
      "You're signed in as other@example.test, but this invite is for new.person@example.test. Sign out and sign in with the right email to accept.",
    );
    expect(screen.queryByRole('button', { name: 'Accept invite' })).toBeNull();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('valid, signed in as the invitee: Accept invite', async () => {
    invite = makeInvite();
    session = { email: 'New.Person@example.test' };
    await open();
    expect(screen.getByRole('button', { name: 'Accept invite' })).toBeInTheDocument();
    expect(screen.queryByText(/Already have an account\?/)).toBeNull();
  });
});
