import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * /signin after the redesign (P5.1). The E2E sign-in (tests/e2e/auth.setup.ts)
 * finds the fields by the labels "Email" and exactly "Password" and the button
 * "Sign in"; the error slots are always in the DOM so nothing moves when a
 * field turns invalid; Remember me is a real session control, on by default.
 *
 * The notice above the fields (docket B39) says why the person is here when an
 * auth route sent them: lib/auth/auth-page-notices.ts holds every value and its
 * words. The search params come from the jsdom URL that each test sets, the
 * same URL whose fragment the form reads.
 */

vi.mock('@/server/actions/auth', () => ({ signInAction: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { SPENT_SESSION_FRAGMENT } from '@/lib/auth/auth-page-notices';

import { SignInForm } from './sign-in-form';

const LINK_FAILED =
  'That link has expired or was already used. Sign in with your password, or choose Forgot? below to get a new link by email.';

/** Puts the browser on /signin with this query and fragment. */
function at(query: string, fragment = '') {
  window.history.replaceState(null, '', `/signin${query ? `?${query}` : ''}${fragment}`);
}

function notice(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-slot="auth-notice"]');
}

afterEach(() => at(''));

describe('SignInForm', () => {
  it('keeps the E2E names: "Email", exactly "Password", and the "Sign in" button', () => {
    render(<SignInForm />);
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('Password', { exact: true })).toHaveAttribute(
      'autocomplete',
      'current-password',
    );
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveAttribute('type', 'submit');
    expect(screen.getByRole('link', { name: 'Forgot?' })).toHaveAttribute('href', '/reset');
  });

  it('gives Forgot? a 44 px hit area on phones and touch screens without moving anything, and never over the password field', () => {
    render(<SignInForm />);
    const forgot = screen.getByRole('link', { name: 'Forgot?' });
    const classes = forgot.className.split(/\s+/);
    // An invisible ::before only: the link keeps its place, word and target.
    expect(classes).toEqual(
      expect.arrayContaining([
        'relative',
        'text-xs',
        'before:absolute',
        'before:-inset-x-2',
        'before:-top-5',
        'before:-bottom-2',
        'before:content-none',
        "max-sm:before:content-['']",
        "pointer-coarse:before:content-['']",
      ]),
    );
    // 16 px line (text-xs) + 20 px above (-top-5) + 8 px below (-bottom-2) = 44.
    // Below ends on the 8 px gap (space-y-2) to the password field, so the
    // field's own top edge stays the field's.
    expect(forgot.closest('.auth-field')?.className.split(/\s+/)).toContain('space-y-2');
    expect(forgot).toHaveAttribute('href', '/reset');
    expect(classes).toEqual(
      expect.arrayContaining(['focus-visible:ring-2', 'focus-visible:ring-ring']),
    );
  });

  it('always renders both error slots, empty until a field is invalid', () => {
    at('reason=session_ended');
    const { container } = render(<SignInForm />);
    const slots = container.querySelectorAll('.auth-msg[role="alert"]');
    expect(slots).toHaveLength(2);
    for (const slot of slots) expect(slot.textContent).toBe('');
  });

  it('keeps Remember me on this device, checked by default', () => {
    render(<SignInForm />);
    expect(screen.getByRole('checkbox', { name: 'Remember me on this device' })).toBeChecked();
  });

  it('shows the session-ended notice as a status', () => {
    at('reason=session_ended');
    render(<SignInForm />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'You were signed out on this device. Sign in again to continue.',
    );
  });

  it('shows no notice on a plain visit', () => {
    const { container } = render(<SignInForm />);
    expect(notice(container)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('SignInForm: an emailed link that did not work (docket B39)', () => {
  it('says so, and what to do, when /auth/confirm or /auth/callback sends ?error=auth_callback_failed', () => {
    at('error=auth_callback_failed');
    const { container } = render(<SignInForm />);
    const shown = notice(container);
    expect(shown).not.toBeNull();
    expect(shown).toHaveTextContent(LINK_FAILED);
    // Announced: it explains why the person is back on this page.
    expect(shown).toHaveAttribute('role', 'alert');
    // The redesign's alert recipe on the auth card, in the danger wash the
    // /reset page uses for its own expired link.
    expect(shown?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['bg-destructive-wash', 'text-destructive', 'rounded-md']),
    );
    // It sits above the fields, where the eye enters the card.
    expect(shown?.compareDocumentPosition(screen.getByLabelText('Email'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // The form stays usable: signing in with the password is the way on.
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it("says so when GoTrue's own error comes back in the fragment, and never prints its description", () => {
    // A link Supabase verified itself (its action_link) and refused: GoTrue
    // sends the browser to the link's redirect with the error in the fragment,
    // and a redirect keeps the fragment on its way to /signin.
    at(
      'redirect=%2Fdashboard',
      '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
    );
    const { container } = render(<SignInForm />);
    expect(notice(container)).toHaveTextContent(LINK_FAILED);
    expect(container.textContent).not.toContain('invalid or has expired');
    expect(container.textContent).not.toContain('otp_expired');
  });

  it('says so when the link put its session in the fragment: the app never uses it, so the link is spent', () => {
    // A link Supabase verified itself (an older reset email) reaches
    // /auth/callback with its session in the fragment, which no server sees,
    // and lands here with ?error=auth_callback_failed. The browser client is
    // PKCE-only and refuses that session (lib/supabase/client.test.ts), so the
    // person is not signed in and the link cannot be used again.
    at(
      'error=auth_callback_failed',
      '#access_token=header.payload.signature&expires_in=3600&refresh_token=r1&token_type=bearer&type=recovery',
    );
    const { container } = render(<SignInForm />);
    expect(notice(container)).toHaveTextContent(LINK_FAILED);
    expect(container.textContent).not.toContain('header.payload.signature');
  });

  it('says so for a session fragment that reached a protected page first, with no error in the query', () => {
    // An invite link whose redirect is /dashboard: the proxy sends a signed-out
    // browser to /signin?redirect=%2Fdashboard, and the fragment comes along.
    at('redirect=%2Fdashboard', '#access_token=header.payload.signature&type=invite');
    const { container } = render(<SignInForm />);
    expect(notice(container)).toHaveTextContent(LINK_FAILED);
  });

  it('keeps the note once the session is gone from the address bar', () => {
    // SessionFragmentScrub leaves the spent-link fragment in its place.
    at('error=auth_callback_failed', SPENT_SESSION_FRAGMENT);
    const { container } = render(<SignInForm />);
    expect(notice(container)).toHaveTextContent(LINK_FAILED);
  });

  it('shows the link notice alone when the route also says the session ended', () => {
    at('error=auth_callback_failed&reason=session_ended');
    const { container } = render(<SignInForm />);
    expect(container.querySelectorAll('[data-slot="auth-notice"]')).toHaveLength(1);
    expect(notice(container)).toHaveTextContent(LINK_FAILED);
  });

  it('never prints a value it does not know, in the query or the fragment', () => {
    at(
      'error=Your+account+is+locked.+Call+us&reason=%3Cb%3Ecall%3C%2Fb%3E',
      '#message=Visit+a+lookalike+site',
    );
    const { container } = render(<SignInForm />);
    expect(notice(container)).toBeNull();
    expect(container.textContent).not.toContain('Call us');
    expect(container.textContent).not.toContain('<b>');
    expect(container.textContent).not.toContain('lookalike');
  });

  it('says nothing for ?reset=success, on purpose: the reset form already said "Password updated."', () => {
    at('reset=success');
    const { container } = render(<SignInForm />);
    expect(notice(container)).toBeNull();
  });

  it('says nothing when /auth/confirm refused a post from another site (?error=link_refused)', () => {
    // The link was neither expired nor used, and any words here would be words
    // another site chose to put on the sign-in card.
    at('error=link_refused');
    const { container } = render(<SignInForm />);
    expect(notice(container)).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });
});
