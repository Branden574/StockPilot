import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /signin with a spent emailed link whose session came back in the URL
 * fragment (docket B39 review). The app never uses that session
 * (lib/supabase/client.test.ts): the page says the link did not work, and
 * builds no browser Supabase client to take a session from the URL, which would
 * be a login CSRF path (docket S14). The root layout, not this page, takes the
 * live tokens out of the address bar, on every page; its test renders this page
 * in it (app/layout.session-fragment-scrub.test.tsx). Placeholder tokens only.
 */

const { createClient } = vi.hoisted(() => ({
  createClient: vi.fn(() => ({
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
  })),
}));

vi.mock('@/lib/supabase/client', () => ({ createClient }));
vi.mock('@/server/actions/auth', () => ({ signInAction: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import SignInPage from './page';

const SESSION =
  '#access_token=header.payload.signature&expires_in=3600&refresh_token=r1&token_type=bearer&type=recovery';

beforeEach(() => {
  vi.useFakeTimers();
  createClient.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

describe('the sign-in page and a session in the URL fragment', () => {
  it('says the link did not work, and builds no browser client to take the session', () => {
    window.history.replaceState(null, '', `/signin?error=auth_callback_failed${SESSION}`);
    const { container } = render(<SignInPage />);
    vi.runAllTimers();

    expect(container.querySelector('[data-slot="auth-notice"]')).toHaveTextContent(
      'That link has expired or was already used.',
    );
    expect(window.location.search).toBe('?error=auth_callback_failed');
    expect(createClient).not.toHaveBeenCalled();
  });
});
