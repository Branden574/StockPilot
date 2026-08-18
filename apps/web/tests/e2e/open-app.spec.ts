import { expect, test, type Page } from '@playwright/test';

/**
 * "Open app" routing.
 *
 * The landing CTA points at `/dashboard`, not `/signin`. That single choice is
 * the whole feature:
 *   - signed in  → straight to the dashboard, with every mandatory gate
 *                  (disabled account, no org → onboarding, MFA policy, MFA
 *                  challenge) still enforced at the DESTINATION by
 *                  `(dashboard)/layout.tsx` + `requireOrgContext()`. Linking
 *                  past the sign-in form cannot skip them.
 *   - anonymous  → the proxy 307s to `/signin?redirect=/dashboard`, and the
 *                  sign-in form continues there afterwards.
 *
 * It is resolved server-side, so there is no "checking session…" flash, and `/`
 * stays outside the proxy matcher and statically rendered.
 *
 * These run WITHOUT the shared auth storageState — the landing is anonymous.
 * The signed-in half is covered separately below and skips cleanly when no test
 * credentials are configured, exactly like auth.setup.ts.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const APP_ENTRY = '/dashboard';

/** Get past the branded intro so the nav is clickable. */
async function landOnHome(page: Page) {
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem('stockpilot:intro-seen:v1', '1');
    } catch {
      /* private mode — the intro replays, which the waits below absorb */
    }
  });
  await page.goto('/');
  await expect(page.locator('#sp-nav .brand')).toBeVisible();
  await expect(page.locator('.li-root')).toHaveCount(0, { timeout: 6000 });
}

test.describe('open app — anonymous', () => {
  test('the landing CTA points at the app, not at the sign-in form', async ({ page }) => {
    await landOnHome(page);
    // If this ever regresses to /signin, an already-signed-in operator gets an
    // extra redirect hop through a login screen they do not need.
    await expect(page.locator('#sp-nav .nav-cta')).toHaveAttribute('href', APP_ENTRY);
  });

  test('clicking Open app sends an anonymous visitor into the sign-in flow', async ({ page }) => {
    await landOnHome(page);
    await page.locator('#sp-nav .nav-cta').click();
    await page.waitForURL(/\/signin/);
    // The intended destination must survive the bounce, or the user lands on the
    // dashboard root instead of where they were going.
    expect(new URL(page.url()).searchParams.get('redirect')).toBe(APP_ENTRY);
  });

  test('the proxy, not the button, is what decides — a direct hit behaves identically', async ({
    page,
  }) => {
    const res = await page.goto(APP_ENTRY);
    expect(res?.status()).toBeLessThan(400);
    await page.waitForURL(/\/signin/);
    expect(new URL(page.url()).searchParams.get('redirect')).toBe(APP_ENTRY);
  });

  test('Sign in and Open app are not the same link', async ({ page }) => {
    await landOnHome(page);
    const signin = await page.locator('#sp-nav .nav-signin').getAttribute('href');
    const openApp = await page.locator('#sp-nav .nav-cta').getAttribute('href');
    expect(signin).toBe('/signin');
    expect(openApp).toBe(APP_ENTRY);
    expect(signin).not.toBe(openApp);
  });
});

test.describe('open app — redirect safety', () => {
  /**
   * A manipulated `?redirect=` must never send a freshly-authenticated user off
   * this origin. `/\evil.com` is the important one: Chrome and `curl -L` resolve
   * it as protocol-relative, and it is documented in auth/callback/route.ts as a
   * previously exploited vector. The sign-in form used to accept it — it shared
   * none of the route handlers' hardening until the four copies of the sanitizer
   * were consolidated onto lib/auth/safe-redirect.ts.
   *
   * Exhaustive input coverage lives in safe-redirect.test.ts (30 cases). This
   * asserts the browser-level outcome: the page stays on this origin.
   */
  for (const hostile of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)']) {
    test(`stays on this origin when handed ${hostile}`, async ({ page, baseURL }) => {
      const expectedOrigin = new URL(baseURL as string).origin;
      await page.goto(`/signin?redirect=${encodeURIComponent(hostile)}`);
      await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();

      // The hostile value is still sitting in our OWN query string — that is
      // expected and harmless. What matters is that the browser is still here.
      const url = new URL(page.url());
      expect(url.origin).toBe(expectedOrigin);
      expect(url.pathname).toBe('/signin');

      // Give any client-side navigation a chance to fire, then confirm again.
      await page.waitForTimeout(600);
      expect(new URL(page.url()).origin).toBe(expectedOrigin);
    });
  }
});

/**
 * The signed-in half. Skipped without credentials, same contract as
 * auth.setup.ts, so the file stays green on a machine with no test account and
 * still proves the real behaviour on one that has.
 */
test.describe('open app — signed in', () => {
  const email = process.env.TEST_USER_EMAIL;
  const password = process.env.TEST_USER_PASSWORD;

  test.skip(!email || !password, 'TEST_USER_EMAIL / TEST_USER_PASSWORD not set');

  test('signing in from Open app continues into the app, not back to the landing', async ({
    page,
  }) => {
    await landOnHome(page);
    await page.locator('#sp-nav .nav-cta').click();
    await page.waitForURL(/\/signin/);

    await page.getByLabel(/email/i).fill(email as string);
    await page.getByLabel(/password/i).fill(password as string);
    await page.getByRole('button', { name: /sign in/i }).click();

    // Either straight through, or into a MANDATORY gate. Both are correct; what
    // must never happen is landing back on the marketing page.
    await page.waitForURL(
      /\/dashboard|\/signin\/mfa|\/onboarding|\/account-disabled/,
      { timeout: 20_000 },
    );
    expect(new URL(page.url()).pathname).not.toBe('/');
  });

  test('an already-signed-in visitor is not shown the sign-in form', async ({ page }) => {
    await page.goto('/signin');
    // The proxy bounces a signed-in user off every auth route.
    await page.waitForURL(/\/dashboard|\/signin\/mfa|\/onboarding/, { timeout: 20_000 });
  });
});
