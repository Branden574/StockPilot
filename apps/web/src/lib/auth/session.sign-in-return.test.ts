import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A request with no session goes to sign-in WITH the page to come back to.
 *
 * requireSession() and requireOrgContext() are the gates every withContext()
 * and service forCurrentUser() goes through, in a page render and in a Server
 * Action alike. They sent a missing session to a bare /signin, so after
 * signing in the person landed on /dashboard instead of the page they were
 * on. The proxy's own redirect for a signed-out request carries
 * `?redirect=<path and query>` (lib/supabase/middleware.ts); these now carry
 * the same, from the path the proxy forwards in RETURN_PATH_HEADER.
 */

const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));

/** What the request carries: no identity header means no session. */
let requestHeaders: Record<string, string> = {};
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers(requestHeaders)),
  cookies: vi.fn(async () => ({ get: () => undefined, set: () => {}, delete: () => {} })),
}));

// Never reached without an identity header; mocked so nothing real loads.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    throw new Error('no client is created for a request with no session');
  },
}));

const RETURN_PATH = 'x-stockpilot-return-path';

async function fresh() {
  vi.resetModules();
  return import('./session');
}

beforeEach(() => {
  requestHeaders = {};
  redirect.mockClear();
});

describe('a request with no session goes to sign-in with its return path', () => {
  it('requireOrgContext: /signin?redirect=<the page and its query>', async () => {
    requestHeaders = { [RETURN_PATH]: '/dashboard/items?tab=books' };
    const { requireOrgContext } = await fresh();

    await expect(requireOrgContext()).rejects.toThrow(
      'REDIRECT:/signin?redirect=%2Fdashboard%2Fitems%3Ftab%3Dbooks',
    );
    // The sign-in form reads it back as the page itself.
    const target = new URL(String(redirect.mock.calls[0]?.[0]), 'https://app.example.com');
    expect(target.searchParams.get('redirect')).toBe('/dashboard/items?tab=books');
  });

  it('requireSession: the same', async () => {
    requestHeaders = { [RETURN_PATH]: '/onboarding' };
    const { requireSession } = await fresh();

    await expect(requireSession()).rejects.toThrow('REDIRECT:/signin?redirect=%2Fonboarding');
  });

  it('a request without a return path still goes to /signin', async () => {
    const { requireOrgContext } = await fresh();

    await expect(requireOrgContext()).rejects.toThrow(/^REDIRECT:\/signin$/);
  });

  it('a return path that leaves the site is dropped, never followed', async () => {
    // Outside the proxy's matcher the header is whatever the client sent.
    for (const forged of [
      '//evil.example/x',
      '/\\evil.example',
      'https://evil.example/',
      '/\t/evil.example',
    ]) {
      requestHeaders = { [RETURN_PATH]: forged };
      const { requireOrgContext } = await fresh();
      await expect(requireOrgContext(), forged).rejects.toThrow(/^REDIRECT:\/signin$/);
    }
  });

  it('a return path that is itself a sign-in page is dropped, so redirects never nest', async () => {
    for (const path of ['/signin?redirect=%2Fdashboard', '/signin/mfa', '/reset/complete']) {
      requestHeaders = { [RETURN_PATH]: path };
      const { requireSession } = await fresh();
      await expect(requireSession(), path).rejects.toThrow(/^REDIRECT:\/signin$/);
    }
  });
});
