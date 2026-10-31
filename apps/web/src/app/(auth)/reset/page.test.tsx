import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * /reset says why when app/auth/confirm sends an expired or used recovery link
 * here (?error=link_expired), in the auth card's notice, says nothing for a
 * post it refused from another site (?error=link_refused), and prints no other
 * value (lib/auth/auth-page-notices.ts decides each).
 */

vi.mock('@/server/actions/auth', () => ({ requestPasswordResetAction: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import ResetPage from './page';

const EXPIRED =
  "That reset link has expired or was already used. Enter your email below and we'll send a fresh one.";

async function renderAt(searchParams: { error?: string | string[] }) {
  return render(await ResetPage({ searchParams: Promise.resolve(searchParams) }));
}

function notice(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-slot="auth-notice"]');
}

describe('/reset', () => {
  it('says the reset link expired for ?error=link_expired, above the form', async () => {
    const { container } = await renderAt({ error: 'link_expired' });
    const shown = notice(container);
    expect(shown).toHaveTextContent(EXPIRED);
    expect(shown).toHaveAttribute('role', 'alert');
    expect(shown?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['bg-destructive-wash', 'text-destructive', 'rounded-md']),
    );
    expect(shown?.compareDocumentPosition(screen.getByLabelText('Email'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('shows the form and no notice on a plain visit', async () => {
    const { container } = await renderAt({});
    expect(notice(container)).toBeNull();
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeInTheDocument();
  });

  it('never prints a value it does not know', async () => {
    for (const error of ['Call this number to reset', 'auth_callback_failed', 'constructor']) {
      const { container, unmount } = await renderAt({ error });
      expect(notice(container), error).toBeNull();
      expect(container.textContent).not.toContain('Call this number');
      unmount();
    }
  });

  it('says nothing for ?error=link_refused: /auth/confirm refused a post from another site', async () => {
    const { container } = await renderAt({ error: 'link_refused' });
    expect(notice(container)).toBeNull();
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeInTheDocument();
  });

  it('reads the first of a repeated ?error=', async () => {
    const { container } = await renderAt({ error: ['link_expired', 'other'] });
    expect(notice(container)).toHaveTextContent(EXPIRED);
  });
});
