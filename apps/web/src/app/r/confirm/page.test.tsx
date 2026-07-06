import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * Regression guard for the scanner-prefetch fix: the /r/confirm GET
 * render must NEVER touch the database (the old page consumed the
 * single-use confirmation token during render, so an email security
 * scanner's prefetch "confirmed" requests with no human click). Any
 * call into the admin client from this page is that bug coming back —
 * the mock below makes it throw so the regression can't render at all.
 */
const createAdminClientMock = vi.fn(() => {
  throw new Error('GET /r/confirm must never touch the database');
});
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => createAdminClientMock(),
}));

// next/link needs an app-router context under happy-dom; a bare anchor
// is all these panels use it for.
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});

import ConfirmOrderRequestPage from './page';

const ID = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'a'.repeat(64);

async function renderPage(params: Record<string, string | string[] | undefined>) {
  return render(await ConfirmOrderRequestPage({ searchParams: Promise.resolve(params) }));
}

describe('GET /r/confirm (page render)', () => {
  it('renders a click-through form carrying the token — and never touches the DB', async () => {
    const { container, getByText } = await renderPage({ id: ID, t: TOKEN });

    expect(createAdminClientMock).not.toHaveBeenCalled();

    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    // Consumption happens only on the POST route, via a native form —
    // scanners follow GET/HEAD but don't submit forms.
    expect(form!.getAttribute('method')).toBe('post');
    expect(form!.getAttribute('action')).toBe('/r/confirm/submit');
    expect(
      (container.querySelector('input[name="id"]') as HTMLInputElement).value,
    ).toBe(ID);
    expect(
      (container.querySelector('input[name="t"]') as HTMLInputElement).value,
    ).toBe(TOKEN);
    expect(getByText('Confirm order request')).toBeTruthy();
  });

  it('renders the generic invalid panel for malformed params without any DB call', async () => {
    const { getByText } = await renderPage({ id: 'not-a-uuid', t: 'short' });

    expect(createAdminClientMock).not.toHaveBeenCalled();
    expect(getByText(/invalid, expired, or already used/)).toBeTruthy();
  });

  it('renders the success panel for ?done= without any DB call', async () => {
    const { getByText } = await renderPage({ done: ID });

    expect(createAdminClientMock).not.toHaveBeenCalled();
    expect(getByText('Request confirmed')).toBeTruthy();
    expect(getByText(ID)).toBeTruthy();
  });

  it('renders the invalid panel for ?e=1 (covers the already-used re-POST) without any DB call', async () => {
    const { getByText } = await renderPage({ e: '1' });

    expect(createAdminClientMock).not.toHaveBeenCalled();
    expect(getByText(/invalid, expired, or already used/)).toBeTruthy();
  });
});
