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
let session: { email: string; userId?: string } | null = null;
/** The signed-in person's membership of the invite's organization, or a failed read. */
let membership: { accepted_at: string | null } | null | 'read-fails' = null;

vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_APP_URL: 'https://app.example.test' } }));
vi.mock('@/lib/auth/session', () => ({ getServerSession: async () => session }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        maybeSingle: async () => {
          if (table === 'organization_invites') return { data: invite, error: null };
          if (table === 'organization_members') {
            if (membership === 'read-fails') return { data: null, error: { message: 'down' } };
            // Answered only for this organization and this person.
            const asked =
              filters.organization_id === invite?.organization_id &&
              filters.user_id === session?.userId;
            return { data: asked ? membership : null, error: null };
          }
          return { data: { name: 'Lab Charter School' }, error: null };
        },
      };
      return chain;
    },
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

import { INVITE_ACCOUNT_EXISTS_COPY } from './invite-copy';
import InvitePage from './page';

// The invite link's path segment: a dull value under a neutral name, since
// secret scanners fire on a token-shaped name holding a random-looking string.
// The page only passes it through (the lookup and the Sign in link).
const INVITE_REF = 'tok_' + 'a'.repeat(16);
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
  return render(await InvitePage({ params: Promise.resolve({ token: INVITE_REF }) }));
}

beforeEach(() => {
  invite = null;
  session = null;
  membership = null;
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
      `/signin?redirect=/invite/${INVITE_REF}`,
    );
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toContain('/');
    expect(screen.getByRole('button', { name: 'Theme' })).toBeInTheDocument();
  });

  it('names its footer exactly as the account-exists answer does (B77)', async () => {
    invite = makeInvite();
    await open();
    // The sign-up refusal for an address that already has an account tells the
    // invitee which link to use; it must be the words this footer shows.
    const footer = screen.getByText(/Already have an account\?/);
    expect(footer).toHaveTextContent(/^Already have an account\? Sign in$/);
    expect(INVITE_ACCOUNT_EXISTS_COPY).toContain(`"${footer.textContent}"`);
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
  it('valid, signed in as the invitee who is already a member: says so, with no accept control', async () => {
    invite = makeInvite();
    session = { email: 'new.person@example.test', userId: 'user-1' };
    membership = { accepted_at: PAST };
    await open();
    expect(
      screen.getByRole('heading', { level: 1, name: "You're already a member" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "You're already a member of Lab Charter School. This invite does not change your access.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    expect(screen.queryByRole('button', { name: 'Accept invite' })).toBeNull();
  });

  it('valid, signed in as the invitee whose membership is not accepted yet: Accept invite', async () => {
    invite = makeInvite();
    session = { email: 'new.person@example.test', userId: 'user-1' };
    membership = { accepted_at: null };
    await open();
    expect(screen.getByRole('button', { name: 'Accept invite' })).toBeInTheDocument();
  });

  it('valid, signed in as the invitee, membership read fails: Accept invite (the acceptance checks again)', async () => {
    invite = makeInvite();
    session = { email: 'new.person@example.test', userId: 'user-1' };
    membership = 'read-fails';
    await open();
    expect(
      screen.getByRole('heading', { level: 1, name: "You're invited to Lab Charter School" }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept invite' })).toBeInTheDocument();
  });
});
