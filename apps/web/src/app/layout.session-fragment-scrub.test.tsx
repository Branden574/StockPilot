import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The root layout takes a session out of the URL fragment on EVERY page
 * (docket B39, integrator decision of 2026-10-25).
 *
 * A link Supabase verifies itself (its action_link: an older email, or one sent
 * from the Supabase dashboard) comes back with a session in the fragment of its
 * redirect, and every redirect after that keeps the fragment. Where it lands
 * depends on who minted the link:
 *   - a password reset (lib/auth/password-reset-email.ts,
 *     app/api/admin/qa-recovery-link): /auth/callback?next=/reset/complete,
 *     which has no code to exchange and sends /signin?error=auth_callback_failed
 *     (app/auth/callback/route.ts); a signed-in browser's /signin goes on to
 *     /dashboard (lib/supabase/middleware.ts);
 *   - the platform console's owner invite (server/actions/platform-admin.ts):
 *     /dashboard, which a signed-out browser leaves for
 *     /signin?redirect=%2Fdashboard;
 *   - a link minted with no redirect (the portal invite and magic link,
 *     server/services/customers.ts; the email change pair,
 *     server/services/email-change.ts) and one sent from the Supabase
 *     dashboard: the project's Site URL, the landing page.
 * Mounted on /signin alone, the scrub left the live tokens on /dashboard and /.
 *
 * A fragment without a session is never touched: the label print view
 * (components/inventory/barcode-display.tsx) reads its own parameters from its
 * fragment, and the pages' anchors are fragments too. The layout's other parts
 * are stood in for. Placeholder tokens only.
 */

const { createClient } = vi.hoisted(() => ({
  createClient: vi.fn(() => ({
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
  })),
}));

vi.mock('next/font/google', () => {
  const font = () => ({ variable: 'font-var', className: 'font' });
  return { Inter: font, Inter_Tight: font, Instrument_Serif: font, JetBrains_Mono: font };
});
vi.mock('./globals.css', () => ({}));
vi.mock('@/components/analytics/posthog-provider', () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/theme/theme-provider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/perf/web-vitals-reporter', () => ({ WebVitalsReporter: () => null }));
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));
// The sign-in page's own parts, stood in for as its page test does.
vi.mock('@/lib/supabase/client', () => ({ createClient }));
vi.mock('@/server/actions/auth', () => ({ signInAction: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { BarcodeDisplay } from '@/components/inventory/barcode-display';
import { LINK_FAILED_NOTICE, SPENT_SESSION_FRAGMENT } from '@/lib/auth/auth-page-notices';

import SignInPage from './(auth)/signin/page';
import RootLayout from './layout';

/** GoTrue's redirect for a link it accepted (AsRedirectURL), its keys in GoTrue's order. */
function session(type: string): string {
  return `#access_token=header.payload.signature&expires_at=1700000000&expires_in=3600&refresh_token=r1&sb=&token_type=bearer&type=${type}`;
}

/** Puts the browser on this page, query and fragment. */
function go(address: string) {
  window.history.replaceState(null, '', address);
}

function renderLayout(page: React.ReactNode) {
  return render(<RootLayout>{page}</RootLayout>);
}

/**
 * Lets the scrub's turn come: it waits one tick, for the router's history patch
 * (components/auth/session-fragment-scrub.tsx).
 */
async function tick() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

/**
 * The note on the sign-in card. React renders the layout's <html> and <body>
 * into the document's own, outside the test's container.
 */
function signInNote(): Element | null {
  return document.querySelector('[data-slot="auth-notice"]');
}

const NOT_A_TOKEN = /access_token|refresh_token|header\.payload\.signature/;

beforeEach(() => {
  // The layout owns <html> and <body>; rendered inside the test's container,
  // React warns about the nesting. That is the test's arrangement.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  createClient.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  go('/');
});

describe('root layout: a session in the URL fragment', () => {
  it.each([
    {
      link: 'a password reset link, signed out',
      at: '/signin?error=auth_callback_failed',
      type: 'recovery',
    },
    {
      link: 'a password reset link, signed in (the proxy sends /signin on)',
      at: '/dashboard',
      type: 'recovery',
    },
    { link: "the platform console's owner invite, signed in", at: '/dashboard', type: 'invite' },
    {
      link: "the platform console's owner invite, signed out",
      at: '/signin?redirect=%2Fdashboard',
      type: 'invite',
    },
    { link: 'a portal invite (no redirect: the Site URL)', at: '/', type: 'invite' },
    { link: 'a portal magic link (no redirect: the Site URL)', at: '/', type: 'magiclink' },
    { link: 'an email change (no redirect: the Site URL)', at: '/', type: 'email_change' },
  ])('$link lands on $at, and the session leaves the address bar', async ({ at, type }) => {
    go(`${at}${session(type)}`);
    renderLayout(<p>the page</p>);
    await tick();

    const page = new URL(at, window.location.origin);
    expect(window.location.pathname).toBe(page.pathname);
    expect(window.location.search).toBe(page.search);
    expect(window.location.hash).toBe(SPENT_SESSION_FRAGMENT);
    expect(window.location.href).not.toMatch(NOT_A_TOKEN);
  });

  it.each([
    { link: 'a password reset link', at: '/signin?error=auth_callback_failed', type: 'recovery' },
    // No error in the query: only the fragment says the link was spent.
    { link: "the console's owner invite", at: '/signin?redirect=%2Fdashboard', type: 'invite' },
  ])(
    '/signin still says $link did not work, before and after the scrub, and on the next load',
    async ({ at, type }) => {
      go(`${at}${session(type)}`);
      const first = renderLayout(<SignInPage />);
      expect(signInNote()).toHaveTextContent(LINK_FAILED_NOTICE.text);

      await tick();
      expect(window.location.hash).toBe(SPENT_SESSION_FRAGMENT);
      expect(window.location.href).not.toMatch(NOT_A_TOKEN);
      expect(signInNote()).toHaveTextContent(LINK_FAILED_NOTICE.text);
      first.unmount();

      // A reload: the spent fragment in its place still reads as a failed link.
      renderLayout(<SignInPage />);
      expect(signInNote()).toHaveTextContent(LINK_FAILED_NOTICE.text);
      // And nothing on the page built a browser client to take a session from
      // the URL (login CSRF, docket S14).
      expect(createClient).not.toHaveBeenCalled();
    },
  );
});

/**
 * The address the label print window opens, as BarcodeDisplay builds it when
 * Print is pressed (its own fetch and blob URLs stood in for).
 */
async function printWindowAddress(itemName: string, sku: string): Promise<string> {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    ),
  );
  let made = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(
    () => `blob:${window.location.origin}/label-${++made}`,
  );
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);

  const view = render(
    <BarcodeDisplay itemId="item-1" itemName={itemName} sku={sku} barcode={sku} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Label' }));
  const print = await screen.findByRole('button', { name: 'Print' });
  await waitFor(() => expect(print).toBeEnabled());
  fireEvent.click(print);
  view.unmount();

  expect(open).toHaveBeenCalledTimes(1);
  return String(open.mock.calls[0]![0]);
}

describe('root layout: a fragment without a session', () => {
  it.each([
    { label: 'an ordinary label', itemName: 'Wireless Mouse', sku: 'WM-1' },
    // Only a fragment's keys can hold a session; its values are the item's.
    {
      label: 'a label whose name and SKU read like a session',
      itemName: 'access_token=a&refresh_token=b',
      sku: 'refresh_token',
    },
  ])("leaves the label print view's own fragment alone: $label", async ({ itemName, sku }) => {
    const address = await printWindowAddress(itemName, sku);
    const fragment = address.slice(address.indexOf('#'));
    // The print view's own parameters, as its script reads them.
    const read = () => Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)));
    expect([...new URLSearchParams(fragment.slice(1)).keys()]).toEqual(['src', 't', 's']);

    go(`/dashboard/items/item-1${fragment}`);
    const before = window.location.href;
    const replace = vi.spyOn(window.history, 'replaceState');
    renderLayout(<p>the page</p>);
    await tick();

    expect(replace).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
    expect(read()).toEqual({ src: expect.stringMatching(/^blob:/), t: itemName, s: sku });
  });

  it.each([
    { what: 'no fragment', at: '/dashboard', fragment: '' },
    { what: "the dashboard's skip link", at: '/dashboard', fragment: '#main-content' },
    { what: "the landing page's anchors", at: '/', fragment: '#how-it-works' },
    {
      what: "GoTrue's answer to a link it refused",
      at: '/signin?error=auth_callback_failed',
      fragment:
        '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=',
    },
    {
      what: "GoTrue's answer to the first of an email change's two links",
      at: '/',
      fragment:
        '#message=Confirmation+link+accepted.+Please+proceed+to+confirm+link+sent+to+the+other+email&sb=',
    },
    { what: 'the spent link the scrub leaves', at: '/signin', fragment: SPENT_SESSION_FRAGMENT },
  ])('leaves $what alone', async ({ at, fragment }) => {
    go(`${at}${fragment}`);
    const before = window.location.href;
    const replace = vi.spyOn(window.history, 'replaceState');
    renderLayout(<p>the page</p>);
    await tick();

    expect(replace).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
  });
});
