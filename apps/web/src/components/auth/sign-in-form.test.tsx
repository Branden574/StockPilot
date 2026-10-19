import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * /signin after the redesign (P5.1). The E2E sign-in (tests/e2e/auth.setup.ts)
 * finds the fields by the labels "Email" and exactly "Password" and the button
 * "Sign in"; the error slots are always in the DOM so nothing moves when a
 * field turns invalid; Remember me is a real session control, on by default.
 */

vi.mock('@/server/actions/auth', () => ({ signInAction: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams('reason=session_ended'),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { SignInForm } from './sign-in-form';

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
    render(<SignInForm />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'You were signed out on this device. Sign in again to continue.',
    );
  });
});
